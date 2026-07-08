// Idempotency support for POST /v1/send.
//
// A client supplies an `Idempotency-Key` header. The first request with a
// given (customer_id, key) executes normally and its response is recorded.
// Any retry with the same key replays the stored response instead of sending
// again. A retry with the SAME key but a DIFFERENT body is a client error
// (the key was reused for a different request) and returns 422.
//
// Records are retained for IDEMPOTENCY_TTL_HOURS and swept by a periodic job.

import crypto from 'node:crypto';
import { sql } from 'kysely';
import { db } from './db.js';

export interface IdempotencyHit {
  status_code: number;
  response_body: Record<string, unknown>;
}

function stableStringify(obj: any): string {
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj)) {
      return `[${obj.map(stableStringify).join(',')}]`;
    }
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `"${k}":${stableStringify(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(obj ?? null);
}

export function hashRequestBody(body: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(body)).digest('hex');
}

export type IdempotencyLookup =
  | { kind: 'replay'; status_code: number; response_body: Record<string, unknown> }
  | { kind: 'conflict' } // same key, different body
  | { kind: 'in_progress' } // first request still running
  | { kind: 'proceed' }; // we reserved the key; caller should run + record

/**
 * Reserve an idempotency key. Returns what the caller should do.
 * Atomic via an INSERT ... ON CONFLICT DO NOTHING: exactly one concurrent
 * request wins the reservation; the rest see the existing row.
 */
export async function reserveIdempotencyKey(
  customerId: string,
  key: string,
  requestHash: string
): Promise<IdempotencyLookup> {
  const inserted = await db
    .insertInto('idempotency_keys')
    .values({ customer_id: customerId, idempotency_key: key, request_hash: requestHash })
    .onConflict((oc) => oc.columns(['customer_id', 'idempotency_key']).doNothing())
    .returning('id')
    .executeTakeFirst();

  if (inserted) return { kind: 'proceed' };

  // Row already exists — fetch it.
  const existing = await db
    .selectFrom('idempotency_keys')
    .select(['request_hash', 'status_code', 'response_body'])
    .where('customer_id', '=', customerId)
    .where('idempotency_key', '=', key)
    .executeTakeFirst();

  if (!existing) return { kind: 'proceed' }; // race: row vanished, let caller retry path
  if (existing.request_hash !== requestHash) return { kind: 'conflict' };
  if (existing.status_code == null) return { kind: 'in_progress' };
  return {
    kind: 'replay',
    status_code: existing.status_code,
    response_body: (existing.response_body ?? {}) as Record<string, unknown>,
  };
}

export async function recordIdempotentResponse(
  customerId: string,
  key: string,
  statusCode: number,
  responseBody: Record<string, unknown>
): Promise<void> {
  await db
    .updateTable('idempotency_keys')
    .set({ status_code: statusCode, response_body: responseBody, completed_at: new Date() })
    .where('customer_id', '=', customerId)
    .where('idempotency_key', '=', key)
    .execute();
}

/** Delete keys older than the retention window. Call periodically. */
export async function sweepIdempotencyKeys(ttlHours = Number(process.env.IDEMPOTENCY_TTL_HOURS ?? 24)): Promise<number> {
  const cutoff = new Date(Date.now() - ttlHours * 3600_000);
  const res = await db
    .deleteFrom('idempotency_keys')
    .where(sql<boolean>`created_at < ${cutoff}`)
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0);
}
