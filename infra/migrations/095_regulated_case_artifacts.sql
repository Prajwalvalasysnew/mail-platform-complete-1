-- Encrypted framework-specific case evidence. Narrative fields can contain
-- sensitive facts and therefore never live in plaintext columns or audit logs.
CREATE TABLE IF NOT EXISTS hipaa_breach_assessments (
    case_id UUID PRIMARY KEY REFERENCES regulated_rights_cases(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    nature_extent_risk TEXT NOT NULL CHECK (nature_extent_risk IN ('low', 'medium', 'high')),
    unauthorized_person_risk TEXT NOT NULL CHECK (unauthorized_person_risk IN ('low', 'medium', 'high')),
    acquired_or_viewed BOOLEAN NOT NULL,
    mitigation_completed BOOLEAN NOT NULL,
    breach_presumed BOOLEAN NOT NULL,
    encrypted_analysis TEXT NOT NULL,
    assessed_by TEXT NOT NULL,
    assessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ferpa_amendment_outcomes (
    case_id UUID PRIMARY KEY REFERENCES regulated_rights_cases(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    hearing_offered BOOLEAN NOT NULL,
    hearing_at TIMESTAMPTZ,
    outcome TEXT NOT NULL CHECK (outcome IN ('amended', 'denied', 'pending_hearing')),
    encrypted_statement TEXT,
    recorded_by TEXT NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE hipaa_breach_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hipaa_breach_assessments FORCE ROW LEVEL SECURITY;
ALTER TABLE ferpa_amendment_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE ferpa_amendment_outcomes FORCE ROW LEVEL SECURITY;
CREATE POLICY hipaa_breach_assessment_tenant ON hipaa_breach_assessments
  USING (customer_id = current_setting('app.customer_id', true)::uuid)
  WITH CHECK (customer_id = current_setting('app.customer_id', true)::uuid);
CREATE POLICY ferpa_amendment_outcome_tenant ON ferpa_amendment_outcomes
  USING (customer_id = current_setting('app.customer_id', true)::uuid)
  WITH CHECK (customer_id = current_setting('app.customer_id', true)::uuid);
