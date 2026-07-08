import { db, type DbExecutor } from './db.js';
import { redis } from './redis.js';

const SUPPRESSION_TTL_SECONDS = 3600;

function key(customerId: string, email: string): string {
  return `supp:${customerId}:${email.toLowerCase()}`;
}

/**
 * Batched suppression check. Returns the set of suppressed emails (lowercased)
 * from the input list. Collapses the per-recipient (Redis GET + DB SELECT)
 * pattern into a single Redis MGET plus, for cache misses only, a single DB
 * `email IN (...)` query — turning a 1000-recipient send from ~2000 sequential
 * round-trips into ~2. Results are written back to the per-email cache so the
 * single-email path stays warm.
 */
export async function isSuppressedBatch(
  customerId: string,
  emails: string[],
  executor: DbExecutor = db
): Promise<Set<string>> {
  const suppressed = new Set<string>();
  if (emails.length === 0) return suppressed;

  // Normalize + dedupe while remembering the lowercase form.
  const lowered = Array.from(new Set(emails.map((e) => e.toLowerCase())));
  const cacheKeys = lowered.map((e) => key(customerId, e));

  // 1) One MGET for all recipients.
  const cached = cacheKeys.length ? await redis.mget(...cacheKeys) : [];
  const misses: string[] = [];
  for (let i = 0; i < lowered.length; i++) {
    const c = cached[i];
    if (c === '1') suppressed.add(lowered[i]!);
    else if (c === '0') { /* known not-suppressed */ }
    else misses.push(lowered[i]!);
  }

  if (misses.length === 0) return suppressed;

  // 2) One DB query for all cache-misses.
  const rows = await executor
    .selectFrom('suppressions')
    .select('email')
    .where('customer_id', '=', customerId)
    .where('email', 'in', misses)
    .execute();
  const hitSet = new Set(rows.map((r) => r.email.toLowerCase()));

  // 3) Cache-fill each miss and accumulate the suppressed set.
  const pipe = redis.pipeline();
  for (const email of misses) {
    const isSupp = hitSet.has(email);
    if (isSupp) suppressed.add(email);
    pipe.setex(key(customerId, email), SUPPRESSION_TTL_SECONDS, isSupp ? '1' : '0');
  }
  await pipe.exec();

  return suppressed;
}

/**
 * Check whether a recipient is suppressed for the given customer.
 * Hits Redis first; falls back to Postgres (via `executor`, default global
 * `db`) and caches the result.
 */
export async function isSuppressed(
  customerId: string,
  email: string,
  executor: DbExecutor = db
): Promise<boolean> {
  const cacheKey = key(customerId, email);
  const cached = await redis.get(cacheKey);
  if (cached !== null) {
    return cached === '1';
  }

  const row = await executor
    .selectFrom('suppressions')
    .select('email')
    .where('customer_id', '=', customerId)
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst();

  const suppressed = !!row;
  await redis.setex(cacheKey, SUPPRESSION_TTL_SECONDS, suppressed ? '1' : '0');
  return suppressed;
}

/**
 * Add a recipient to a customer's suppression list. Idempotent.
 *
 * `executor` defaults to the global (service-role) `db`, which is correct for
 * worker/tracker/scheduler callers (auto-suppression on bounce/complaint,
 * one-click unsubscribe). API routes acting on a customer's own request MUST
 * pass the tenant-scoped transaction from `tenantScoped()`/`withTenant()` so
 * the write is covered by RLS under fail-closed policies.
 */
export async function addSuppression(
  customerId: string,
  email: string,
  reason: 'hard_bounce' | 'complaint' | 'unsubscribe' | 'manual' | 'invalid',
  notes?: string,
  executor: DbExecutor = db,
  consent?: { source?: string; messageId?: string }
): Promise<void> {
  const normalized = email.toLowerCase();
  await executor
    .insertInto('suppressions')
    .values({
      customer_id: customerId,
      email: normalized,
      reason,
      notes: notes ?? null,
    })
    .onConflict((oc) => oc.columns(['customer_id', 'email']).doNothing())
    .execute();

  // Append to the consent ledger (gap analysis #8). Append-only audit trail of
  // every opt-out, for GDPR/CAN-SPAM proof. Written in the same executor so it
  // shares the caller's transaction when one is provided.
  await appendConsentEvent(executor, {
    customerId,
    email: normalized,
    action: 'suppress',
    reason,
    source: consent?.source ?? defaultSourceForReason(reason),
    notes: notes ?? null,
    messageId: consent?.messageId ?? null,
  });

  await redis.setex(key(customerId, email), SUPPRESSION_TTL_SECONDS, '1');
}

/**
 * Bulk-add suppressions efficiently: chunked multi-row INSERTs and a single
 * pipelined Redis write, instead of N sequential round-trips. Used by the
 * /suppressions/import endpoint, which may receive tens of thousands of
 * addresses. Returns the number of rows processed.
 */
export async function addSuppressionsBulk(
  customerId: string,
  emails: string[],
  reason: 'hard_bounce' | 'complaint' | 'unsubscribe' | 'manual' | 'invalid',
  notes?: string,
  executor: DbExecutor = db
): Promise<number> {
  if (emails.length === 0) return 0;
  // De-dupe and normalize.
  const uniq = Array.from(new Set(emails.map((e) => e.toLowerCase())));

  // Postgres caps bound params at 65535; each row binds 4 columns, so cap the
  // chunk well under that (4000 rows * 4 = 16000 binds).
  const ROW_CHUNK = 4000;
  for (let i = 0; i < uniq.length; i += ROW_CHUNK) {
    const slice = uniq.slice(i, i + ROW_CHUNK);
    await executor
      .insertInto('suppressions')
      .values(slice.map((email) => ({ customer_id: customerId, email, reason, notes: notes ?? null })))
      .onConflict((oc) => oc.columns(['customer_id', 'email']).doNothing())
      .execute();

    // Append a consent-ledger row per address in the same chunk (append-only
    // audit for the bulk import).
    await executor
      .insertInto('consent_events')
      .values(slice.map((email) => ({
        customer_id: customerId,
        email,
        action: 'suppress' as const,
        reason,
        source: 'bulk_import',
        notes: notes ?? null,
        message_id: null,
      })))
      .execute();
  }

  // Pipeline the Redis cache writes (one round-trip per batch).
  const PIPE_CHUNK = 5000;
  for (let i = 0; i < uniq.length; i += PIPE_CHUNK) {
    const slice = uniq.slice(i, i + PIPE_CHUNK);
    const pipe = redis.pipeline();
    for (const email of slice) pipe.setex(key(customerId, email), SUPPRESSION_TTL_SECONDS, '1');
    await pipe.exec();
  }
  return uniq.length;
}

export async function removeSuppression(
  customerId: string,
  email: string,
  executor: DbExecutor = db,
  consent?: { source?: string; reason?: string }
): Promise<void> {
  const normalized = email.toLowerCase();
  const res = await executor
    .deleteFrom('suppressions')
    .where('customer_id', '=', customerId)
    .where('email', '=', normalized)
    .executeTakeFirst();

  // Only log an unsuppress event when a row was actually removed, so a no-op
  // delete (recipient wasn't suppressed) doesn't create a misleading ledger
  // entry. numDeletedRows is bigint-ish; coerce.
  if (Number(res?.numDeletedRows ?? 0) > 0) {
    await appendConsentEvent(executor, {
      customerId,
      email: normalized,
      action: 'unsuppress',
      reason: consent?.reason ?? 'resubscribe',
      source: consent?.source ?? 'api',
      notes: null,
      messageId: null,
    });
  }

  await redis.del(key(customerId, email));
}

/** Map an auto-suppression reason to its default originating source. */
function defaultSourceForReason(reason: string): string {
  switch (reason) {
    case 'hard_bounce': return 'bounce_escalation';
    case 'complaint': return 'complaint';
    case 'unsubscribe': return 'one_click_unsubscribe';
    default: return 'api';
  }
}

/** Append a single row to the append-only consent ledger. */
async function appendConsentEvent(
  executor: DbExecutor,
  ev: {
    customerId: string;
    email: string;
    action: 'suppress' | 'unsuppress';
    reason: string;
    source: string;
    notes: string | null;
    messageId: string | null;
  }
): Promise<void> {
  await executor
    .insertInto('consent_events')
    .values({
      customer_id: ev.customerId,
      email: ev.email,
      action: ev.action,
      reason: ev.reason,
      source: ev.source,
      notes: ev.notes,
      message_id: ev.messageId,
    })
    .execute();
}

/** Full consent history for a recipient under a customer, newest first. */
export async function getConsentHistory(
  customerId: string,
  email: string,
  executor: DbExecutor = db,
  limit = 200
): Promise<Array<{
  action: 'suppress' | 'unsuppress';
  reason: string;
  source: string;
  notes: string | null;
  message_id: string | null;
  created_at: Date;
}>> {
  const rows = await executor
    .selectFrom('consent_events')
    .select(['action', 'reason', 'source', 'notes', 'message_id', 'created_at'])
    .where('customer_id', '=', customerId)
    .where('email', '=', email.toLowerCase())
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(Math.min(Math.max(1, limit), 1000))
    .execute();
  return rows.map((r) => ({
    action: r.action as 'suppress' | 'unsuppress',
    reason: r.reason,
    source: r.source,
    notes: r.notes,
    message_id: r.message_id,
    created_at: r.created_at as unknown as Date,
  }));
}
