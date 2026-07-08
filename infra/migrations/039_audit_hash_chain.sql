-- Tamper-evident audit log (gap analysis Top-20 #10: "Audit exists but is not
-- tamper-evident").
--
-- Each audit_log row gets a companion hash-chain row: row_hash =
-- SHA256(previous_hash || canonical(audit row)). Because every link depends on
-- the previous hash, altering or deleting any audit row (or reordering the
-- chain) makes the recomputed hash diverge from the stored chain at that point
-- and everywhere after it — so tampering is detectable by re-walking the chain.
-- This is the design specified in the gap report (§ audit hash chain).
--
-- The chain is per-customer (customer_id NULL forms its own "system" chain), so
-- one tenant's audit volume doesn't serialize another's.

CREATE TABLE IF NOT EXISTS audit_log_hashes (
    audit_id        BIGINT PRIMARY KEY REFERENCES audit_log(id) ON DELETE CASCADE,
    -- The chain key: which per-customer chain this link belongs to. Text so the
    -- NULL-customer "system" chain has a stable key ('system').
    chain_key       TEXT NOT NULL,
    -- Monotonic position within the chain (1-based), for ordered verification.
    seq             BIGINT NOT NULL,
    previous_hash   TEXT NOT NULL,   -- prior link's row_hash (or the genesis constant)
    row_hash        TEXT NOT NULL,   -- SHA256(previous_hash || canonical(audit row))
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast "latest link for this chain" lookup (used to get previous_hash on insert)
-- and ordered walk for verification.
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_hashes_chain_seq
    ON audit_log_hashes (chain_key, seq DESC);
