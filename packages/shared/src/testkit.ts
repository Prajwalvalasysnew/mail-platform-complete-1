// Test-support helpers that run inside @platform/shared's own module realm.
//
// E2E tests run under vitest, which transforms test files into its own module
// graph. The DB singleton (and its Kysely query builders) live in shared's
// compiled realm. Chaining Kysely calls directly from a vitest-transformed file
// crosses realms and trips Kysely's private-field checks. Routing all seed/query
// helpers through this module keeps every Kysely object in one realm.
//
// This module has no test-framework dependency; it is plain runtime code that
// happens to be useful for integration/E2E setup and local scripting.

import { db } from './db.js';
import { redis } from './redis.js';
import { generateApiKeyV2, type KeyType } from './apikeys.js';
import { createAdminSession, type AdminRole } from './admin.js';

export interface SeededCustomer {
  customerId: string;
  apiKey: string;
  keyId: string;
}

export interface SeedCustomerOpts {
  keyType?: KeyType;
  tier?: 'free' | 'paid' | 'enterprise';
  dailyQuota?: number;
  monthlyQuota?: number;
  kycLevel?: 'email' | 'domain' | 'payment' | 'business';
  scopes?: string[];
  status?: 'active' | 'suspended';
  billingStatus?: string;
}

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function seedCustomer(opts: SeedCustomerOpts = {}): Promise<SeededCustomer> {
  const email = `${unique('cust')}@example.com`;
  const customer = await db
    .insertInto('customers')
    .values({
      email,
      name: 'E2E Customer',
      tier: opts.tier ?? 'paid',
      daily_quota: opts.dailyQuota ?? 10_000,
      monthly_quota: opts.monthlyQuota ?? 300_000,
      status: opts.status ?? 'active',
      billing_status: opts.billingStatus ?? 'active',
      kyc_level: opts.kycLevel ?? 'payment',
    } as any)
    .returning(['id'])
    .executeTakeFirstOrThrow();

  const key = generateApiKeyV2(opts.keyType ?? 'test');
  const row = await db
    .insertInto('api_keys')
    .values({
      customer_id: customer.id,
      name: 'e2e-key',
      key_prefix: key.prefix,
      key_hash: key.hash,
      key_type: key.key_type,
      scopes: opts.scopes ?? ['send', 'domains', 'suppressions', 'messages', 'webhooks', 'templates'],
    } as any)
    .returning(['id'])
    .executeTakeFirstOrThrow();

  return { customerId: customer.id, apiKey: key.plaintext, keyId: row.id };
}

export async function seedVerifiedDomain(customerId: string, domain?: string): Promise<string> {
  const d = domain ?? `${unique('dom')}.example.com`;
  await db
    .insertInto('sending_domains')
    .values({
      customer_id: customerId,
      domain: d,
      dkim_selector: 'mp1',
      dkim_public_key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8-test-public-key',
      dkim_private_key: 'v1:test:test:test-encrypted-private-key',
      verified_at: new Date(),
      dkim_verified: true,
    } as any)
    .execute();
  return d;
}

export async function seedUnverifiedDomain(customerId: string, domain: string): Promise<void> {
  await db
    .insertInto('sending_domains')
    .values({
      customer_id: customerId,
      domain,
      dkim_selector: 'mp1',
      dkim_public_key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8-test-public-key',
      dkim_private_key: 'v1:test:test:test-encrypted-private-key',
      verified_at: null,
      dkim_verified: false,
    } as any)
    .execute();
}

export async function seedSuppression(customerId: string, email: string, reason = 'hard_bounce'): Promise<void> {
  await db
    .insertInto('suppressions')
    .values({ customer_id: customerId, email, reason, notes: 'seeded by e2e test' } as any)
    .execute();
}

export async function getMessageStatus(messageId: string): Promise<string | null> {
  const row = await db
    .selectFrom('messages')
    .select(['status'])
    .where('message_id', '=', messageId)
    .executeTakeFirst();
  return row?.status ?? null;
}

export async function getMessageRow(messageId: string): Promise<any | null> {
  const row = await db
    .selectFrom('messages')
    .selectAll()
    .where('message_id', '=', messageId)
    .executeTakeFirst();
  return row ?? null;
}

export async function getEventTypes(messageId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('events')
    .select(['event_type'])
    .where('message_id', '=', messageId)
    .execute();
  return rows.map((r) => r.event_type);
}

export async function getUsageSent(customerId: string): Promise<number> {
  const row = await db
    .selectFrom('usage_daily')
    .select(['sent'])
    .where('customer_id', '=', customerId)
    .executeTakeFirst();
  return Number(row?.sent ?? 0);
}

export async function getTrackedLinkUrls(messageId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('tracked_links')
    .select(['original_url'])
    .where('message_id', '=', messageId)
    .execute();
  return rows.map((r) => r.original_url);
}

export async function countMessagesTo(customerId: string, to: string): Promise<number> {
  const row = await db
    .selectFrom('messages')
    .select(db.fn.countAll().as('c'))
    .where('customer_id', '=', customerId)
    .where('to_address', '=', to)
    .executeTakeFirst();
  return Number((row as any)?.c ?? 0);
}

export async function waitForStatus(
  messageId: string,
  target: string[],
  timeoutMs = 8000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await getMessageStatus(messageId);
    if (s && target.includes(s)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  const last = await getMessageStatus(messageId);
  throw new Error(`message ${messageId} did not reach ${target.join('|')} (last=${last ?? 'missing'})`);
}

export async function resetQuota(customerId: string): Promise<void> {
  const now = new Date().toISOString();
  await redis.del(`quota:d:${customerId}:${now.slice(0, 10)}`, `quota:m:${customerId}:${now.slice(0, 7)}`);
}

// Clear the per-pool daily warmup counter so E2E sends aren't throttled by the
// 50/day stage-0 cap once earlier test runs have consumed it. Optionally raise
// the pool's warmup_stage so the cap is effectively unlimited for the test.
export async function resetPoolWarmup(
  poolName: 'transactional' | 'marketing' | 'quarantine' = 'transactional'
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  await redis.del(`warmup:${poolName}:${day}`);
  // Advance the pool to its final warmup stage so the daily cap is at maximum.
  await db
    .updateTable('ip_pools')
    .set({ warmup_stage: 20 } as any)
    .where('name', '=', poolName)
    .execute();
}

// Insert N messages for a customer with a given status and IP pool, backdated
// into the 24h reputation window. Used by reputation/deliverability tests.
export async function seedMessages(
  customerId: string,
  opts: { count: number; status: string; ipPool?: string; toPrefix?: string }
): Promise<void> {
  const pool = opts.ipPool ?? 'transactional';
  const rows = Array.from({ length: opts.count }, (_, i) => ({
    message_id: `seed-${customerId}-${pool}-${opts.status}-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    customer_id: customerId,
    from_address: 'sender@seed.example.com',
    to_address: `${opts.toPrefix ?? 'rcpt'}-${i}@example.com`,
    subject: 'seed',
    status: opts.status,
    ip_pool: pool,
    attempts: 1,
    body_storage: 'inline',
  }));
  // Chunk to keep the insert reasonable.
  for (let i = 0; i < rows.length; i += 500) {
    await db.insertInto('messages').values(rows.slice(i, i + 500) as any).execute();
  }
}

export async function getPoolAction(pool: string): Promise<string> {
  const v = await redis.get(`pool:action:${pool}`);
  return v ?? 'ok';
}

export async function clearPoolMessages(): Promise<void> {
  await db.deleteFrom('messages').where('from_address', '=', 'sender@seed.example.com').execute();
}

// Read bot-detection-relevant columns for a message (engagement timestamps).
export async function getEngagement(messageId: string): Promise<{
  opened_at: any; human_opened_at: any; machine_opened_at: any;
  first_clicked_at: any; human_clicked_at: any;
} | null> {
  const row = await db
    .selectFrom('messages')
    .select(['opened_at', 'human_opened_at', 'machine_opened_at', 'first_clicked_at', 'human_clicked_at'])
    .where('message_id', '=', messageId)
    .executeTakeFirst();
  return row ?? null;
}

// Read the latest event of a given type with its bot verdict.
export async function getLatestEvent(messageId: string, eventType: string): Promise<any | null> {
  const row = await db
    .selectFrom('events')
    .select(['event_type', 'bot_verdict', 'bot_score', 'payload'])
    .where('message_id', '=', messageId)
    .where('event_type', '=', eventType as any)
    .orderBy('occurred_at', 'desc')
    .executeTakeFirst();
  return row ?? null;
}

// Insert a message in 'accepted' state with a delivered_at, for engagement tests.
export async function seedDeliveredMessage(customerId: string, deliveredAgoMs = 600000): Promise<string> {
  const messageId = `eng-${customerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await db.insertInto('messages').values({
    message_id: messageId,
    customer_id: customerId,
    from_address: 'sender@seed.example.com',
    to_address: `eng-${Math.random().toString(36).slice(2, 8)}@example.com`,
    subject: 'engagement seed',
    status: 'delivered',
    delivered_at: new Date(Date.now() - deliveredAgoMs),
    ip_pool: 'transactional',
    attempts: 1,
    body_storage: 'inline',
  } as any).execute();
  return messageId;
}

export async function seedQueuedMessage(customerId: string, opts: {
  messageId?: string;
  sendAt?: Date | null;
  from?: string;
  to?: string;
  subject?: string;
  status?: string;
  tags?: string[];
} = {}): Promise<string> {
  const messageId = opts.messageId ?? `queued-${customerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await db.insertInto('messages').values({
    message_id: messageId,
    customer_id: customerId,
    from_address: opts.from ?? 'sender@seed.example.com',
    to_address: opts.to ?? `queued-${Math.random().toString(36).slice(2, 8)}@example.com`,
    subject: opts.subject ?? 'queued seed',
    text_body: 'queued body',
    status: opts.status ?? 'queued',
    tags: opts.tags ?? [],
    send_at: opts.sendAt ?? null,
    ip_pool: 'transactional',
    attempts: 0,
    body_storage: 'inline',
  } as any).execute();
  return messageId;
}

export async function seedMessageEvent(customerId: string, messageId: string, eventType = 'queued', payload: Record<string, unknown> = {}): Promise<number> {
  const row = await db
    .insertInto('events')
    .values({
      message_id: messageId,
      customer_id: customerId,
      event_type: eventType as any,
      payload,
    } as any)
    .returning('id')
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

export async function seedAdminSession(role: AdminRole = 'support'): Promise<{ token: string; adminUserId: string; email: string; role: AdminRole }> {
  const email = `${unique('admin')}@example.com`;
  const oidc = `oidc-${unique('admin')}`;
  const admin = await db
    .insertInto('admin_users')
    .values({
      email,
      name: 'Test Admin',
      role,
      oidc_subject: oidc,
    } as any)
    .returning(['id'])
    .executeTakeFirstOrThrow();

  const session = await createAdminSession(oidc, email);
  if (!session) throw new Error('failed to create admin session');
  return { token: session.token, adminUserId: admin.id, email, role };
}

// Insert a message backdated by the given number of days. Used by retention tests.
export async function seedOldMessage(
  customerId: string,
  opts: {
    daysAgo?: number;
    status?: string;
    htmlBody?: string;
    textBody?: string;
    bodyStorage?: string;
    bodyObjectKey?: string;
  } = {},
): Promise<string> {
  const daysAgo = opts.daysAgo ?? 100;
  const messageId = `old-${customerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const queuedAt = new Date(Date.now() - daysAgo * 86_400_000);
  await db
    .insertInto('messages')
    .values({
      message_id: messageId,
      customer_id: customerId,
      from_address: 'sender@seed.example.com',
      to_address: `old-${Math.random().toString(36).slice(2, 8)}@example.com`,
      subject: 'old message seed',
      html_body: opts.htmlBody ?? null,
      text_body: opts.textBody ?? null,
      status: (opts.status ?? 'delivered') as any,
      ip_pool: 'transactional',
      attempts: 1,
      body_storage: (opts.bodyStorage ?? 'inline') as any,
      body_object_key: opts.bodyObjectKey ?? null,
      queued_at: queuedAt as any,
    } as any)
    .execute();
  return messageId;
}

// Insert an event backdated by the given number of days. Used by retention tests.
export async function seedOldEvent(
  customerId: string,
  messageId: string,
  eventType = 'delivered',
  daysAgo = 100,
): Promise<number> {
  const occurredAt = new Date(Date.now() - daysAgo * 86_400_000);
  const row = await db
    .insertInto('events')
    .values({
      message_id: messageId,
      customer_id: customerId,
      event_type: eventType as any,
      payload: {},
      occurred_at: occurredAt as any,
    } as any)
    .returning('id')
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

// Insert an audit_log entry backdated by the given number of days.
export async function seedOldAuditEntry(
  customerId: string | null,
  action: string,
  daysAgo = 100,
): Promise<number> {
  const occurredAt = new Date(Date.now() - daysAgo * 86_400_000);
  const row = await db
    .insertInto('audit_log')
    .values({
      customer_id: customerId,
      action,
      metadata: {},
      actor_type: 'system',
      occurred_at: occurredAt as any,
    } as any)
    .returning('id')
    .executeTakeFirstOrThrow();
  return Number(row.id);
}

// Count audit_log rows for a customer.
export async function countAuditEntries(customerId: string | null, action?: string): Promise<number> {
  let q = db
    .selectFrom('audit_log')
    .select(db.fn.countAll().as('c'))
    .where('customer_id', customerId === null ? 'is' : '=', customerId as any);
  if (action) q = q.where('action', '=', action);
  const row = await q.executeTakeFirst();
  return Number((row as any)?.c ?? 0);
}

export async function getSendOutboxRow(messageId: string): Promise<any | null> {
  const row = await db
    .selectFrom('send_outbox')
    .selectAll()
    .where('message_id', '=', messageId)
    .executeTakeFirst();
  return row ?? null;
}

export async function countSendOutboxRows(messageIds: string[], status?: string): Promise<number> {
  if (messageIds.length === 0) return 0;
  let q = db
    .selectFrom('send_outbox')
    .select(db.fn.countAll().as('c'))
    .where('message_id', 'in', messageIds);
  if (status) q = q.where('status', '=', status as any);
  const row = await q.executeTakeFirst();
  return Number((row as any)?.c ?? 0);
}
