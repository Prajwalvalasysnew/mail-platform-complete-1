-- Self-serve data exports (DATABASE_10_10_PLAN Phase 2.2).
--
-- SendGrid's answer to history beyond the retention window is "you should
-- have consumed the Event Webhook"; Mailgun sells log forwarding. This gives
-- tenants an async export API instead: POST /v1/exports queues a job, the
-- worker streams the tenant's events/messages for a date range to NDJSON in
-- the body object store (fs/s3), and the download endpoint streams it back.
-- Export artifacts age out via retention (RETENTION_EXPORT_DAYS).
--
-- With BODY_STORAGE=inline (dev/test, zero-dependency), the payload is kept
-- in the row itself (payload column) instead of an object.

CREATE TABLE IF NOT EXISTS data_exports (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('events', 'messages')),
    range_from      TIMESTAMPTZ NOT NULL,
    range_to        TIMESTAMPTZ NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    row_count       INTEGER,
    size_bytes      INTEGER,
    truncated       BOOLEAN NOT NULL DEFAULT FALSE,  -- hit EXPORT_MAX_ROWS
    object_key      TEXT,            -- fs/s3 backends
    payload         TEXT,            -- inline backend only
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_data_exports_customer
    ON data_exports (customer_id, created_at DESC);
-- Retention cutoff scan.
CREATE INDEX IF NOT EXISTS idx_data_exports_created ON data_exports (created_at);
-- Worker claim scan.
CREATE INDEX IF NOT EXISTS idx_data_exports_pending
    ON data_exports (created_at) WHERE status IN ('pending', 'running');

-- Fail-closed tenant RLS, matching migration 043.
ALTER TABLE data_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY data_exports_tenant ON data_exports FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
