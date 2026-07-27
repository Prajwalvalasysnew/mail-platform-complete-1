import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  accessSecureMessage,
  createSecureMessage,
  revokeSecureMessage,
  SecureMessageError,
  validateAttachments,
  scanAttachmentsForMalware,
} from '@platform/shared';
import { requireScope } from '../plugins/scope.js';

const CreateSchema = z.object({
  to: z.string().email(),
  mode: z.enum(['hipaa', 'ferpa']),
  subject: z.string().min(1).max(998),
  html: z.string().max(1_048_576).optional(),
  text: z.string().max(1_048_576).optional(),
  attachments: z.array(z.object({
    filename: z.string().min(1).max(255),
    content_type: z.string().min(1).max(255),
    content_b64: z.string().max(14_000_000),
  })).max(20).optional(),
  expires_hours: z.number().int().min(1).max(24 * 30).default(72),
}).refine((value) => value.html || value.text, { message: 'html or text is required' });

export const secureMessageRoutes: FastifyPluginAsync = async (app) => {
  app.post('/secure-messages', {
    preHandler: requireScope('send'),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    if (parsed.data.attachments?.length) {
      const validated = validateAttachments(parsed.data.attachments.map((item) => ({
        filename: item.filename, content_type: item.content_type, content: item.content_b64,
      })));
      if (!validated.ok) return reply.code(422).send({ error: validated.error, message: validated.message });
      const scan = await scanAttachmentsForMalware(validated.attachments);
      if (!scan.ok) {
        const status = scan.error === 'attachment_malware_detected' ? 422 : 503;
        return reply.code(status).send({ error: scan.error, message: 'Secure-message attachment was not accepted.' });
      }
    }
    try {
      const created = await createSecureMessage({
        customerId: req.auth!.customer_id,
        apiKeyId: req.auth!.api_key_id,
        recipientEmail: parsed.data.to,
        mode: parsed.data.mode,
        payload: {
          subject: parsed.data.subject, html: parsed.data.html, text: parsed.data.text,
          attachments: parsed.data.attachments,
        },
        expiresHours: parsed.data.expires_hours,
      });
      return reply.code(201).send({
        secure_message: created.row,
        portal_url: `${process.env.APP_BASE_URL ?? 'http://localhost:3000'}/secure-message`,
        portal_token: created.portalToken,
        access_code: created.accessCode,
        credential_notice:
          'The portal token and access code are returned once. Deliver the access code through a separate trusted channel.',
      });
    } catch (err) {
      if (err instanceof SecureMessageError) {
        return reply.code(err.code === 'mode_mismatch' ? 422 : 409).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/secure-messages/:id/revoke', {
    preHandler: requireScope('send'),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const id = z.string().uuid().safeParse((req.params as { id?: string }).id);
    if (!id.success) return reply.code(404).send({ error: 'not_found' });
    try {
      await revokeSecureMessage(req.auth!.customer_id, id.data);
      return { revoked: id.data };
    } catch (err) {
      if (err instanceof SecureMessageError) return reply.code(404).send({ error: err.code });
      throw err;
    }
  });
};

export const securePortalRoutes: FastifyPluginAsync = async (app) => {
  app.post('/secure-portal/access', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (req, reply) => {
    const parsed = z.object({
      portal_token: z.string().min(32).max(128),
      access_code: z.string().min(16).max(128),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed' });
    try {
      const message = await accessSecureMessage(parsed.data.portal_token, parsed.data.access_code);
      reply.header('Cache-Control', 'no-store, max-age=0');
      reply.header('Pragma', 'no-cache');
      reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      return { message };
    } catch (err) {
      if (err instanceof SecureMessageError) {
        // Unknown, expired and revoked credentials share the same external
        // envelope so this endpoint is not a token/status oracle.
        return reply.code(404).send({ error: 'secure_message_unavailable' });
      }
      throw err;
    }
  });
};
