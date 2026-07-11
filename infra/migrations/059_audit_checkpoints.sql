-- Signed audit checkpoints (WORM / tamper-evidence hardening).
--
-- The audit hash chain already detects in-place tampering, but an attacker with
-- full DB write access could rewrite BOTH audit_log and audit_log_hashes and
-- recompute a consistent chain. Signed checkpoints defend against that: we
-- periodically sign the current chain head (chain_key, seq, row_hash) with an
-- Ed25519 key and export it to an append-only WORM sink held OUTSIDE the
-- database. A later verifier compares the externally-held signed root against
-- the chain — a silent rewrite no longer verifies, because the signature over
-- the old head can't be forged without the private key.
CREATE TABLE IF NOT EXISTS audit_checkpoints (
  id            BIGSERIAL PRIMARY KEY,
  chain_key     TEXT NOT NULL,
  seq           BIGINT NOT NULL,
  row_hash      TEXT NOT NULL,
  key_id        TEXT NOT NULL,
  signature     TEXT NOT NULL,       -- base64 Ed25519 signature over the canonical checkpoint
  checkpoint_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_checkpoints_chain ON audit_checkpoints(chain_key, seq DESC);
