-- SEC-04 (compliance implementation plan): prevent ordinary plan retention and
-- data-subject erasure from destroying records under a regulatory retention
-- obligation.
--
-- This is the THIRD preservation mechanism, and it exists because the other two
-- cannot express what a recordkeeping rule requires:
--
--   legal hold   tenant-placed, tenant-released, no end date
--                ("this matter needs these records")
--   request pin  automatic, released when the request is fulfilled
--                ("someone asked for this, do not delete it mid-request")
--   regulatory   time-bound to a statutory period, and NOT releasable just
--   lock         because the tenant would like it gone
--                ("SEC 17a-4 / FINRA 4511 says six years")
--
-- The decisive difference is the erasure interaction. A legal hold blocks
-- erasure and a tenant can lift it at will. A regulatory lock must block
-- erasure even when the DATA SUBJECT asks — GDPR Art 17(3)(b) makes compliance
-- with a legal obligation a lawful ground to refuse, and a broker-dealer
-- cannot honour a deletion request for a record it is required to retain.
-- Refusing is the correct answer; refusing SILENTLY is not, which is why the
-- release path demands a documented authority rather than a boolean.
--
-- NOTE ON SCOPE: this makes regulated retention ENFORCEABLE. It does not make
-- the platform a qualifying SEC 17a-4 archive — that needs SEC-03 (WORM or
-- audit-trail-alternative storage), SEC-05 (retrieval/production) and SEC-09
-- (independent validation). Broker-dealer records remain a prohibited workload
-- until the whole workstream is complete.

CREATE TABLE IF NOT EXISTS regulatory_retention_locks (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    -- 'customer' for every record in the tenant, or 'recipient:<email>' for a
    -- single correspondent. Mirrors legal_holds so operators reason about one
    -- scope grammar, not two.
    scope         TEXT NOT NULL,
    basis         TEXT NOT NULL
        CHECK (basis IN ('sec_17a4', 'finra_4511', 'other_statutory')),
    -- The statutory or contractual authority being relied on. Free text, but
    -- required: "we retained it because a rule says so" is only defensible if
    -- the rule is named.
    authority     TEXT NOT NULL,
    -- When the obligation lapses. Enforcement is time-bound: past this instant
    -- the ordinary retention policy applies again with no manual step.
    retain_until  TIMESTAMPTZ NOT NULL,
    created_by    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Early release is possible but deliberately expensive to do quietly.
    released_at   TIMESTAMPTZ,
    released_by   TEXT,
    released_reason TEXT,
    CONSTRAINT regulatory_lock_release_documented
        CHECK (released_at IS NULL OR (released_by IS NOT NULL AND released_reason IS NOT NULL))
);

-- The retention sweep and the erasure gate both ask "is this record locked?".
CREATE INDEX IF NOT EXISTS idx_regulatory_locks_active
    ON regulatory_retention_locks (customer_id, scope)
    WHERE released_at IS NULL;

ALTER TABLE regulatory_retention_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE regulatory_retention_locks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS regulatory_locks_tenant_isolation ON regulatory_retention_locks;
CREATE POLICY regulatory_locks_tenant_isolation ON regulatory_retention_locks
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
