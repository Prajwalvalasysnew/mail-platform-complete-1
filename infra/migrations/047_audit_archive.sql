-- Hot audit retention archives the complete canonical row and its chain link
-- before deletion. This preserves local verifiability; production should also
-- replicate these rows to an external WORM/Object-Lock sink.
CREATE TABLE IF NOT EXISTS audit_log_archive (
  audit_id BIGINT PRIMARY KEY,
  customer_id UUID,
  api_key_id UUID,
  actor_type TEXT,
  actor_id UUID,
  actor_label TEXT,
  action TEXT NOT NULL,
  resource TEXT,
  ip INET,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  occurred_at TIMESTAMPTZ NOT NULL,
  chain_key TEXT,
  seq BIGINT,
  previous_hash TEXT,
  row_hash TEXT,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_archive_chain_seq
  ON audit_log_archive(chain_key, seq) WHERE chain_key IS NOT NULL;
