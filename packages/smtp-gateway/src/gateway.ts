// Customer-facing SMTP submission gateway ("smart host").
//
// The integration path for everything that speaks SMTP but not REST: ISP
// smart-host offloading, ERP/billing systems, VoIP voicemail-to-email, CCTV
// and IoT device alerts, ship-to-shore relays, legacy scripts. Point the
// device at smtp.<platform>:587, authenticate with a platform API key, and
// the message enters the exact same pipeline as POST /v1/send — suppressions,
// quotas, content scanning, DKIM, tracking, webhooks, and analytics all apply.
//
// Auth: SendGrid convention — username `apikey` (any username is accepted),
// password = a platform API key with the `send` or `smtp` scope. Repeated
// failures lock the source IP out via Redis.
//
// Sender policy: the MAIL FROM domain must be one of the account's verified
// sending domains (rejected at MAIL FROM time, before DATA is spent).

import { AuthenticationError } from './errors.js';
import { simpleParser } from 'mailparser';
import {
  db,
  redis,
  verifyApiKeyV2,
  detectKeyType,
  isSuppressedBatch,
  reserveQuota,
  releaseQuota,
  scanContent,
  generateMessageId,
  createSendOutboxRows,
  drainSendOutbox,
  validateAttachments,
  tierPriority,
  smtpGatewayMessages,
  smtpGatewayAuthFailures,
  type AttachmentInput,
} from '@platform/shared';

const MAX_RECIPIENTS = Number(process.env.SMTP_MAX_RECIPIENTS ?? 100);
const AUTH_FAILURE_LIMIT = Number(process.env.SMTP_AUTH_FAILURE_LIMIT ?? 10);
const AUTH_FAILURE_WINDOW_S = Number(process.env.SMTP_AUTH_FAILURE_WINDOW_SECONDS ?? 900);

export interface SmtpAuthContext {
  customer_id: string;
  api_key_id: string;
  tier: string;
  test_mode: boolean;
}

export interface SmtpAcceptResult {
  accepted: number;
  suppressed: number;
  message_ids: string[];
}

/** SMTP 4xx/5xx failure with the right enhanced status code. */
export class SmtpReject extends Error {
  constructor(public responseCode: number, message: string) {
    super(message);
    this.name = 'SmtpReject';
  }
}

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

export async function authenticateSmtp(password: string, remoteIp: string): Promise<SmtpAuthContext> {
  const lockKey = `smtp:authfail:${remoteIp}`;
  const failures = Number((await redis.get(lockKey)) ?? 0);
  if (failures >= AUTH_FAILURE_LIMIT) {
    smtpGatewayAuthFailures.inc({ reason: 'locked_out' });
    throw new AuthenticationError(454, 'Too many failed authentication attempts. Try again later.');
  }

  const recordFailure = async (reason: string): Promise<never> => {
    smtpGatewayAuthFailures.inc({ reason });
    const n = await redis.incr(lockKey);
    if (n === 1) await redis.expire(lockKey, AUTH_FAILURE_WINDOW_S);
    throw new AuthenticationError(535, 'Authentication failed: invalid credentials');
  };

  const token = password.trim();
  if (!detectKeyType(token)) return recordFailure('bad_format');

  const prefix = token.slice(0, 12);
  const candidates = await db
    .selectFrom('api_keys')
    .innerJoin('customers', 'customers.id', 'api_keys.customer_id')
    .select([
      'api_keys.id as api_key_id',
      'api_keys.customer_id',
      'api_keys.key_hash',
      'api_keys.scopes',
      'api_keys.key_type',
      'api_keys.expires_at',
      'customers.tier',
      'customers.status',
    ])
    .where('api_keys.key_prefix', '=', prefix)
    .where('api_keys.revoked_at', 'is', null)
    .execute();

  let matched: (typeof candidates)[number] | undefined;
  for (const cand of candidates) {
    if (await verifyApiKeyV2(token, cand.key_hash)) {
      matched = cand;
      break;
    }
  }
  if (!matched) return recordFailure('invalid_key');
  if (matched.expires_at && new Date(matched.expires_at as unknown as string | Date) < new Date()) {
    return recordFailure('expired_key');
  }
  if (matched.status !== 'active') {
    smtpGatewayAuthFailures.inc({ reason: 'account_suspended' });
    throw new AuthenticationError(535, 'Authentication failed: account is not active');
  }
  if (!matched.scopes.includes('send') && !matched.scopes.includes('smtp') && !matched.scopes.includes('admin')) {
    smtpGatewayAuthFailures.inc({ reason: 'missing_scope' });
    throw new AuthenticationError(535, "Authentication failed: key lacks the 'send' or 'smtp' scope");
  }

  return {
    customer_id: matched.customer_id,
    api_key_id: matched.api_key_id,
    tier: matched.tier,
    test_mode: matched.key_type === 'test',
  };
}

// ---------------------------------------------------------------------------
// MAIL FROM — verified-domain enforcement (cheap, before DATA)
// ---------------------------------------------------------------------------

export async function assertVerifiedSender(auth: SmtpAuthContext, mailFrom: string): Promise<string> {
  const address = mailFrom.trim().toLowerCase();
  const domain = address.split('@')[1];
  if (!domain) throw new SmtpReject(501, 'MAIL FROM must be a full address on your verified sending domain');
  const row = await db
    .selectFrom('sending_domains')
    .select(['verified_at', 'dkim_verified'])
    .where('customer_id', '=', auth.customer_id)
    .where('domain', '=', domain)
    .executeTakeFirst();
  if (!row) {
    throw new SmtpReject(550, `Sender domain ${domain} is not registered on this account. Add it via the API/dashboard first.`);
  }
  if (!row.verified_at || !row.dkim_verified) {
    throw new SmtpReject(550, `Sender domain ${domain} is not verified yet. Complete DNS verification first.`);
  }
  return address;
}

// ---------------------------------------------------------------------------
// DATA — parse the MIME message and feed the platform pipeline
// ---------------------------------------------------------------------------

export async function acceptSmtpMessage(
  auth: SmtpAuthContext,
  envelopeFrom: string,
  recipients: string[],
  raw: Buffer
): Promise<SmtpAcceptResult> {
  if (recipients.length === 0) throw new SmtpReject(554, 'No accepted recipients');
  if (recipients.length > MAX_RECIPIENTS) {
    throw new SmtpReject(452, `Too many recipients (max ${MAX_RECIPIENTS} per message)`);
  }

  const parsed = await simpleParser(raw);
  const subject = (parsed.subject ?? '').slice(0, 998);
  const html = typeof parsed.html === 'string' ? parsed.html : undefined;
  const text = parsed.text ?? undefined;
  if (!subject) throw new SmtpReject(554, 'Message must include a Subject header');
  if (!html && !text) throw new SmtpReject(554, 'Message must include a text or HTML body');

  // Attachments go through the same validator as the API (size caps,
  // executable denylist, filename sanitization).
  let storedAttachments: Array<{ filename: string; content_type: string; size: number; content_b64: string }> = [];
  if (parsed.attachments.length > 0) {
    const inputs: AttachmentInput[] = parsed.attachments.map((a) => ({
      filename: a.filename ?? 'attachment',
      content: a.content.toString('base64'),
      content_type: a.contentType,
    }));
    const validated = validateAttachments(inputs);
    if (!validated.ok) throw new SmtpReject(554, validated.message);
    storedAttachments = validated.attachments;
  }

  const fromName = parsed.from?.value?.[0]?.name || null;

  const customer = await db
    .selectFrom('customers')
    .select(['status', 'billing_status', 'daily_quota', 'monthly_quota'])
    .where('id', '=', auth.customer_id)
    .executeTakeFirstOrThrow();
  if (customer.status !== 'active') throw new SmtpReject(550, 'Account is not active');

  // Suppression screening — same policy as the API: suppressed recipients
  // are silently skipped, the rest go through.
  const unique = [...new Set(recipients.map((r) => r.toLowerCase()))];
  const suppressedSet = await isSuppressedBatch(auth.customer_id, unique);
  const toSend = unique.filter((r) => !suppressedSet.has(r));
  const suppressedCount = unique.length - toSend.length;
  if (toSend.length === 0) {
    // Everything suppressed: accept (the sender's job is done) but deliver nothing.
    smtpGatewayMessages.inc({ outcome: 'all_suppressed' });
    return { accepted: 0, suppressed: suppressedCount, message_ids: [] };
  }

  const quota = await reserveQuota(auth.customer_id, toSend.length, customer.daily_quota, customer.monthly_quota);
  if (!quota.allowed) {
    throw new SmtpReject(452, `${quota.exceeded === 'monthly' ? 'Monthly' : 'Daily'} sending quota exceeded. Retry later.`);
  }

  // Content scan (same regex policy as the API path; block-level findings
  // reject the message outright — an SMTP relay must not be the unscanned
  // back door).
  const scan = scanContent(subject, html, text);
  if (scan.action === 'block') {
    await releaseQuota(auth.customer_id, toSend.length);
    smtpGatewayMessages.inc({ outcome: 'content_rejected' });
    throw new SmtpReject(554, 'Message rejected by content policy');
  }

  const fromDomain = envelopeFrom.split('@')[1]!;
  const priority = tierPriority(auth.tier);
  const rows = toSend.map((to) => ({ message_id: generateMessageId(fromDomain), to }));

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('messages')
      .values(
        rows.map((m) => ({
          message_id: m.message_id,
          customer_id: auth.customer_id,
          from_address: envelopeFrom,
          from_name: fromName,
          to_address: m.to,
          reply_to: parsed.replyTo?.value?.[0]?.address ?? null,
          subject,
          html_body: html ?? null,
          text_body: text ?? null,
          headers: {},
          tags: ['smtp'],
          metadata: { _channel: 'smtp', ...(auth.test_mode ? { _test_mode: true } : {}) },
          tracking_opens: false, // relay mail is machine-generated; no pixel injection
          tracking_clicks: false,
          ip_pool: 'transactional',
          risk_score: scan.score,
          attachments: storedAttachments.length ? (JSON.stringify(storedAttachments) as any) : null,
          status: 'queued' as const,
        }))
      )
      .execute();

    await trx
      .insertInto('events')
      .values(
        rows.map((m) => ({
          message_id: m.message_id,
          customer_id: auth.customer_id,
          event_type: 'queued' as const,
          payload: { channel: 'smtp' },
        }))
      )
      .execute();

    await createSendOutboxRows(
      rows.map((m) => ({ message_id: m.message_id, customer_id: auth.customer_id, priority })),
      trx
    );
  });

  try {
    await drainSendOutbox({ messageIds: rows.map((r) => r.message_id), limit: rows.length });
  } catch {
    /* scheduler drain recovers */
  }

  smtpGatewayMessages.inc({ outcome: 'accepted' }, rows.length);
  return { accepted: rows.length, suppressed: suppressedCount, message_ids: rows.map((r) => r.message_id) };
}
