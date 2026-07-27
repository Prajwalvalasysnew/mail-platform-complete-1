-- Regulated workload activation is fail-closed. A tenant may request a mode,
-- but only an administrator can activate it after every repository-verifiable
-- prerequisite is attested. External contracts/assessments remain explicit
-- prerequisites rather than comments or informal support notes.

CREATE TABLE IF NOT EXISTS regulated_workload_posture (
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('hipaa', 'ferpa', 'sec_finra')),
    status TEXT NOT NULL DEFAULT 'disabled'
        CHECK (status IN ('disabled', 'pending', 'active', 'rejected', 'suspended')),
    prerequisites JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_at TIMESTAMPTZ,
    requested_by TEXT,
    reviewed_at TIMESTAMPTZ,
    reviewed_by TEXT,
    review_note TEXT,
    activated_at TIMESTAMPTZ,
    suspended_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (customer_id, mode),
    CONSTRAINT regulated_workload_review_note
      CHECK (status NOT IN ('rejected', 'suspended') OR
             (review_note IS NOT NULL AND length(trim(review_note)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_regulated_workload_review_queue
    ON regulated_workload_posture (status, requested_at)
    WHERE status IN ('pending', 'suspended');

ALTER TABLE regulated_workload_posture ENABLE ROW LEVEL SECURITY;
ALTER TABLE regulated_workload_posture FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS regulated_workload_tenant_isolation ON regulated_workload_posture;
CREATE POLICY regulated_workload_tenant_isolation ON regulated_workload_posture
    USING (customer_id = current_setting('app.customer_id', true)::uuid)
    WITH CHECK (customer_id = current_setting('app.customer_id', true)::uuid);
