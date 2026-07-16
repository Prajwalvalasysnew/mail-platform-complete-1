-- Partition `events` by month (DATABASE_10_10_PLAN Phase 1.1).
--
-- The events firehose was a single unpartitioned table, so retention meant
-- row-by-row DELETEs: long transactions, WAL spikes, and permanent bloat.
-- This migration rebuilds it as a RANGE(occurred_at) partitioned table so
-- expired months are dropped as O(1) metadata operations by the
-- partition_maintenance scheduler job. The batched row-level delete in
-- runRetention remains as the fine-grained cleaner (per-tenant windows,
-- legal-hold skips) inside the live partitions.
--
-- Two schema consequences, both handled here:
--
--   1. event_key dedup. A partitioned table cannot carry a global UNIQUE
--      (event_key) index (unique indexes must include the partition key), and
--      ON CONFLICT (event_key) — the event worker's retry dedup — needs one.
--      Dedup claims move to a small unpartitioned side table `event_keys`
--      (claim row + event insert commit in one transaction, so the semantics
--      are unchanged). Keys age out with the event retention window.
--
--   2. webhook_delivery_log.event_id FK. A foreign key cannot reference a
--      subset of a partitioned table's primary key, and it would block
--      partition drops anyway. The FK is dropped; event_id stays as a plain
--      pointer column (its join index remains, rows now simply dangle after
--      the referenced event ages out instead of being nulled).
--
-- CUTOVER. The copy + rename swap runs inside this migration's transaction
-- under an ACCESS EXCLUSIVE lock, so concurrent writers block briefly and no
-- rows are lost. The old table is kept as `events_legacy` (indexes renamed)
-- for one release cycle as a fallback; a follow-up migration drops it. On a
-- very large live deployment, prefer running this during a low-traffic
-- window — the copy is proportional to table size.

-- ---------- 1. event_keys dedup side table ----------
CREATE TABLE IF NOT EXISTS event_keys (
    event_key   TEXT PRIMARY KEY,
    event_id    BIGINT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Retention cutoff scan (keys age out with RETENTION_EVENT_DAYS).
CREATE INDEX IF NOT EXISTS idx_event_keys_created ON event_keys (created_at);

INSERT INTO event_keys (event_key, event_id, created_at)
SELECT event_key, id, occurred_at
FROM events
WHERE event_key IS NOT NULL
ON CONFLICT (event_key) DO NOTHING;

-- ---------- 2. Drop the FK that would block partitioning ----------
ALTER TABLE webhook_delivery_log
    DROP CONSTRAINT IF EXISTS webhook_delivery_log_event_id_fkey;

-- ---------- 3. Consistent copy + swap under exclusive lock ----------
LOCK TABLE events IN ACCESS EXCLUSIVE MODE;

CREATE TABLE events_partitioned (
    id              BIGINT NOT NULL DEFAULT nextval('events_id_seq'),
    message_id      TEXT NOT NULL,
    customer_id     UUID NOT NULL,
    event_type      TEXT NOT NULL CHECK (event_type IN (
                        'queued', 'sent', 'delivered', 'soft_bounce', 'hard_bounce',
                        'complaint', 'opened', 'clicked', 'unsubscribed', 'failed'
                    )),
    payload         JSONB DEFAULT '{}'::JSONB,
    ip              INET,
    user_agent      TEXT,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bot_verdict     TEXT CHECK (bot_verdict IS NULL OR bot_verdict IN ('human', 'bot', 'suspicious')),
    bot_score       REAL,
    event_key       TEXT,   -- kept for observability; dedup lives in event_keys
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Safety net for writes beyond the pre-created range (e.g. the maintenance
-- job was down for months). The scheduler alerts if rows ever land here.
CREATE TABLE events_part_default PARTITION OF events_partitioned DEFAULT;

-- Monthly partitions covering all existing data through 3 months ahead.
DO $$
DECLARE
    start_month DATE;
    end_month   DATE;
    m           DATE;
BEGIN
    SELECT COALESCE(date_trunc('month', MIN(occurred_at))::date,
                    date_trunc('month', now())::date)
      INTO start_month FROM events;
    end_month := (date_trunc('month', now()) + interval '3 months')::date;
    m := start_month;
    WHILE m <= end_month LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS events_part_%s PARTITION OF events_partitioned FOR VALUES FROM (%L) TO (%L)',
            to_char(m, 'YYYYMM'), m, (m + interval '1 month')::date
        );
        m := (m + interval '1 month')::date;
    END LOOP;
END $$;

INSERT INTO events_partitioned
    (id, message_id, customer_id, event_type, payload, ip, user_agent,
     occurred_at, bot_verdict, bot_score, event_key)
SELECT id, message_id, customer_id, event_type, payload, ip, user_agent,
       occurred_at, bot_verdict, bot_score, event_key
FROM events;

-- Swap names; keep the old table (and its data) as a one-release fallback.
ALTER TABLE events RENAME TO events_legacy;
ALTER INDEX idx_events_message        RENAME TO idx_events_message_legacy;
ALTER INDEX idx_events_customer_time  RENAME TO idx_events_customer_time_legacy;
ALTER INDEX idx_events_type           RENAME TO idx_events_type_legacy;
ALTER INDEX idx_events_bot            RENAME TO idx_events_bot_legacy;
ALTER INDEX idx_events_occurred       RENAME TO idx_events_occurred_legacy;
ALTER INDEX events_event_key_uniq     RENAME TO events_event_key_uniq_legacy;

ALTER TABLE events_partitioned RENAME TO events;

-- The shared BIGSERIAL sequence now belongs to the partitioned table, so a
-- later DROP TABLE events_legacy cannot take it down.
ALTER SEQUENCE events_id_seq OWNED BY events.id;

-- Same indexes as before (partitioned parents cascade these to every
-- partition, present and future).
CREATE INDEX idx_events_message       ON events (message_id, occurred_at);
CREATE INDEX idx_events_customer_time ON events (customer_id, occurred_at DESC);
CREATE INDEX idx_events_type          ON events (event_type, occurred_at DESC);
CREATE INDEX idx_events_bot           ON events (event_type, bot_verdict, occurred_at DESC);
CREATE INDEX idx_events_occurred      ON events (occurred_at);
CREATE INDEX idx_events_event_key     ON events (event_key) WHERE event_key IS NOT NULL;

-- ---------- 4. Fail-closed RLS, matching migration 043 ----------
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
CREATE POLICY events_tenant ON events FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
