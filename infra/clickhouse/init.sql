-- ClickHouse schema for the event firehose. The Postgres `events` table remains
-- the source of truth; this gets a dual-write from the event worker for cheap
-- columnar analytics (rates, funnels, cohorts) over large time ranges.
CREATE DATABASE IF NOT EXISTS mail;

CREATE TABLE IF NOT EXISTS mail.events
(
    message_id   String,
    customer_id  String,
    event_type   LowCardinality(String),
    occurred_at  DateTime64(3, 'UTC'),
    ip           Nullable(String),
    payload      String  -- JSON string; parsed via JSONExtract* at query time
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (customer_id, occurred_at, message_id)
TTL toDateTime(occurred_at) + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192;

-- Reasonable rollup views for the dashboard.
CREATE TABLE IF NOT EXISTS mail.events_daily
(
    day          Date,
    customer_id  String,
    event_type   LowCardinality(String),
    count        UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (day, customer_id, event_type);

CREATE MATERIALIZED VIEW IF NOT EXISTS mail.events_daily_mv
TO mail.events_daily AS
SELECT toDate(occurred_at) AS day, customer_id, event_type, count() AS count
FROM mail.events
GROUP BY day, customer_id, event_type;
