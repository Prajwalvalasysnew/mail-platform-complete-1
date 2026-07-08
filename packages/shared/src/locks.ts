import crypto from 'node:crypto';
import { sql } from 'kysely';
import { db } from './db.js';

const SCHEDULER_LOCK_NAMESPACE = 7319;

function advisoryKey(name: string): number {
  const digest = crypto.createHash('sha256').update(name).digest();
  return digest.readInt32BE(0);
}

/**
 * Run a task only when this process owns the named Postgres advisory lock.
 * The xact-scoped lock releases automatically on commit/rollback, including
 * errors, which makes it safe for horizontally scaled worker replicas.
 */
export async function withSchedulerLock<T>(
  name: string,
  task: () => Promise<T>
): Promise<{ ran: true; result: T } | { ran: false }> {
  return db.transaction().execute(async (trx) => {
    const res = await sql<{ locked: boolean }>`
      SELECT pg_try_advisory_xact_lock(${SCHEDULER_LOCK_NAMESPACE}, ${advisoryKey(name)}) AS locked
    `.execute(trx);

    if (!res.rows[0]?.locked) return { ran: false };
    const result = await task();
    return { ran: true, result };
  });
}
