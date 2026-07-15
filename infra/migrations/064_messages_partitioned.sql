-- Partition `messages` by month (DATABASE_10_10_PLAN Phase 1.2).
--
-- Same rebuild pattern as 063 (events): RANGE(queued_at) partitions so
-- metadata rows past RETENTION_MESSAGE_DAYS are dropped as O(1) metadata
-- operations by the partition_maintenance job, instead of growing without
-- bound (bodies already expire earlier via the body window).
--
-- Schema consequences, all handled here:
--
--   1. UNIQUE(message_id) becomes UNIQUE(message_id, queued_at) — a
--      partitioned unique index must include the partition key. Global
--      uniqueness stays guaranteed in practice because message ids are
--      app-generated (UUID-based, no ON CONFLICT paths on messages), and a
--      plain (message_id) index keeps single-message lookups fast.
--
--   2. send_outbox.message_id FK is dropped (it referenced the old global
--      unique constraint and would block partition drops). The relationship
--      is enforced by construction — message + outbox rows are written in one
--      API transaction — and the privacy-erasure route now deletes outbox
--      rows explicitly where the CASCADE used to. send_outbox rows also age
--      out via retention now (they previously accumulated forever).
--
--   3. The messages→customers and messages→unsubscribe_groups FKs are
--      re-added on the new table (LIKE does not copy them). FKs FROM a
--      partitioned table are fully supported.
--
-- CUTOVER: copy + rename swap inside this migration's transaction under an
-- ACCESS EXCLUSIVE lock (no lost writes); the old table stays as
-- messages_legacy for one release as a fallback. On a very large live
-- deployment, run in a low-traffic window.

-- ---------- 1. Drop the FK that would block partitioning ----------
ALTER TABLE send_outbox DROP CONSTRAINT IF EXISTS send_outbox_message_id_fkey;

-- send_outbox retention cutoff scan (rows now age out; previously unbounded).
CREATE INDEX IF NOT EXISTS idx_send_outbox_created ON send_outbox (created_at);

-- ---------- 2. Consistent copy + swap under exclusive lock ----------
LOCK TABLE messages IN ACCESS EXCLUSIVE MODE;

-- LIKE copies columns, defaults, NOT NULLs, and CHECK constraints — including
-- every column bolted on since 001 — but not indexes/PK/FKs (recreated below).
CREATE TABLE messages_partitioned
    (LIKE messages INCLUDING ALL EXCLUDING INDEXES)
    PARTITION BY RANGE (queued_at);

ALTER TABLE messages_partitioned ADD PRIMARY KEY (id, queued_at);
ALTER TABLE messages_partitioned
    ADD CONSTRAINT messages_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES customers(id);
ALTER TABLE messages_partitioned
    ADD CONSTRAINT messages_unsubscribe_group_id_fkey
    FOREIGN KEY (unsubscribe_group_id) REFERENCES unsubscribe_groups(id) ON DELETE SET NULL;

-- Safety net for writes beyond the pre-created range; alerted on via the
-- default-partition-rows gauge.
CREATE TABLE messages_part_default PARTITION OF messages_partitioned DEFAULT;

-- Monthly partitions covering all existing data through 3 months ahead.
DO $$
DECLARE
    start_month DATE;
    end_month   DATE;
    m           DATE;
BEGIN
    SELECT COALESCE(date_trunc('month', MIN(queued_at))::date,
                    date_trunc('month', now())::date)
      INTO start_month FROM messages;
    end_month := (date_trunc('month', now()) + interval '3 months')::date;
    m := start_month;
    WHILE m <= end_month LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS messages_part_%s PARTITION OF messages_partitioned FOR VALUES FROM (%L) TO (%L)',
            to_char(m, 'YYYYMM'), m, (m + interval '1 month')::date
        );
        m := (m + interval '1 month')::date;
    END LOOP;
END $$;

INSERT INTO messages_partitioned SELECT * FROM messages;

-- Swap names; keep the old table as a one-release fallback.
ALTER TABLE messages RENAME TO messages_legacy;
ALTER INDEX messages_message_id_key       RENAME TO messages_message_id_key_legacy;
ALTER INDEX idx_messages_customer_queued  RENAME TO idx_messages_customer_queued_legacy;
ALTER INDEX idx_messages_status           RENAME TO idx_messages_status_legacy;
ALTER INDEX idx_messages_to               RENAME TO idx_messages_to_legacy;
ALTER INDEX idx_messages_tags             RENAME TO idx_messages_tags_legacy;
ALTER INDEX idx_messages_queued           RENAME TO idx_messages_queued_legacy;
ALTER INDEX idx_messages_sending_at       RENAME TO idx_messages_sending_at_legacy;

ALTER TABLE messages_partitioned RENAME TO messages;

-- Recreate the index set (cascades to all partitions, present and future).
CREATE UNIQUE INDEX messages_message_id_key ON messages (message_id, queued_at);
CREATE INDEX idx_messages_message_id        ON messages (message_id);
CREATE INDEX idx_messages_customer_queued   ON messages (customer_id, queued_at DESC);
CREATE INDEX idx_messages_status            ON messages (status) WHERE status IN ('queued', 'sending');
CREATE INDEX idx_messages_to                ON messages (to_address);
CREATE INDEX idx_messages_tags              ON messages USING GIN (tags);
CREATE INDEX idx_messages_queued            ON messages (queued_at);
CREATE INDEX idx_messages_sending_at        ON messages (sending_at) WHERE status = 'sending';

-- updated_at audit trigger (triggers are not copied by LIKE; row triggers on
-- partitioned parents cascade to partitions).
CREATE TRIGGER messages_updated_at
    BEFORE UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- 3. Fail-closed RLS, matching migration 043 ----------
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
CREATE POLICY messages_tenant ON messages FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
