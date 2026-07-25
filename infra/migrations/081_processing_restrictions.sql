-- GDPR-02 / CCPA-02 (compliance implementation plan): data-subject rights
-- beyond access and erasure.
--
-- The platform could already ACCESS (export) and ERASE a recipient. GDPR
-- Articles 16, 18 and 21 — and the CCPA right to correct — need three more
-- outcomes, and only one of them is expressible with the existing tables.
--
-- RESTRICTION (Art 18) is the new state. It is NOT suppression:
--   * suppression means "this person opted out"           — a marketing state
--   * restriction means "you may store this but not use it" — a legal state
-- imposed while accuracy is contested, while processing is alleged unlawful,
-- or while an objection is being assessed. Data must be RETAINED (so erasure
-- is wrong) but must not be processed (so doing nothing is wrong). It is
-- lifted by a decision, not by the data subject resubscribing, which is why it
-- cannot be folded into the suppression table.
--
-- Rectification and objection reuse existing machinery (suppressions, consent
-- ledger, unsubscribe groups) and need no new table.

CREATE TABLE IF NOT EXISTS processing_restrictions (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email          TEXT NOT NULL,
    -- Which Article 18(1) ground the restriction rests on. Recorded because
    -- the ground determines when the restriction may lawfully be lifted.
    basis          TEXT NOT NULL
        CHECK (basis IN ('accuracy_contested', 'unlawful_processing', 'legal_claims', 'objection_pending')),
    reason         TEXT,
    requested_by   TEXT,
    privacy_case_id UUID REFERENCES privacy_cases(id) ON DELETE SET NULL,
    restricted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at    TIMESTAMPTZ,
    released_reason TEXT,
    released_by    TEXT
);

-- One ACTIVE restriction per recipient per tenant; released rows are history
-- and may accumulate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_restrictions_active
    ON processing_restrictions (customer_id, email)
    WHERE released_at IS NULL;

-- The send path checks this on every message: keep the lookup cheap.
CREATE INDEX IF NOT EXISTS idx_processing_restrictions_lookup
    ON processing_restrictions (customer_id, email)
    WHERE released_at IS NULL;

ALTER TABLE processing_restrictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE processing_restrictions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS processing_restrictions_tenant_isolation ON processing_restrictions;
CREATE POLICY processing_restrictions_tenant_isolation ON processing_restrictions
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
