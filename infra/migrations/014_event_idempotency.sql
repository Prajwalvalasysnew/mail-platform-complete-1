-- Idempotency key for event processing.
--
-- The event worker can retry a job after a partial failure (e.g. a transient
-- error after the event row was inserted). Without a dedup key this re-inserts
-- the event and double-counts usage_daily. We key idempotency on the BullMQ
-- job id (stable across a job's retries, unique per enqueue) so retries dedupe
-- while legitimately-repeated events (multiple opens) still record distinctly.
--
-- A full unique index (not partial): Postgres treats NULLs as distinct, so
-- pre-existing rows (event_key IS NULL) coexist freely, while ON CONFLICT
-- (event_key) can still infer this index (a partial index can't be inferred
-- without repeating its predicate).

ALTER TABLE events ADD COLUMN IF NOT EXISTS event_key TEXT;

DROP INDEX IF EXISTS events_event_key_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS events_event_key_uniq ON events (event_key);
