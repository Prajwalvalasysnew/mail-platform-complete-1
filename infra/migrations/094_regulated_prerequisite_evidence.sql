-- Evidence-backed regulated-mode activation. Boolean assertions are not
-- sufficient: every prerequisite has a named artifact, checksum, independent
-- reviewer, approval time, and optional expiry.
CREATE TABLE IF NOT EXISTS regulated_prerequisite_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('hipaa', 'ferpa', 'sec_finra')),
    prerequisite TEXT NOT NULL,
    artifact_uri TEXT NOT NULL,
    artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
    status TEXT NOT NULL DEFAULT 'submitted'
      CHECK (status IN ('submitted', 'approved', 'rejected')),
    submitted_by TEXT NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    review_note TEXT,
    expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (customer_id, mode, prerequisite)
);

CREATE INDEX IF NOT EXISTS idx_regulated_evidence_review
  ON regulated_prerequisite_evidence(mode, status, expires_at);

ALTER TABLE regulated_prerequisite_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE regulated_prerequisite_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY regulated_evidence_tenant ON regulated_prerequisite_evidence
  USING (customer_id = current_setting('app.customer_id', true)::uuid)
  WITH CHECK (customer_id = current_setting('app.customer_id', true)::uuid);
