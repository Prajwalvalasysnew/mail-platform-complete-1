// Partition maintenance for the monthly-partitioned `events` table
// (DATABASE_10_10_PLAN Phase 1.1).
//
// Two responsibilities, both invoked from the worker scheduler:
//   - ensureEventPartitions: pre-create monthly partitions a few months ahead
//     so inserts never land in the default partition under normal operation.
//   - sweepExpiredEventPartitions: DROP partitions whose entire range is past
//     the event retention window — an O(1) metadata operation replacing
//     millions of row deletes. A partition containing any row covered by an
//     active legal hold is skipped (re-checked every run; the batched
//     row-level delete in runRetention keeps cleaning its non-held rows).
//
// The default partition (events_part_default) is a safety net only; rows in
// it mean partition pre-creation fell behind, surfaced via the
// mp_events_default_partition_rows gauge.

import { sql } from 'kysely';
import { db } from './db.js';

export const EVENT_PARTITION_PREFIX = 'events_part_';
const PARTITION_NAME_RE = /^events_part_(\d{6})$/;

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function partitionNameFor(month: Date): string {
  const y = month.getUTCFullYear();
  const m = String(month.getUTCMonth() + 1).padStart(2, '0');
  return `${EVENT_PARTITION_PREFIX}${y}${m}`;
}

/** The [start, end) range a partition name covers, or null if not ours. */
export function partitionRange(name: string): { start: Date; end: Date } | null {
  const m = PARTITION_NAME_RE.exec(name);
  if (!m?.[1]) return null;
  const year = Number(m[1].slice(0, 4));
  const month = Number(m[1].slice(4, 6));
  if (month < 1 || month > 12) return null;
  const start = new Date(Date.UTC(year, month - 1, 1));
  return { start, end: addMonths(start, 1) };
}

/**
 * Create the partition covering `month` if it doesn't exist. Safe to call
 * concurrently across replicas (IF NOT EXISTS; scheduler-lock protected
 * anyway). Only creates current-or-future months by default — backfilling a
 * month whose rows already sit in the default partition would fail Postgres's
 * default-partition constraint check.
 */
async function createPartitionFor(month: Date): Promise<boolean> {
  const name = partitionNameFor(month);
  const exists = await sql<{ found: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ${name}
    ) AS found
  `.execute(db);
  if (exists.rows[0]?.found) return false;
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.id(name)}
    PARTITION OF events
    FOR VALUES FROM (${sql.lit(ymd(month))}) TO (${sql.lit(ymd(addMonths(month, 1)))})
  `.execute(db);
  return true;
}

/** Pre-create partitions for the current month through `monthsAhead` months. */
export async function ensureEventPartitions(monthsAhead = 3): Promise<string[]> {
  const created: string[] = [];
  const base = monthStart(new Date());
  for (let i = 0; i <= monthsAhead; i++) {
    const month = addMonths(base, i);
    if (await createPartitionFor(month)) created.push(partitionNameFor(month));
  }
  return created;
}

/** List this table's monthly partitions (excludes the default partition). */
export async function listEventPartitions(): Promise<string[]> {
  const res = await sql<{ relname: string }>`
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'public' AND p.relname = 'events'
    ORDER BY c.relname
  `.execute(db);
  return res.rows.map((r) => r.relname).filter((name) => PARTITION_NAME_RE.test(name));
}

/** Rows sitting in the default partition (should be 0; alerting signal). */
export async function countDefaultPartitionRows(): Promise<number> {
  const res = await sql<{ count: string }>`
    SELECT COUNT(*)::text AS count FROM events_part_default
  `.execute(db);
  return Number(res.rows[0]?.count ?? 0);
}

export interface PartitionSweepResult {
  dropped: string[];
  /** Partitions past retention but kept because an active hold covers rows in them. */
  held: string[];
}

/**
 * Drop event partitions whose entire month range is older than the retention
 * cutoff. Hold-aware: a partition containing any event covered by an active
 * legal hold (tenant-wide, or recipient-scoped via the parent message) is
 * left attached and re-checked on the next sweep.
 */
export async function sweepExpiredEventPartitions(
  retentionDays = Number(process.env.RETENTION_EVENT_DAYS ?? 90),
): Promise<PartitionSweepResult> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const dropped: string[] = [];
  const held: string[] = [];

  for (const name of await listEventPartitions()) {
    const range = partitionRange(name);
    if (!range || range.end.getTime() > cutoff.getTime()) continue;

    const heldRows = await sql<{ found: boolean }>`
      SELECT EXISTS (
        SELECT 1
        FROM ${sql.id(name)} e
        LEFT JOIN messages m ON m.message_id = e.message_id
        WHERE EXISTS (
          SELECT 1 FROM legal_holds h
          WHERE h.released_at IS NULL
            AND h.customer_id = e.customer_id
            AND (h.scope = 'customer'
                 OR (m.to_address IS NOT NULL
                     AND h.scope = 'recipient:' || lower(m.to_address)))
        )
      ) AS found
    `.execute(db);
    if (heldRows.rows[0]?.found) {
      held.push(name);
      continue;
    }

    // DETACH first so the drop itself never holds the parent's lock while
    // scanning; both are metadata-only and fast.
    await sql`ALTER TABLE events DETACH PARTITION ${sql.id(name)}`.execute(db);
    await sql`DROP TABLE ${sql.id(name)}`.execute(db);
    dropped.push(name);
  }

  return { dropped, held };
}
