-- ClickHouse analytics durability via reconciliation (gap analysis Top-20 #13:
-- "best-effort dual write can lose analytics events").
--
-- The live path writes events to ClickHouse best-effort (in-memory batched), so
-- a ClickHouse outage or a worker crash can drop analytics rows. But the
-- `events` table in Postgres is the DURABLE source of truth (every event is
-- committed there first). This adds a reconciliation watermark: the id of the
-- last `events` row confirmed shipped to ClickHouse. A periodic sweep ships any
-- events with id > watermark and advances it — so ClickHouse becomes eventually
-- consistent with Postgres and no event is permanently lost.

CREATE TABLE IF NOT EXISTS clickhouse_sync_state (
    -- Single-row table (id = 1). The high-water mark: max events.id known to be
    -- durably in ClickHouse.
    id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_synced_event_id BIGINT NOT NULL DEFAULT 0,
    last_run_at         TIMESTAMPTZ,
    last_shipped_count  BIGINT NOT NULL DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the single row so the reconciler can always UPDATE it.
INSERT INTO clickhouse_sync_state (id, last_synced_event_id)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- The reconciler scans events by id ascending; the PK (id) already indexes that.
