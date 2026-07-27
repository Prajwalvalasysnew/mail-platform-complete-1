-- CCPA-07 (compliance implementation plan): appeals and escalation for denied
-- data-subject requests.
--
-- The case machine could DENY a request but offered the subject nothing after
-- that. A denial with no route to challenge it is not a complete rights
-- process: CPRA §7304 requires an appeal path, and the state privacy laws that
-- followed (Virginia, Colorado, Connecticut) all mandate one with its own
-- response deadline.
--
-- WHY A SEPARATE TABLE rather than columns on privacy_cases: an appeal is its
-- own process with its own clock. The original request's deadline has already
-- expired by the time an appeal exists, so reusing due_at would either
-- overwrite the record of the original timeline or make the case permanently
-- overdue. Both destroy the evidence the control is meant to produce.
--
-- ESCALATION IS PART OF THE DECISION, NOT AN AFTERTHOUGHT. Where an appeal is
-- refused, the laws require telling the consumer how to complain to the
-- regulator. `escalation_notice` records what they were actually told, so the
-- obligation is evidenced rather than assumed.

CREATE TABLE IF NOT EXISTS privacy_case_appeals (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id       UUID NOT NULL REFERENCES privacy_cases(id) ON DELETE CASCADE,
    customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Why the subject disagrees with the denial. Their words, not ours.
    reason        TEXT NOT NULL,
    -- The appeal's own statutory clock, computed from the jurisdiction.
    due_at        TIMESTAMPTZ NOT NULL,
    status        TEXT NOT NULL DEFAULT 'received'
        CHECK (status IN ('received', 'upheld', 'overturned')),
    decided_at    TIMESTAMPTZ,
    decided_by    TEXT,
    -- Required on any decision: an appeal resolved without a stated reason is
    -- indistinguishable from one that was never considered.
    decision_reason TEXT,
    -- What the consumer was told about complaining to the regulator, where the
    -- denial stood. Evidence of the escalation duty being met.
    escalation_notice TEXT,
    CONSTRAINT appeal_decision_documented
        CHECK (status = 'received' OR (decided_at IS NOT NULL AND decided_by IS NOT NULL AND decision_reason IS NOT NULL))
);

-- One live appeal per case: a second bite while the first is undecided would
-- fork the timeline.
CREATE UNIQUE INDEX IF NOT EXISTS idx_case_appeals_open
    ON privacy_case_appeals (case_id)
    WHERE status = 'received';

CREATE INDEX IF NOT EXISTS idx_case_appeals_overdue
    ON privacy_case_appeals (due_at)
    WHERE status = 'received';

ALTER TABLE privacy_case_appeals ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy_case_appeals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS privacy_case_appeals_tenant_isolation ON privacy_case_appeals;
CREATE POLICY privacy_case_appeals_tenant_isolation ON privacy_case_appeals
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());

-- An overturned appeal reopens the case, and a reopen must be as auditable as
-- the denial that preceded it.
ALTER TABLE privacy_case_events DROP CONSTRAINT IF EXISTS privacy_case_events_event_check;
ALTER TABLE privacy_case_events ADD CONSTRAINT privacy_case_events_event_check
    CHECK (event IN ('created', 'verified', 'status_changed', 'extended', 'communication',
                     'artifact_attached', 'denied', 'closed',
                     'appeal_submitted', 'appeal_decided', 'reopened'));
