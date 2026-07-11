// ClickHouse analytics reconciliation (gap analysis Top-20 #13).
//
// The live dual-write to ClickHouse is best-effort (in-memory batched), so an
// outage or a worker crash can drop analytics rows. Postgres `events` is the
// DURABLE source of truth. This reconciler ships any events with id greater than
// the stored watermark to ClickHouse and advances the watermark only on a
// confirmed insert — so ClickHouse becomes eventually consistent with Postgres
// and no event is permanently lost. Run periodically from the worker scheduler.

import { db } from './db.js';
import { clickhouseEnabled, filterNonErasedClickhouseRows, insertClickhouseRows } from './clickhouse.js';

export interface ReconcileResult {
  ran: boolean;                 // false when ClickHouse is not configured
  shipped: number;              // rows shipped to ClickHouse this run
  fromEventId: string;          // watermark before this run
  toEventId: string;            // watermark after this run
  batches: number;
  failed?: boolean;             // true if a batch insert failed (watermark not advanced past it)
}

const DEFAULT_BATCH = Number(process.env.CLICKHOUSE_RECONCILE_BATCH ?? 1000);
const DEFAULT_MAX_BATCHES = Number(process.env.CLICKHOUSE_RECONCILE_MAX_BATCHES ?? 50);

/**
 * Ship events past the watermark to ClickHouse. Processes up to
 * maxBatches * batchSize events per run (bounded work); the next run continues
 * from the advanced watermark. Safe to run concurrently-ish: it advances the
 * watermark monotonically and ClickHouse inserts of the same rows are
 * idempotent for an append-only analytics table used with de-dup at query time
 * (or a ReplacingMergeTree keyed on (message_id,event_type,occurred_at)).
 */
export async function reconcileClickhouse(opts: { batchSize?: number; maxBatches?: number } = {}): Promise<ReconcileResult> {
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
  const maxBatches = Math.max(1, opts.maxBatches ?? DEFAULT_MAX_BATCHES);

  if (!clickhouseEnabled()) {
    return { ran: false, shipped: 0, fromEventId: '0', toEventId: '0', batches: 0 };
  }

  // Read the current watermark (single-row state table).
  const state = await db
    .selectFrom('clickhouse_sync_state')
    .select(['last_synced_event_id'])
    .where('id', '=', 1)
    .executeTakeFirst();
  let watermark = BigInt(state?.last_synced_event_id ?? '0');
  const startWatermark = watermark;

  let shipped = 0;
  let batches = 0;
  let failed = false;

  for (let i = 0; i < maxBatches; i++) {
    const rows = await db
      .selectFrom('events')
      .select(['id', 'message_id', 'customer_id', 'event_type', 'occurred_at', 'ip', 'payload'])
      .where('id', '>', Number(watermark))
      .orderBy('id', 'asc')
      .limit(batchSize)
      .execute();

    if (rows.length === 0) break;

    const chRows = await filterNonErasedClickhouseRows(rows.map((r) => ({
      event_id: Number(r.id), // same idempotency key the hot-path emits → CH dedups the pair
      message_id: r.message_id,
      customer_id: r.customer_id,
      event_type: r.event_type,
      occurred_at: (r.occurred_at instanceof Date ? r.occurred_at : new Date(r.occurred_at as any)).toISOString(),
      ip: (r.ip as string | null) ?? null,
      payload: JSON.stringify(r.payload ?? {}),
    })));

    const ok = await insertClickhouseRows(chRows);
    if (!ok) {
      // Stop and DO NOT advance past this batch — the next run retries from the
      // same watermark. This is what makes the pipeline durable: a failed ship
      // is retried, never silently dropped.
      failed = true;
      break;
    }

    // Advance watermark to the max id in this batch.
    const maxId = rows.reduce((m, r) => (BigInt(r.id) > m ? BigInt(r.id) : m), watermark);
    watermark = maxId;
    shipped += chRows.length;
    batches++;

    // Persist the advanced watermark after each successful batch, so a crash
    // mid-run doesn't re-ship everything (at-least-once, bounded re-work).
    await db
      .updateTable('clickhouse_sync_state')
      .set({ last_synced_event_id: watermark.toString(), last_run_at: new Date() as any, last_shipped_count: shipped.toString(), updated_at: new Date() as any })
      .where('id', '=', 1)
      .execute();

    if (rows.length < batchSize) break; // caught up
  }

  // Even on a no-op run, stamp last_run_at for observability.
  if (batches === 0) {
    await db.updateTable('clickhouse_sync_state').set({ last_run_at: new Date() as any, updated_at: new Date() as any }).where('id', '=', 1).execute();
  }

  return {
    ran: true,
    shipped,
    fromEventId: startWatermark.toString(),
    toEventId: watermark.toString(),
    batches,
    ...(failed ? { failed } : {}),
  };
}

/** Observability: how far behind is ClickHouse (events in PG not yet shipped)? */
export async function clickhouseSyncLag(): Promise<{ watermark: string; maxEventId: string; lag: number }> {
  const state = await db.selectFrom('clickhouse_sync_state').select(['last_synced_event_id']).where('id', '=', 1).executeTakeFirst();
  const maxRow = await db.selectFrom('events').select(({ fn }) => fn.max('id').as('maxId')).executeTakeFirst();
  const watermark = BigInt(state?.last_synced_event_id ?? '0');
  const maxId = BigInt((maxRow?.maxId as any) ?? '0');
  return { watermark: watermark.toString(), maxEventId: maxId.toString(), lag: Number(maxId - watermark) };
}
