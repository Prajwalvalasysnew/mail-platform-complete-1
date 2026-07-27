-- Fail-closed specialist archive receipts for SEC/FINRA communications.
-- Message content is held by the approved archive provider; this table stores
-- only integrity/reconciliation evidence and can therefore be reviewed safely.
CREATE TABLE IF NOT EXISTS regulated_archive_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    message_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
    provider TEXT NOT NULL,
    external_id TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL,
    immutable_until TIMESTAMPTZ NOT NULL,
    reconciliation_status TEXT NOT NULL DEFAULT 'verified'
      CHECK (reconciliation_status IN ('verified', 'missing', 'mismatch')),
    reconciled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (customer_id, message_id, direction)
);

CREATE INDEX IF NOT EXISTS idx_regulated_archive_reconciliation
  ON regulated_archive_records(customer_id, reconciliation_status, archived_at);

ALTER TABLE regulated_archive_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE regulated_archive_records FORCE ROW LEVEL SECURITY;
CREATE POLICY regulated_archive_tenant ON regulated_archive_records
  USING (customer_id = current_setting('app.customer_id', true)::uuid)
  WITH CHECK (customer_id = current_setting('app.customer_id', true)::uuid);
