// Partition maintenance for the monthly-partitioned firehose tables
// (`events` — Phase 1.1, `messages` — Phase 1.2 of DATABASE_10_10_PLAN).
//
// Two responsibilities, both invoked from the worker scheduler:
//   - ensure*Partitions: pre-create monthly partitions a few months ahead so
//     inserts never land in the default partition under normal operation.
//   - sweepExpired*Partitions: DROP partitions whose entire range is past the
//     table's retention window — an O(1) metadata operation replacing
//     millions of row deletes. A partition containing any row covered by an
//     active legal hold is skipped (re-checked every run; the batched
//     row-level deletes in runRetention keep cleaning its non-held rows).
//
// The default partitions (<table>_part_default) are safety nets only; rows in
// them mean partition pre-creation fell behind, surfaced via the
// mp_events_default_partition_rows / mp_messages_default_partition_rows gauges.

import { sql, type RawBuilder } from 'kysely';
import { db } from './db.js';

interface PartitionedTable {
  parent: 'events' | 'messages';
  prefix: string;
  nameRe: RegExp;
  defaultPartition: string;
  retentionDaysEnv: string;
  retentionDaysDefault: number;
  /** EXISTS(...) probe: does this partition contain rows under an active hold? */
  holdProbe: (partition: RawBuilder<unknown>) => RawBuilder<{ found: boolean }>;
}

const EVENTS: PartitionedTable = {
  parent: 'events',
  prefix: 'events_part_',
  nameRe: /^events_part_(\d{6})$/,
  defaultPartition: 'events_part_default',
  retentionDaysEnv: 'RETENTION_EVENT_DAYS',
  retentionDaysDefault: 90,
  // Recipient-scope holds resolve through the parent message; tenant-wide
  // holds match on customer_id directly.
  holdProbe: (partition) => sql<{ found: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM ${partition} e
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
  `,
};

const MESSAGES: PartitionedTable = {
  parent: 'messages',
  prefix: 'messages_part_',
  nameRe: /^messages_part_(\d{6})$/,
  defaultPartition: 'messages_part_default',
  retentionDaysEnv: 'RETENTION_MESSAGE_DAYS',
  retentionDaysDefault: 395,
  holdProbe: (partition) => sql<{ found: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM ${partition} m
      WHERE EXISTS (
        SELECT 1 FROM legal_holds h
        WHERE h.released_at IS NULL
          AND h.customer_id = m.customer_id
          AND (h.scope = 'customer'
               OR h.scope = 'recipient:' || lower(m.to_address))
      )
    ) AS found
  `,
};

export const EVENT_PARTITION_PREFIX = EVENTS.prefix;
export const MESSAGE_PARTITION_PREFIX = MESSAGES.prefix;

function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function partitionNameFor(t: PartitionedTable, month: Date): string {
  const y = month.getUTCFullYear();
  const m = String(month.getUTCMonth() + 1).padStart(2, '0');
  return `${t.prefix}${y}${m}`;
}

function rangeFor(t: PartitionedTable, name: string): { start: Date; end: Date } | null {
  const m = t.nameRe.exec(name);
  if (!m?.[1]) return null;
  const year = Number(m[1].slice(0, 4));
  const month = Number(m[1].slice(4, 6));
  if (month < 1 || month > 12) return null;
  const start = new Date(Date.UTC(year, month - 1, 1));
  return { start, end: addMonths(start, 1) };
}

/** The [start, end) range a managed events-partition name covers, or null. */
export function partitionRange(name: string): { start: Date; end: Date } | null {
  return rangeFor(EVENTS, name) ?? rangeFor(MESSAGES, name);
}

async function createPartitionFor(t: PartitionedTable, month: Date): Promise<boolean> {
  const name = partitionNameFor(t, month);
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
    PARTITION OF ${sql.id(t.parent)}
    FOR VALUES FROM (${sql.lit(ymd(month))}) TO (${sql.lit(ymd(addMonths(month, 1)))})
  `.execute(db);
  return true;
}

async function ensurePartitions(t: PartitionedTable, monthsAhead: number): Promise<string[]> {
  const created: string[] = [];
  const base = monthStart(new Date());
  for (let i = 0; i <= monthsAhead; i++) {
    const month = addMonths(base, i);
    if (await createPartitionFor(t, month)) created.push(partitionNameFor(t, month));
  }
  return created;
}

async function listPartitions(t: PartitionedTable): Promise<string[]> {
  const res = await sql<{ relname: string }>`
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_namespace n ON n.oid = p.relnamespace
    WHERE n.nspname = 'public' AND p.relname = ${t.parent}
    ORDER BY c.relname
  `.execute(db);
  return res.rows.map((r) => r.relname).filter((name) => t.nameRe.test(name));
}

async function countDefaultRows(t: PartitionedTable): Promise<number> {
  const res = await sql<{ count: string }>`
    SELECT COUNT(*)::text AS count FROM ${sql.id(t.defaultPartition)}
  `.execute(db);
  return Number(res.rows[0]?.count ?? 0);
}

export interface PartitionSweepResult {
  dropped: string[];
  /** Partitions past retention but kept because an active hold covers rows in them. */
  held: string[];
}

async function sweepExpiredPartitions(
  t: PartitionedTable,
  retentionDays?: number,
): Promise<PartitionSweepResult> {
  const days = retentionDays ?? Number(process.env[t.retentionDaysEnv] ?? t.retentionDaysDefault);
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const dropped: string[] = [];
  const held: string[] = [];

  for (const name of await listPartitions(t)) {
    const range = rangeFor(t, name);
    if (!range || range.end.getTime() > cutoff.getTime()) continue;

    const heldRows = await t.holdProbe(sql.id(name)).execute(db);
    if ((heldRows.rows[0] as { found?: boolean } | undefined)?.found) {
      held.push(name);
      continue;
    }

    // DETACH first so the drop itself never holds the parent's lock while
    // scanning; both are metadata-only and fast.
    await sql`ALTER TABLE ${sql.id(t.parent)} DETACH PARTITION ${sql.id(name)}`.execute(db);
    await sql`DROP TABLE ${sql.id(name)}`.execute(db);
    dropped.push(name);
  }

  return { dropped, held };
}

// ---- events ----
export const ensureEventPartitions = (monthsAhead = 3) => ensurePartitions(EVENTS, monthsAhead);
export const listEventPartitions = () => listPartitions(EVENTS);
export const countDefaultPartitionRows = () => countDefaultRows(EVENTS);
export const sweepExpiredEventPartitions = (retentionDays?: number) =>
  sweepExpiredPartitions(EVENTS, retentionDays);

// ---- messages ----
export const ensureMessagePartitions = (monthsAhead = 3) => ensurePartitions(MESSAGES, monthsAhead);
export const listMessagePartitions = () => listPartitions(MESSAGES);
export const countMessageDefaultPartitionRows = () => countDefaultRows(MESSAGES);
export const sweepExpiredMessagePartitions = (retentionDays?: number) =>
  sweepExpiredPartitions(MESSAGES, retentionDays);
