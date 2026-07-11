-- ClickHouse schema for the event firehose. The Postgres `events` table remains
-- the source of truth; this gets a dual-write from the event worker for cheap
-- columnar analytics (rates, funnels, cohorts) over large time ranges.
--
-- DEDUPLICATION. Every event is written to ClickHouse twice by design: once by
-- the best-effort hot-path dual-write (for freshness) and once by the durable
-- reconciler (backfill from Postgres). Both emit the SAME `event_id`
-- (= Postgres events.id, globally unique and monotonic). The base table is a
-- ReplacingMergeTree whose sorting key ends in `event_id`, so the two inserts of
-- one event collapse to a single row on merge. The daily rollup aggregates
-- `uniqExact(event_id)`, so it counts DISTINCT events and is immune to the
-- double insert even before background merges run (a SummingMergeTree count()
-- would have double-counted). This is what makes reconciliation safe to run
-- alongside the hot path without inflating analytics.
CREATE DATABASE IF NOT EXISTS mail;

CREATE TABLE IF NOT EXISTS mail.events
(
    event_id     UInt64,   -- Postgres events.id — the dedup key (0 = legacy/unknown)
    message_id   String,
    customer_id  String,
    event_type   LowCardinality(String),
    occurred_at  DateTime64(3, 'UTC'),
    ip           Nullable(String),
    payload      String  -- JSON string; parsed via JSONExtract* at query time
)
ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(occurred_at)
-- event_id last in the ORDER BY makes each distinct event its own key, so the
-- hot-path and reconciler inserts of the same event_id deduplicate on merge.
ORDER BY (customer_id, occurred_at, message_id, event_type, event_id)
TTL toDateTime(occurred_at) + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192;

-- Daily rollup for the dashboard. AggregatingMergeTree over uniqExact(event_id)
-- so duplicate inserts of the same event never inflate the count. Query with
-- uniqExactMerge(event_uniq) to get exact per-day/customer/type counts.
CREATE TABLE IF NOT EXISTS mail.events_daily
(
    day          Date,
    customer_id  String,
    event_type   LowCardinality(String),
    event_uniq   AggregateFunction(uniqExact, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (day, customer_id, event_type);

CREATE MATERIALIZED VIEW IF NOT EXISTS mail.events_daily_mv
TO mail.events_daily AS
SELECT toDate(occurred_at) AS day, customer_id, event_type, uniqExactState(event_id) AS event_uniq
FROM mail.events
GROUP BY day, customer_id, event_type;
