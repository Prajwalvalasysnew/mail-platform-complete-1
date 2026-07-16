// Self-serve data exports (DATABASE_10_10_PLAN Phase 2.2).
//
// POST /v1/exports creates a data_exports row and enqueues a job; the exports
// worker calls runDataExport() to stream the tenant's events or message
// metadata for a date range into NDJSON, stored via the body object store
// (fs/s3) or inline in the row when BODY_STORAGE=inline (dev/test). The
// download endpoint streams it back. Artifacts age out with
// RETENTION_EXPORT_DAYS (default 7) in the retention sweep.
//
// The export range is clamped to the tenant's retention visibility window
// (Phase 2.1) when one is configured, so an export can never return history
// the API itself would hide.

import { sql } from 'kysely';
import { db } from './db.js';
import type { DbExecutor } from './db.js';
import { exportsQueue } from './queues.js';
import { getBodyStore } from './storage.js';
import { resolveTenantRetention } from './retention-policy.js';

export type ExportKind = 'events' | 'messages';

export interface DataExportRow {
  id: string;
  customer_id: string;
  kind: ExportKind;
  range_from: Date;
  range_to: Date;
  status: 'pending' | 'running' | 'completed' | 'failed';
  row_count: number | null;
  size_bytes: number | null;
  truncated: boolean;
  object_key: string | null;
  payload: string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

const MAX_RANGE_DAYS = () => Number(process.env.EXPORT_MAX_RANGE_DAYS ?? 92);
const MAX_ROWS = () => Number(process.env.EXPORT_MAX_ROWS ?? 100_000);
const BATCH = 5_000;

export class ExportValidationError extends Error {}

export async function createDataExport(
  input: { customerId: string; kind: ExportKind; from: Date; to: Date },
  executor: DbExecutor = db,
): Promise<DataExportRow> {
  const { customerId, kind } = input;
  let { from, to } = input;
  if (!(from instanceof Date) || Number.isNaN(from.getTime()) || !(to instanceof Date) || Number.isNaN(to.getTime())) {
    throw new ExportValidationError('from/to must be valid timestamps');
  }
  if (from >= to) throw new ExportValidationError('from must be before to');
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS() * 86_400_000) {
    throw new ExportValidationError(`range too large (max ${MAX_RANGE_DAYS()} days)`);
  }

  // Clamp to the tenant's visibility window when one is configured.
  const windows = await resolveTenantRetention(customerId, executor);
  if (windows.explicit) {
    const floor = new Date(Date.now() - windows.eventsDays * 86_400_000);
    if (from < floor) from = floor;
    if (to < floor) throw new ExportValidationError('range is entirely outside your plan retention window');
  }

  const row = await executor
    .insertInto('data_exports')
    .values({
      customer_id: customerId,
      kind,
      range_from: from as any,
      range_to: to as any,
    } as any)
    .returningAll()
    .executeTakeFirstOrThrow();

  // Best-effort enqueue; drainStalePendingExports() rescues on Redis blips.
  try {
    await exportsQueue.add('export', { export_id: String(row.id), customer_id: customerId });
  } catch {
    /* row stays 'pending'; the scheduler sweep re-enqueues it */
  }
  return row as unknown as DataExportRow;
}

/** Re-enqueue pending exports that never made it onto the queue. */
export async function drainStalePendingExports(staleMinutes = 5): Promise<number> {
  const rows = await db
    .selectFrom('data_exports')
    .select(['id', 'customer_id'])
    .where('status', '=', 'pending')
    .where(sql<boolean>`created_at < NOW() - make_interval(mins => ${staleMinutes})`)
    .limit(100)
    .execute();
  let enqueued = 0;
  for (const r of rows) {
    // jobId dedupes with the original enqueue if it did land.
    await exportsQueue.add(
      'export',
      { export_id: String(r.id), customer_id: String(r.customer_id) },
      { jobId: `export-${r.id}` },
    );
    enqueued++;
  }
  return enqueued;
}

function ndjsonLine(o: Record<string, unknown>): string {
  return JSON.stringify(o) + '\n';
}

/**
 * Execute one export end-to-end. Idempotent-ish: claims pending→running, and
 * a re-run of a stuck 'running' row (worker crash) is allowed via reclaim.
 */
export async function runDataExport(exportId: string): Promise<DataExportRow | null> {
  const claimed = await db
    .updateTable('data_exports')
    .set({ status: 'running', started_at: new Date() })
    .where('id', '=', exportId)
    .where('status', 'in', ['pending', 'running'])
    .returningAll()
    .executeTakeFirst();
  if (!claimed) return null; // already completed/failed or unknown

  const exp = claimed as unknown as DataExportRow;
  try {
    const maxRows = MAX_ROWS();
    let lines = '';
    let count = 0;
    let truncated = false;

    if (exp.kind === 'events') {
      let lastId = 0;
      for (;;) {
        const batch = await db
          .selectFrom('events')
          .select(['id', 'message_id', 'event_type', 'occurred_at', 'ip', 'user_agent', 'bot_verdict', 'payload'])
          .where('customer_id', '=', exp.customer_id)
          .where('occurred_at', '>=', exp.range_from as any)
          .where('occurred_at', '<', exp.range_to as any)
          .where('id', '>', lastId as any)
          .orderBy('id', 'asc')
          .limit(Math.min(BATCH, maxRows - count + 1))
          .execute();
        if (batch.length === 0) break;
        for (const e of batch) {
          if (count >= maxRows) { truncated = true; break; }
          lines += ndjsonLine({
            id: Number(e.id),
            message_id: e.message_id,
            event_type: e.event_type,
            occurred_at: e.occurred_at,
            ip: e.ip,
            user_agent: e.user_agent,
            bot_verdict: e.bot_verdict,
            payload: e.payload,
          });
          count++;
        }
        if (truncated) break;
        lastId = Number(batch[batch.length - 1]!.id);
      }
    } else {
      let cursor: { ts: Date; id: string } | null = null;
      for (;;) {
        let q = db
          .selectFrom('messages')
          .select(['id', 'message_id', 'from_address', 'to_address', 'subject', 'status', 'tags',
                   'queued_at', 'accepted_at', 'delivered_at', 'bounced_at', 'opened_at', 'first_clicked_at'])
          .where('customer_id', '=', exp.customer_id)
          .where('queued_at', '>=', exp.range_from as any)
          .where('queued_at', '<', exp.range_to as any);
        if (cursor) {
          q = q.where(sql<boolean>`(queued_at, id) > (${cursor.ts.toISOString()}::timestamptz, ${cursor.id}::uuid)`);
        }
        const batch = await q
          .orderBy('queued_at', 'asc')
          .orderBy('id', 'asc')
          .limit(Math.min(BATCH, maxRows - count + 1))
          .execute();
        if (batch.length === 0) break;
        for (const m of batch) {
          if (count >= maxRows) { truncated = true; break; }
          lines += ndjsonLine({
            message_id: m.message_id,
            from_address: m.from_address,
            to_address: m.to_address,
            subject: m.subject,
            status: m.status,
            tags: m.tags,
            queued_at: m.queued_at,
            accepted_at: m.accepted_at,
            delivered_at: m.delivered_at,
            bounced_at: m.bounced_at,
            opened_at: m.opened_at,
            first_clicked_at: m.first_clicked_at,
          });
          count++;
        }
        if (truncated) break;
        const last = batch[batch.length - 1]!;
        cursor = { ts: new Date(last.queued_at as unknown as string), id: String(last.id) };
      }
    }

    const store = getBodyStore();
    let objectKey: string | null = null;
    let payload: string | null = null;
    if (store.kind === 'inline') {
      payload = lines;
    } else {
      const stored = await store.put({ text: lines });
      objectKey = stored.object_key ?? null;
    }

    const done = await db
      .updateTable('data_exports')
      .set({
        status: 'completed',
        row_count: count,
        size_bytes: Buffer.byteLength(lines),
        truncated,
        object_key: objectKey,
        payload,
        completed_at: new Date(),
        error: null,
      })
      .where('id', '=', exportId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return done as unknown as DataExportRow;
  } catch (err) {
    const failed = await db
      .updateTable('data_exports')
      .set({ status: 'failed', error: String((err as Error).message ?? err), completed_at: new Date() })
      .where('id', '=', exportId)
      .returningAll()
      .executeTakeFirst();
    return (failed as unknown as DataExportRow) ?? null;
  }
}

/** Read a completed export's NDJSON payload (from the row or the store). */
export async function readExportPayload(exp: Pick<DataExportRow, 'object_key' | 'payload'>): Promise<string> {
  if (exp.payload != null) return exp.payload;
  if (exp.object_key) {
    const body = await getBodyStore().get(exp.object_key);
    return body.text ?? '';
  }
  return '';
}

/** Purge expired exports (rows + their stored objects). Used by runRetention. */
export async function purgeExpiredExports(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const rows = await db
    .selectFrom('data_exports')
    .select(['id', 'object_key'])
    .where('created_at', '<', cutoff as any)
    .execute();
  if (rows.length === 0) return 0;
  const store = getBodyStore();
  const expiredIds = new Set(rows.map((r) => String(r.id)));
  for (const r of rows) {
    const key = r.object_key ? String(r.object_key) : null;
    if (!key) continue;
    // The store is content-addressed and shared with message bodies, so an
    // identical payload can share a key with a live body or another export.
    // Only delete the object when nothing live still references it.
    const bodyRef = await db
      .selectFrom('messages')
      .select('id')
      .where('body_object_key', '=', key)
      .limit(1)
      .executeTakeFirst();
    if (bodyRef) continue;
    const exportRefs = await db
      .selectFrom('data_exports')
      .select('id')
      .where('object_key', '=', key)
      .execute();
    if (exportRefs.some((e) => !expiredIds.has(String(e.id)))) continue;
    try { await store.delete(key); } catch { /* object retry is best-effort; the row still purges */ }
  }
  const res = await db
    .deleteFrom('data_exports')
    .where('id', 'in', rows.map((r) => String(r.id)))
    .executeTakeFirst();
  return Number(res?.numDeletedRows ?? 0);
}
