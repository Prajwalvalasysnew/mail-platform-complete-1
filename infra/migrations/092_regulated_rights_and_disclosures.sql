-- HIPAA Privacy Rule / FERPA rights case evidence and disclosure accounting.
-- Subject references are keyed pseudonyms, never raw patient/student IDs.

CREATE TABLE IF NOT EXISTS regulated_rights_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('hipaa', 'ferpa')),
    kind TEXT NOT NULL CHECK (kind IN (
      'access', 'amendment', 'restriction', 'confidential_communication',
      'disclosure_accounting', 'breach_assessment', 'hearing'
    )),
    subject_pseudonym TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'identity_verified', 'in_review', 'approved', 'denied', 'fulfilled', 'hearing_requested', 'closed')),
    deadline_at TIMESTAMPTZ NOT NULL,
    decision_reason TEXT,
    created_by TEXT NOT NULL,
    assigned_to TEXT,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_regulated_cases_queue
  ON regulated_rights_cases(customer_id, mode, status, deadline_at);

CREATE TABLE IF NOT EXISTS regulated_rights_case_events (
    id BIGSERIAL PRIMARY KEY,
    case_id UUID NOT NULL REFERENCES regulated_rights_cases(id) ON DELETE CASCADE,
    event TEXT NOT NULL,
    actor TEXT NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS regulated_disclosures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('hipaa', 'ferpa')),
    subject_pseudonym TEXT NOT NULL,
    recipient TEXT NOT NULL,
    purpose TEXT NOT NULL,
    authority TEXT NOT NULL,
    redisclosure_restricted BOOLEAN NOT NULL DEFAULT true,
    disclosed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    recorded_by TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_regulated_disclosures_subject
  ON regulated_disclosures(customer_id, mode, subject_pseudonym, disclosed_at DESC);

ALTER TABLE regulated_rights_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE regulated_rights_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE regulated_rights_case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE regulated_rights_case_events FORCE ROW LEVEL SECURITY;
ALTER TABLE regulated_disclosures ENABLE ROW LEVEL SECURITY;
ALTER TABLE regulated_disclosures FORCE ROW LEVEL SECURITY;
CREATE POLICY regulated_cases_tenant ON regulated_rights_cases
  USING (customer_id = current_setting('app.customer_id', true)::uuid)
  WITH CHECK (customer_id = current_setting('app.customer_id', true)::uuid);
CREATE POLICY regulated_case_events_tenant ON regulated_rights_case_events
  USING (EXISTS (
    SELECT 1 FROM regulated_rights_cases c
    WHERE c.id = case_id
      AND c.customer_id = current_setting('app.customer_id', true)::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM regulated_rights_cases c
    WHERE c.id = case_id
      AND c.customer_id = current_setting('app.customer_id', true)::uuid
  ));
CREATE POLICY regulated_disclosures_tenant ON regulated_disclosures
  USING (customer_id = current_setting('app.customer_id', true)::uuid)
  WITH CHECK (customer_id = current_setting('app.customer_id', true)::uuid);
