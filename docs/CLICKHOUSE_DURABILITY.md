# ClickHouse analytics durability (gap analysis Top-20 #13)

## The gap

Report #13 (score 6.5): "Best-effort dual write can lose analytics events."
`clickhouse.ts` buffers events in-memory and ships them best-effort; on a
ClickHouse outage (circuit opens) or a worker crash, buffered rows are dropped.
The report's fix: "Add analytics outbox and reconciliation."

## The insight

We don't need a separate outbox table — the Postgres `events` table is ALREADY
the durable source of truth (every event is committed there before the
best-effort ClickHouse write). Its `BIGSERIAL id` is a natural monotonic cursor.
So durability = reconcile ClickHouse against Postgres from a watermark.

## What was built

**Migration `041_clickhouse_sync_state.sql`** — a single-row watermark table
`clickhouse_sync_state(last_synced_event_id, last_run_at, last_shipped_count)`,
seeded at 0.

**`reconcileClickhouse()`** (`packages/shared/src/clickhouse-reconcile.ts`):
- reads the watermark, selects `events` with `id > watermark` ascending in
  bounded batches,
- ships each batch via `insertClickhouseRows()` (an AWAITED insert that returns
  success/failure — unlike the fire-and-forget hot-path buffer),
- advances + PERSISTS the watermark only after a CONFIRMED insert. On failure it
  stops WITHOUT advancing, so the same events are retried next run — never
  silently dropped.
- `clickhouseSyncLag()` reports how many events are pending, for alerting.

**Wired into the worker scheduler**: a `clickhouse_reconcile` job every 5
minutes (no-op when ClickHouse isn't configured). So a ClickHouse outage or a
crash self-heals: once ClickHouse is back, the next sweep backfills the gap.

The hot-path best-effort write is unchanged (still fast, non-blocking); the
reconciler is the durability backstop underneath it.

## Verified how (real, live infra)

- Migration 041 applies; watermark row seeded at 0.
- `npm run build`: exit 0 (compiler caught events.id being numeric and Timestamp
  cast issues; fixed).
- `clickhouse-reconcile.test.ts`: 4/4 against live Postgres + a real in-process
  HTTP stub standing in for ClickHouse:
  - ships events past the watermark and advances it; a second run is a no-op;
  - **on insert FAILURE the watermark does NOT advance, lag stays, and the SAME
    events are backfilled on recovery** — the core "no event lost" proof;
  - multi-batch processing;
  - lag reporting goes to 0 after a full sync.
- Full suite: 96 files, 646 tests, 0 failures.

## Deduplication (Phase 3)

The reconciler is at-least-once (a crash between insert and watermark-persist can
re-ship a batch), and every event is also written by the best-effort hot path —
so ClickHouse receives each event at least twice. Deduplication is now built into
the schema rather than left to the operator:

- Both writers emit a stable `event_id` = the Postgres `events.id` (globally
  unique, monotonic). The hot path reads it from the freshly-inserted event row;
  the reconciler reads it from the `events` scan.
- `mail.events` is a **ReplacingMergeTree** whose `ORDER BY` ends in `event_id`,
  so the two inserts of one event collapse to a single row on merge.
- The daily rollup `mail.events_daily` is an **AggregatingMergeTree** over
  `uniqExact(event_id)`. Because it counts DISTINCT event ids, a duplicate insert
  never inflates the count — even before background merges run. (The previous
  `SummingMergeTree count()` rollup double-counted every re-shipped event.) Query
  it with `uniqExactMerge(event_uniq)`.

Guarded by `clickhouse-schema.test.ts` (engine, dedup key, uniqExact rollup) and
`clickhouse-reconcile.test.ts` (the reconciler ships the stable `event_id`).

## Verified how

- Migration 041 applies; watermark row seeded at 0.
- `npm run build`: exit 0.
- `clickhouse-reconcile.test.ts` + `clickhouse-schema.test.ts` against live
  Postgres + a real in-process HTTP stub standing in for ClickHouse:
  - ships events past the watermark and advances it; a second run is a no-op;
  - on insert FAILURE the watermark does NOT advance, lag stays, and the SAME
    events are backfilled on recovery — the core "no event lost" proof;
  - each shipped row carries the stable `event_id` dedup key;
  - multi-batch processing; lag reporting goes to 0 after a full sync.

## Still pending (live-infra evidence)

The merge-time collapse and `uniqExactMerge` exactness are proven against the
shipped DDL statically; the end-to-end behaviour under a real ClickHouse
(insert the same event via both paths, force a merge, assert one row and one
counted event) is a live-infra drill tracked with the other Phase 4 operational
evidence (backup/restore, failover).
