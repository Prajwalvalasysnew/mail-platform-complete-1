-- BASE-03 (compliance implementation plan): recipient erasure completeness.
--
-- Erasure previously left the recipient's plaintext email behind in three
-- authoritative stores: consent_events (the append-only consent ledger),
-- deletion_requests (the erasure evidence record itself), and
-- unsubscribe_group_members. Erasure now replaces those direct identifiers
-- with a keyed HMAC pseudonym ('erased:<hex>') and stamps when that happened,
-- so retained opt-out/erasure evidence stays provable (same key + email
-- recomputes the same pseudonym) without storing the identifier.
ALTER TABLE consent_events ADD COLUMN IF NOT EXISTS pseudonymized_at timestamptz;
ALTER TABLE deletion_requests ADD COLUMN IF NOT EXISTS pseudonymized_at timestamptz;

-- Retention sweep for pseudonymized evidence rows (retention-bounded proof
-- values): date-first index so a cross-tenant lifecycle scan stays cheap.
CREATE INDEX IF NOT EXISTS idx_consent_events_pseudonymized
    ON consent_events (pseudonymized_at) WHERE pseudonymized_at IS NOT NULL;
