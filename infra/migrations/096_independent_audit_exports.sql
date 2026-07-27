-- Tracks successfully persisted immutable audit segments. The actual records
-- live in independently administered Object-Lock storage; this table is only
-- a reconciliation cursor and checksum index.
CREATE TABLE IF NOT EXISTS audit_worm_exports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chain_key TEXT NOT NULL,
    start_seq BIGINT NOT NULL,
    end_seq BIGINT NOT NULL,
    record_count INTEGER NOT NULL CHECK (record_count > 0),
    bundle_sha256 TEXT NOT NULL CHECK (bundle_sha256 ~ '^[a-f0-9]{64}$'),
    object_key TEXT NOT NULL,
    exported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (chain_key, start_seq, end_seq)
);
CREATE INDEX IF NOT EXISTS idx_audit_worm_exports_cursor
  ON audit_worm_exports(chain_key, end_seq DESC);
