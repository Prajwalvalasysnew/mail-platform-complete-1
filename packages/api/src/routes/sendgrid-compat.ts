// SendGrid v3 compatibility shim — the migration on-ramp for teams coming
// off SendGrid (ADN's four dedicated IPs, UIC, WFAA, Tupperware, …).
//
// Contract: change the base URL and swap the SG. key for a platform key —
// existing SendGrid client code keeps working. The shim translates the v3
// payload into the native /v1/send shape and re-dispatches through the real
// route (auth, quotas, suppression, scanning, idempotency, and rate limits
// all apply exactly as if the caller had used /v1/send directly).
//
// Response mirrors SendGrid: 202 with an empty body and an X-Message-Id
// header on success; { "errors": [{ "message", "field" }] } on failure.
//
// Deliberately unsupported (400 with a clear message): SendGrid dynamic
// template ids (d-…) — templates must be migrated first (POST /v1/templates)
// and referenced by their platform UUID; sections/substitutions beyond
// dynamic_template_data; ASM group ids (use unsubscribe_group_id).

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const EmailObj = z.object({ email: z.string().email(), name: z.string().max(200).optional() });

const SgPayload = z.object({
  personalizations: z
    .array(
      z.object({
        to: z.array(EmailObj).min(1).max(1000),
        cc: z.array(EmailObj).optional(),
        bcc: z.array(EmailObj).optional(),
        subject: z.string().max(998).optional(),
        headers: z.record(z.string()).optional(),
        dynamic_template_data: z.record(z.unknown()).optional(),
        substitutions: z.record(z.unknown()).optional(),
        send_at: z.number().int().optional(),
      })
    )
    .min(1)
    .max(100),
  from: EmailObj,
  reply_to: EmailObj.optional(),
  subject: z.string().max(998).optional(),
  content: z
    .array(z.object({ type: z.string(), value: z.string() }))
    .optional(),
  attachments: z
    .array(
      z.object({
        content: z.string(),
        filename: z.string(),
        type: z.string().optional(),
        disposition: z.string().optional(),
        content_id: z.string().optional(),
      })
    )
    .max(10)
    .optional(),
  template_id: z.string().optional(),
  categories: z.array(z.string().max(50)).max(10).optional(),
  custom_args: z.record(z.unknown()).optional(),
  headers: z.record(z.string()).optional(),
  send_at: z.number().int().optional(),
  tracking_settings: z
    .object({
      click_tracking: z.object({ enable: z.boolean().optional() }).partial().optional(),
      open_tracking: z.object({ enable: z.boolean().optional() }).partial().optional(),
    })
    .partial()
    .optional(),
  asm: z.unknown().optional(),
  mail_settings: z.unknown().optional(),
});

function sgError(reply: any, status: number, message: string, field: string | null = null) {
  return reply.code(status).send({ errors: [{ message, field, help: null }] });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const sendgridCompatRoutes: FastifyPluginAsync = async (app) => {
  app.post('/v3/mail/send', async (req, reply) => {
    const parsed = SgPayload.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return sgError(reply, 400, issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid payload', issue?.path.join('.') ?? null);
    }
    const sg = parsed.data;

    if (sg.template_id && !UUID_RE.test(sg.template_id)) {
      return sgError(
        reply,
        400,
        'SendGrid dynamic template ids are not portable. Migrate the template (POST /v1/templates) and pass its platform UUID as template_id.',
        'template_id'
      );
    }
    if (sg.asm) {
      return sgError(reply, 400, 'asm group ids are not supported; use a platform unsubscribe group (unsubscribe_group_id).', 'asm');
    }

    const html = sg.content?.find((c) => c.type.toLowerCase() === 'text/html')?.value;
    const text = sg.content?.find((c) => c.type.toLowerCase() === 'text/plain')?.value;

    const allMessageIds: string[] = [];
    // Each personalization becomes one native send (its recipients share
    // subject/variables, matching SendGrid semantics).
    for (const [i, p] of sg.personalizations.entries()) {
      if (p.cc?.length || p.bcc?.length) {
        return sgError(reply, 400, 'cc/bcc are not supported by the compatibility shim; send to each recipient directly.', `personalizations.${i}`);
      }
      const sendAtUnix = p.send_at ?? sg.send_at;
      const nativeBody: Record<string, unknown> = {
        from: sg.from.email,
        ...(sg.from.name ? { from_name: sg.from.name } : {}),
        to: p.to.map((t) => t.email),
        ...(sg.reply_to ? { reply_to: sg.reply_to.email } : {}),
        subject: p.subject ?? sg.subject,
        ...(html ? { html } : {}),
        ...(text ? { text } : {}),
        ...(sg.template_id ? { template_id: sg.template_id } : {}),
        ...(p.dynamic_template_data || p.substitutions
          ? { variables: { ...(p.substitutions ?? {}), ...(p.dynamic_template_data ?? {}) } }
          : {}),
        ...(sg.categories ? { tags: sg.categories } : {}),
        ...(sg.custom_args ? { metadata: sg.custom_args } : {}),
        ...(sg.headers || p.headers ? { headers: { ...(sg.headers ?? {}), ...(p.headers ?? {}) } } : {}),
        ...(sendAtUnix ? { send_at: new Date(sendAtUnix * 1000).toISOString() } : {}),
        ...(sg.attachments
          ? {
              attachments: sg.attachments.map((a) => ({
                filename: a.filename,
                content: a.content,
                ...(a.type ? { content_type: a.type } : {}),
              })),
            }
          : {}),
        tracking: {
          opens: sg.tracking_settings?.open_tracking?.enable ?? true,
          clicks: sg.tracking_settings?.click_tracking?.enable ?? true,
        },
      };

      // Re-dispatch through the real /v1/send route so every control
      // (auth, quota, suppression, scanning, rate limit, idempotency)
      // applies identically. Same-process, no network hop.
      const res = await app.inject({
        method: 'POST',
        url: '/v1/send',
        headers: {
          authorization: req.headers.authorization ?? '',
          'content-type': 'application/json',
          ...(req.headers['idempotency-key'] && sg.personalizations.length === 1
            ? { 'idempotency-key': String(req.headers['idempotency-key']) }
            : {}),
        },
        payload: nativeBody,
      });

      if (res.statusCode >= 400) {
        let message = `upstream send failed with status ${res.statusCode}`;
        try {
          const body = res.json() as { error?: string; message?: string };
          message = body.message ?? body.error ?? message;
        } catch { /* non-JSON */ }
        return sgError(reply, res.statusCode, message, `personalizations.${i}`);
      }
      try {
        const body = res.json() as { message_ids?: string[] };
        allMessageIds.push(...(body.message_ids ?? []));
      } catch { /* tolerated */ }
    }

    // SendGrid returns 202 with an empty body and an X-Message-Id header.
    reply.header('X-Message-Id', allMessageIds[0] ?? '');
    return reply.code(202).send();
  });
};
