-- BASE-05 (compliance implementation plan): privacy case management.
--
-- A data-subject request (GDPR Arts. 15-21, CCPA/CPRA consumer rights) is a
-- tracked CASE with a statutory deadline, not a fire-and-forget API call.
-- privacy_cases records intake source, identity verification, jurisdiction,
-- request types, deadline/extension, exception/denial, approval, fulfillment
-- artifacts, and closure. privacy_case_events is the append-only history that
-- provides closure evidence.
--
-- PI minimization: the subject identifier is held once on the case row for
-- fulfillment; when a case that erased the subject closes, it is replaced by
-- the keyed pseudonym (same scheme as migration 075). The event ledger and
-- application logs never carry the identifier — only case ids.

CREATE TABLE IF NOT EXISTS privacy_cases (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    subject_kind        TEXT NOT NULL DEFAULT 'recipient'
        CHECK (subject_kind IN ('recipient', 'account_user')),
    -- Plaintext while the case is worked; pseudonymized at closure when the
    -- case included erasure (subject_pseudonymized_at set).
    subject_identifier  TEXT NOT NULL,
    subject_pseudonymized_at TIMESTAMPTZ,
    intake_source       TEXT NOT NULL
        CHECK (intake_source IN ('api', 'email', 'web_form', 'support', 'authorized_agent', 'postal')),
    request_types       TEXT[] NOT NULL,
    jurisdiction        TEXT NOT NULL DEFAULT 'unknown'
        CHECK (jurisdiction IN ('gdpr', 'ccpa', 'other', 'unknown')),
    status              TEXT NOT NULL DEFAULT 'received'
        CHECK (status IN ('received', 'verifying', 'in_progress', 'waiting_on_subject', 'fulfilled', 'denied', 'closed')),
    received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    due_at              TIMESTAMPTZ NOT NULL,
    extended_until      TIMESTAMPTZ,
    extension_reason    TEXT,
    identity_verified_at TIMESTAMPTZ,
    verification_method TEXT,
    denial_reason       TEXT,
    approved_by         TEXT,
    closed_at           TIMESTAMPTZ,
    -- References to fulfillment evidence (deletion_request ids, export ids…),
    -- never the fulfillment content itself.
    artifacts           JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by          TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_privacy_cases_customer
    ON privacy_cases (customer_id, received_at DESC);
-- Deadline monitoring: open cases by effective due date.
CREATE INDEX IF NOT EXISTS idx_privacy_cases_open_due
    ON privacy_cases (due_at)
    WHERE status NOT IN ('fulfilled', 'denied', 'closed');

CREATE TABLE IF NOT EXISTS privacy_case_events (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       UUID NOT NULL REFERENCES privacy_cases(id) ON DELETE CASCADE,
    customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    event         TEXT NOT NULL
        CHECK (event IN ('created', 'verified', 'status_changed', 'extended', 'communication', 'artifact_attached', 'denied', 'closed')),
    -- Structured detail (old/new status, artifact refs, communication channel
    -- summaries). MUST NOT contain the subject identifier or request content.
    detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_privacy_case_events_case
    ON privacy_case_events (case_id, created_at);

-- Fail-closed tenant RLS, matching migration 043.
ALTER TABLE privacy_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_cases_tenant ON privacy_cases FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());

ALTER TABLE privacy_case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_case_events FORCE ROW LEVEL SECURITY;
CREATE POLICY privacy_case_events_tenant ON privacy_case_events FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
