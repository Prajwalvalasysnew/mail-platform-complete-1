-- Minimal, non-recipient privacy barrier. These rows prevent delayed queue or
-- reconciliation traffic from recreating analytics for erased messages.
-- Deliberately no FK to deletion_requests: retention must not remove the guard.
CREATE TABLE IF NOT EXISTS privacy_message_tombstones (
  customer_id UUID NOT NULL,
  message_id TEXT NOT NULL,
  deletion_request_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_privacy_message_tombstones_request
  ON privacy_message_tombstones(deletion_request_id);
