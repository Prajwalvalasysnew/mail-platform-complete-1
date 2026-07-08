// Audit / activity logging.
//
// Writes structured, attributed events to audit_log and reads them back for a
// customer-facing account "activity log". Two write helpers:
//   recordAudit      — awaitable; use when the caller wants to surface failures
//   recordAuditSafe  — fire-and-forget; use in user-facing flows where an audit
//                      write must never block or fail the action it describes
//
// Internal admin actions (action prefixed "admin:") are written by admin.ts and
// are deliberately hidden from the customer-facing feed below.

import { sql } from 'kysely';
import { db } from './db.js';

export type ActorType = 'user' | 'api_key' | 'admin' | 'system';

export interface RecordAuditInput {
  customerId?: string | null;
  actorType: ActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  resource?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  apiKeyId?: string | null;
}

import { createHash } from 'node:crypto';

// Genesis hash for the first link of any chain (SHA-256 of a fixed label).
const AUDIT_GENESIS_HASH = createHash('sha256').update('mail-platform-audit-genesis').digest('hex');

/**
 * Canonical serialization of the immutable audit fields that the row_hash
 * commits to. Order and formatting are fixed so the hash is reproducible during
 * verification. metadata is JSON-stringified with sorted keys for determinism.
 */
export function canonicalAuditPayload(row: {
  id: number | string;
  customer_id: string | null;
  api_key_id: string | null;
  actor_type: string | null;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  resource: string | null;
  ip: string | null;
  metadata: unknown;
  occurred_at: unknown;
}): string {
  const occurred = row.occurred_at instanceof Date ? row.occurred_at.toISOString() : String(row.occurred_at);
  return JSON.stringify([
    String(row.id),
    row.customer_id ?? '',
    row.api_key_id ?? '',
    row.actor_type ?? '',
    row.actor_id ?? '',
    row.actor_label ?? '',
    row.action,
    row.resource ?? '',
    row.ip ?? '',
    stableStringify(row.metadata ?? {}),
    occurred,
  ]);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

function computeRowHash(previousHash: string, payload: string): string {
  return createHash('sha256').update(previousHash).update('\n').update(payload).digest('hex');
}

// A stable 64-bit key for the per-chain advisory lock, derived from chain_key.
function chainLockKey(chainKey: string): bigint {
  const h = createHash('sha256').update(`audit-chain:${chainKey}`).digest();
  // Take the low 63 bits so it fits a signed bigint for pg_advisory_xact_lock.
  return h.readBigUInt64BE(0) & 0x7fffffffffffffffn;
}

export async function recordAudit(input: RecordAuditInput): Promise<void> {
  const chainKey = input.customerId ?? 'system';
  await db.transaction().execute(async (trx) => {
    // Insert the audit row first to get its id + server-assigned occurred_at.
    const row = await trx
      .insertInto('audit_log')
      .values({
        customer_id: input.customerId ?? null,
        api_key_id: input.apiKeyId ?? null,
        actor_type: input.actorType,
        actor_id: input.actorId ?? null,
        actor_label: input.actorLabel ?? null,
        action: input.action,
        resource: input.resource ?? null,
        ip: input.ip ?? null,
        metadata: input.metadata ?? {},
      })
      .returning(['id', 'customer_id', 'api_key_id', 'actor_type', 'actor_id', 'actor_label', 'action', 'resource', 'ip', 'metadata', 'occurred_at'])
      .executeTakeFirstOrThrow();

    // Serialize hash-chain appends for THIS chain so concurrent audit writes
    // can't fork it (two writers both reading the same "previous" link). The
    // xact-scoped advisory lock is released at commit.
    await sql`SELECT pg_advisory_xact_lock(${chainLockKey(chainKey).toString()}::bigint)`.execute(trx);

    const prev = await trx
      .selectFrom('audit_log_hashes')
      .select(['seq', 'row_hash'])
      .where('chain_key', '=', chainKey)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();

    const previousHash = prev?.row_hash ?? AUDIT_GENESIS_HASH;
    const seq = (prev ? Number(prev.seq) : 0) + 1;
    const rowHash = computeRowHash(previousHash, canonicalAuditPayload(row as any));

    await trx
      .insertInto('audit_log_hashes')
      .values({ audit_id: row.id, chain_key: chainKey, seq, previous_hash: previousHash, row_hash: rowHash })
      .execute();
  });
}

/** Best-effort audit write: never throws into the caller's flow. */
export function recordAuditSafe(input: RecordAuditInput): void {
  recordAudit(input).catch(() => {
    // Swallowed on purpose; a failed audit write must not break login etc.
    // A durable-audit upgrade (outbox) is tracked in the roadmap.
  });
}

export interface AuditQueryRaw {
  action?: string;
  actor_type?: string;
  days?: string | number;
  limit?: string | number;
  before?: string | number;
}

export interface AuditQuery {
  action?: string;
  actorType?: ActorType;
  sinceDays: number;
  limit: number;
  before?: number;
}

const ACTOR_TYPES: ActorType[] = ['user', 'api_key', 'admin', 'system'];

/** Validate + clamp raw query params into a safe AuditQuery (pure; unit-tested). */
export function normalizeAuditQuery(raw: AuditQueryRaw): AuditQuery {
  const intOr = (v: unknown, fallback: number, min: number, max: number): number => {
    const n = parseInt(String(v ?? ''), 10);
    if (!Number.isFinite(n) || n < min) return fallback;
    return Math.min(n, max);
  };
  const beforeN = parseInt(String(raw.before ?? ''), 10);
  return {
    action: typeof raw.action === 'string' && raw.action.length ? raw.action.slice(0, 100) : undefined,
    actorType: ACTOR_TYPES.includes(raw.actor_type as ActorType) ? (raw.actor_type as ActorType) : undefined,
    sinceDays: intOr(raw.days, 90, 1, 365),
    limit: intOr(raw.limit, 50, 1, 200),
    before: Number.isFinite(beforeN) && beforeN > 0 ? beforeN : undefined,
  };
}

export interface AuditEntry {
  id: number;
  action: string;
  resource: string | null;
  actor_type: string | null;
  actor_label: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  occurred_at: Date;
}

/**
 * Customer-facing activity feed for one org, newest first, id-cursor paginated.
 * Internal admin:* actions are excluded.
 */
export async function listCustomerAudit(
  customerId: string,
  q: AuditQuery
): Promise<{ entries: AuditEntry[]; next_cursor: number | null }> {
  let query = db
    .selectFrom('audit_log')
    .select(['id', 'action', 'resource', 'actor_type', 'actor_label', 'ip', 'metadata', 'occurred_at'])
    .where('customer_id', '=', customerId)
    .where('action', 'not like', 'admin:%')
    .where(sql<boolean>`occurred_at >= (NOW() - ${q.sinceDays} * INTERVAL '1 day')`);

  if (q.action) query = query.where('action', '=', q.action);
  if (q.actorType) query = query.where('actor_type', '=', q.actorType);
  if (q.before) query = query.where('id', '<', q.before);

  const rows = (await query.orderBy('id', 'desc').limit(q.limit + 1).execute()) as unknown as AuditEntry[];
  const hasMore = rows.length > q.limit;
  const entries = hasMore ? rows.slice(0, q.limit) : rows;
  return { entries, next_cursor: hasMore ? entries.at(-1)!.id : null };
}

// ─── Tamper-evidence: chain verification (gap analysis #10) ──────────────────

export interface AuditChainVerifyResult {
  chain_key: string;
  ok: boolean;
  links_checked: number;
  // On failure, the audit_id + seq where the chain first diverges, and why.
  broken_at?: { audit_id: number; seq: number; reason: 'row_hash_mismatch' | 'previous_hash_mismatch' | 'missing_audit_row' | 'sequence_gap' };
}

/**
 * Re-walk a customer's audit hash chain and confirm it is intact. Recomputes
 * each row_hash from the (immutable) audit row + the prior link's hash and
 * checks it matches what's stored, and that previous_hash pointers are
 * consistent. Any tampering — an altered audit row, a deleted row, a reordered
 * or spliced chain — surfaces as the first broken link.
 *
 * `chainKey` is the customer id, or 'system' for the null-customer chain.
 */
export async function verifyAuditChain(chainKey: string): Promise<AuditChainVerifyResult> {
  const links = await db
    .selectFrom('audit_log_hashes')
    .select(['audit_id', 'seq', 'previous_hash', 'row_hash'])
    .where('chain_key', '=', chainKey)
    .orderBy('seq', 'asc')
    .execute();

  let expectedPrev = AUDIT_GENESIS_HASH;
  let expectedSeq = 1;

  for (const link of links) {
    const seq = Number(link.seq);
    if (seq !== expectedSeq) {
      return { chain_key: chainKey, ok: false, links_checked: expectedSeq - 1, broken_at: { audit_id: link.audit_id, seq, reason: 'sequence_gap' } };
    }
    if (link.previous_hash !== expectedPrev) {
      return { chain_key: chainKey, ok: false, links_checked: expectedSeq - 1, broken_at: { audit_id: link.audit_id, seq, reason: 'previous_hash_mismatch' } };
    }

    const row = await db
      .selectFrom('audit_log')
      .select(['id', 'customer_id', 'api_key_id', 'actor_type', 'actor_id', 'actor_label', 'action', 'resource', 'ip', 'metadata', 'occurred_at'])
      .where('id', '=', link.audit_id)
      .executeTakeFirst();
    if (!row) {
      return { chain_key: chainKey, ok: false, links_checked: expectedSeq - 1, broken_at: { audit_id: link.audit_id, seq, reason: 'missing_audit_row' } };
    }

    const recomputed = computeRowHash(link.previous_hash, canonicalAuditPayload(row as any));
    if (recomputed !== link.row_hash) {
      return { chain_key: chainKey, ok: false, links_checked: expectedSeq - 1, broken_at: { audit_id: link.audit_id, seq, reason: 'row_hash_mismatch' } };
    }

    expectedPrev = link.row_hash;
    expectedSeq += 1;
  }

  return { chain_key: chainKey, ok: true, links_checked: links.length };
}
