// Recipient-facing tracker: open pixel, click redirects, and the CAN-SPAM
// unsubscribe flow.
//
// The Fastify instance is built at module scope and exported WITHOUT listening,
// so tests can drive the real routes through app.inject() instead of a live
// port (see packages/tests/e2e/canspam-optout-friction.e2e.test.ts). The
// process entrypoint that binds the port lives in server.ts.

import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import crypto from 'node:crypto';
import {
  db,
  eventsQueue,
  decodeMessageIdFromUrl,
  addSuppression,
  redis,
  classifyEngagement,
  metricsText,
  metricsAuthorized,
  privacyLoggerOptions,
} from '@platform/shared';

// A signed confirmation token binds the unsubscribe POST to the specific
// encoded message id, defeating blind CSRF: a third party can't forge a valid
// token without the secret. RFC 8058 one-click POSTs from mail clients include
// it via the hidden field we render.
function unsubToken(encoded: string): string {
  const secret = process.env.VERP_SECRET ?? process.env.UNSUB_SECRET ?? 'dev-unsub-secret';
  return crypto.createHmac('sha256', secret).update(`unsub:${encoded}`).digest('base64url').slice(0, 24);
}
function verifyUnsubToken(encoded: string, token: unknown): boolean {
  const expected = unsubToken(encoded);
  const a = Buffer.from(String(token ?? ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Escape values that are interpolated into the HTML responses below. Recipient
// addresses are stored data; even though they're validated at send time, never
// reflect them into markup unescaped.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const app = Fastify({
  logger: privacyLoggerOptions(),
  trustProxy: true,
});

// urlencoded body needed for the RFC 8058 one-click POST + classic form.
await app.register(formbody);

// Per-IP rate limit on tracker endpoints. Open-pixel and click endpoints are
// hit by every recipient, so the cap is generous; unsub gets a tighter cap.
await app.register(rateLimit, {
  global: false,
  redis,
  keyGenerator: (req) => req.ip,
});

// 1x1 transparent GIF
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

app.get('/health', async () => ({ status: 'ok' }));

// Kubernetes probes. /live = process alive (no dependencies); /ready = the
// tracker can actually do its job (DB for message lookups, Redis for the
// events queue and rate limiting).
app.get('/live', async () => ({ status: 'ok' }));
app.get('/ready', async (req, reply) => {
  const checks: Record<string, 'ok' | 'fail'> = { db: 'ok', redis: 'ok' };
  try {
    // Cheap connectivity probe through the shared db handle (avoids importing
    // kysely's `sql` here, which trips the dual CJS/ESM package types).
    await db.selectFrom('customers').select('id').limit(1).execute();
  } catch {
    checks.db = 'fail';
  }
  try {
    await redis.ping();
  } catch {
    checks.redis = 'fail';
  }
  const ready = Object.values(checks).every((v) => v === 'ok');
  return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
});

// Prometheus scrape endpoint.
app.get('/metrics', async (req, reply) => {
  if (!metricsAuthorized({ authorization: req.headers.authorization, token: (req.query as any)?.token })) {
    return reply.code(401).header('WWW-Authenticate', 'Bearer').send('unauthorized');
  }
  reply.header('Content-Type', 'text/plain; version=0.0.4');
  return metricsText();
});

// =============== OPEN tracking ==============
app.get<{ Params: { encoded: string } }>('/o/:encoded', async (req, reply) => {
  // Always serve the pixel first; event handling happens after
  reply
    .header('Content-Type', 'image/gif')
    .header('Cache-Control', 'private, no-cache, no-store, must-revalidate')
    .header('Pragma', 'no-cache')
    .header('Expires', '0')
    .send(PIXEL);

  try {
    const messageId = decodeMessageIdFromUrl(req.params.encoded);

    // Pull delivery timing so we can detect pre-fetch opens. Cheap single-row
    // lookup; the pixel has already been sent, so this never delays the client.
    const m = await db
      .selectFrom('messages')
      .select(['delivered_at', 'accepted_at', 'human_opened_at'])
      .where('message_id', '=', messageId)
      .executeTakeFirst();

    if (!m) {
      return;
    }

    const baseTs = (m.delivered_at ?? m.accepted_at) as Date | null | undefined;
    const msSinceDelivery = baseTs ? Date.now() - new Date(baseTs).getTime() : null;

    const verdict = classifyEngagement({
      eventType: 'opened',
      userAgent: req.headers['user-agent'] ?? null,
      ip: req.ip,
      msSinceDelivery,
    });

    await eventsQueue.add('opened', {
      message_id: messageId,
      event_type: 'opened',
      ip: req.ip,
      user_agent: req.headers['user-agent'] ?? undefined,
      occurred_at: new Date().toISOString(),
      bot_verdict: verdict.verdict,
      bot_score: verdict.botScore,
      bot_reasons: verdict.reasons,
    });
  } catch (err) {
    app.log.warn({ err }, 'failed to record open');
  }
});

// =============== CLICK tracking ==============
app.get<{ Params: { encoded: string; linkId: string } }>(
  '/c/:encoded/:linkId',
  async (req, reply) => {
    let messageId: string;
    try {
      messageId = decodeMessageIdFromUrl(req.params.encoded);
    } catch {
      return reply.code(400).send('Invalid link');
    }

    const link = await db
      .selectFrom('tracked_links')
      .select('original_url')
      .where('id', '=', req.params.linkId)
      .where('message_id', '=', messageId)
      .executeTakeFirst();

    if (!link) return reply.code(404).send('Link not found');

    // Defense in depth: only ever 302 to an http(s) URL. Link rewriting already
    // filters to http(s) at storage time, but re-validating here ensures the
    // trusted tracking domain can never be turned into a javascript:/data:/etc.
    // redirector by a malformed or unexpectedly-sourced row.
    const target = link.original_url;
    if (!/^https?:\/\//i.test(target)) {
      app.log.warn({ message_id: messageId, link_id: req.params.linkId }, 'click target is not http(s) — refusing redirect');
      return reply.code(400).send('Invalid link');
    }

    // Timing + whether a human already opened this message (a click with no
    // preceding human open is a classic scanner pattern).
    const m = await db
      .selectFrom('messages')
      .select(['delivered_at', 'accepted_at', 'human_opened_at'])
      .where('message_id', '=', messageId)
      .executeTakeFirst();
    const baseTs = (m?.delivered_at ?? m?.accepted_at) as Date | null | undefined;
    const msSinceDelivery = baseTs ? Date.now() - new Date(baseTs).getTime() : null;

    const verdict = classifyEngagement({
      eventType: 'clicked',
      userAgent: req.headers['user-agent'] ?? null,
      ip: req.ip,
      msSinceDelivery,
      hadPriorHumanOpen: !!m?.human_opened_at,
    });

    // Fire-and-forget event
    eventsQueue
      .add('clicked', {
        message_id: messageId,
        event_type: 'clicked',
        payload: { url: link.original_url },
        ip: req.ip,
        user_agent: req.headers['user-agent'] ?? undefined,
        occurred_at: new Date().toISOString(),
        bot_verdict: verdict.verdict,
        bot_score: verdict.botScore,
        bot_reasons: verdict.reasons,
      })
      .catch((err) => app.log.warn({ err }, 'failed to record click'));

    return reply.redirect(target, 302);
  }
);

// =============== UNSUBSCRIBE ==============
// GET shows confirmation page; POST is the one-click action (RFC 8058).
// When ?group=<uuid> is present the unsub is scoped to that unsubscribe group
// (inserts into unsubscribe_group_members). Without it, a global suppression
// is added (old behaviour, compatible with messages sent without a group).

type UnsubParams = { Params: { encoded: string }; Querystring: { group?: string } };

app.get<UnsubParams>('/u/:encoded', async (req, reply) => {
  let messageId: string;
  try {
    messageId = decodeMessageIdFromUrl(req.params.encoded);
  } catch {
    return reply.code(400).send('Invalid link');
  }

  const msg = await db
    .selectFrom('messages')
    .select(['to_address', 'customer_id'])
    .where('message_id', '=', messageId)
    .executeTakeFirst();

  if (!msg) return reply.code(404).send('Message not found');

  const groupId = req.query.group;
  let groupName: string | null = null;
  if (groupId) {
    const grp = await db
      .selectFrom('unsubscribe_groups')
      .select('name')
      .where('id', '=', groupId)
      .executeTakeFirst();
    groupName = grp?.name ?? null;
  }

  const actionUrl = `/u/${encodeURIComponent(req.params.encoded)}${groupId ? `?group=${encodeURIComponent(groupId)}` : ''}`;
  const scopeText = groupName
    ? `from <strong>${escapeHtml(groupName)}</strong> emails`
    : 'from this sender';

  reply.type('text/html').send(`
<!DOCTYPE html>
<html>
<head><title>Unsubscribe</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;padding:24px;color:#333}
button{padding:12px 24px;background:#333;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:16px}</style>
</head>
<body>
<h1>Unsubscribe</h1>
<p>Click below to unsubscribe <strong>${escapeHtml(msg.to_address)}</strong> ${scopeText}.</p>
<form method="POST" action="${escapeHtml(actionUrl)}">
  <input type="hidden" name="token" value="${unsubToken(req.params.encoded)}" />
  <button type="submit">Confirm unsubscribe</button>
</form>
</body>
</html>
  `);
});

app.post<UnsubParams>(
  '/u/:encoded',
  { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
  async (req, reply) => {
  let messageId: string;
  try {
    messageId = decodeMessageIdFromUrl(req.params.encoded);
  } catch {
    return reply.code(400).send('Invalid link');
  }

  // Accept either our signed confirmation token (browser form) or the RFC 8058
  // one-click marker that mail clients POST. Anything else is rejected (CSRF).
  const body: any = req.body ?? {};
  const isOneClick =
    body['List-Unsubscribe'] === 'One-Click' ||
    (typeof body === 'string' && /List-Unsubscribe=One-Click/i.test(body));
  const hasValidToken = verifyUnsubToken(req.params.encoded, body.token);
  if (!isOneClick && !hasValidToken) {
    return reply.code(403).send('Invalid or missing unsubscribe confirmation token');
  }

  const msg = await db
    .selectFrom('messages')
    .select(['to_address', 'customer_id'])
    .where('message_id', '=', messageId)
    .executeTakeFirst();

  if (!msg) return reply.code(404).send('Message not found');

  const groupId = req.query.group;
  let groupName: string | null = null;

  if (groupId) {
    // Group-scoped unsub: insert into unsubscribe_group_members (idempotent via unique constraint).
    const grp = await db
      .selectFrom('unsubscribe_groups')
      .select(['id', 'name'])
      .where('id', '=', groupId)
      .where('customer_id', '=', msg.customer_id)
      .executeTakeFirst();
    if (grp) {
      groupName = grp.name;
      await db.insertInto('unsubscribe_group_members')
        .values({ group_id: groupId, customer_id: msg.customer_id, email: msg.to_address })
        .onConflict((oc) => oc.constraint('unsubscribe_group_members_uniq').doNothing())
        .execute();
    }
  } else {
    // Global unsub: full suppression.
    await addSuppression(
      msg.customer_id,
      msg.to_address,
      'unsubscribe',
      `One-click via ${messageId}`,
      undefined,
      { source: 'one_click_unsubscribe', messageId },
    );
  }

  await eventsQueue.add('unsubscribed', {
    message_id: messageId,
    customer_id: msg.customer_id,
    event_type: 'unsubscribed' as any,
    ip: req.ip,
    user_agent: req.headers['user-agent'] ?? undefined,
    occurred_at: new Date().toISOString(),
    payload: groupId ? { group_id: groupId, group_name: groupName } : undefined,
  });

  const scopeText = groupName
    ? `from <strong>${escapeHtml(groupName)}</strong> emails`
    : 'from this sender';

  return reply.type('text/html').send(`
<!DOCTYPE html>
<html><head><title>Unsubscribed</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;padding:24px;color:#333}</style>
</head>
<body><h1>You have been unsubscribed</h1>
<p><strong>${escapeHtml(msg.to_address)}</strong> will no longer receive emails ${scopeText}.</p></body></html>
  `);
});

export default app;
