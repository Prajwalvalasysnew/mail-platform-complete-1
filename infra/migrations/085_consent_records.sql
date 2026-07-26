-- GDPR-05 (compliance implementation plan): consent standards.
--
-- The platform could already prove someone OPTED OUT — consent_events is an
-- append-only ledger of suppress/unsuppress. It could not prove they ever
-- OPTED IN, and that is the half Article 7(1) actually demands: "the
-- controller shall be able to demonstrate that the data subject has consented".
-- An opt-out ledger with no matching opt-in record answers the wrong question.
--
-- WHAT DEMONSTRATING CONSENT REQUIRES, and why each column exists:
--
--   method + affirmative   Consent must be a clear affirmative act (Art 4(11)).
--                          A pre-ticked box or silence is not consent, so the
--                          method vocabulary has no value for one and the
--                          affirmative flag cannot be stored false.
--   evidence_text          The exact wording the subject agreed to. "They
--                          consented" is not evidence; "they were shown THIS
--                          and clicked agree" is.
--   policy_version         Which privacy notice was in force. Without it you
--                          cannot say what they were told at the time.
--   source_url / ip /      Provenance: where the act happened. This is what
--   user_agent             distinguishes a real signup from a list import
--                          someone typed in later.
--   confirmed_at + token   Double opt-in proof, when used. The strongest
--                          available evidence that the address belongs to the
--                          person who consented.
--
-- WITHDRAWAL (Art 7(3)) must be as easy as giving consent, and withdrawing
-- must not retroactively delete the proof that consent once existed — the
-- controller still has to account for mail sent while it was valid. So
-- withdrawal sets withdrawn_at on the record rather than removing the row.

CREATE TABLE IF NOT EXISTS consent_records (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email          TEXT NOT NULL,
    purpose        TEXT NOT NULL DEFAULT 'marketing',
    -- No 'pre_checked' / 'implied' member: those are not consent under
    -- Art 4(11), and offering them as a value would invite recording them.
    method         TEXT NOT NULL
        CHECK (method IN ('web_form', 'double_opt_in', 'api', 'offline', 'import_with_evidence')),
    -- Cannot be false: a row in this table asserts an affirmative act.
    affirmative    BOOLEAN NOT NULL DEFAULT TRUE CHECK (affirmative = TRUE),
    evidence_text  TEXT NOT NULL,
    policy_version TEXT,
    source_url     TEXT,
    ip             INET,
    user_agent     TEXT,
    granted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Double opt-in: token issued at signup, confirmed_at set when the
    -- recipient clicks through from the confirmation mail.
    confirmation_token TEXT,
    confirmed_at   TIMESTAMPTZ,
    withdrawn_at   TIMESTAMPTZ,
    withdrawal_source TEXT,
    -- BASE-03: erasure replaces the address with a keyed pseudonym rather than
    -- deleting the row, so the opt-in/opt-out history stays accountable.
    pseudonymized_at TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Proof lookup is always (tenant, address).
CREATE INDEX IF NOT EXISTS idx_consent_records_lookup
    ON consent_records (customer_id, email, granted_at DESC);

-- One live consent per (tenant, address, purpose): re-consenting supersedes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_consent_records_active
    ON consent_records (customer_id, email, purpose)
    WHERE withdrawn_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_consent_records_confirmation
    ON consent_records (confirmation_token)
    WHERE confirmation_token IS NOT NULL AND confirmed_at IS NULL;

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS consent_records_tenant_isolation ON consent_records;
CREATE POLICY consent_records_tenant_isolation ON consent_records
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
