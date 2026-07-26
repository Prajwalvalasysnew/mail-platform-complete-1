-- HIPAA-07 (compliance implementation plan): review of staff access to tenant
-- personal data. Supports SOC 2 CC6, ISO 27001 A.5.15/A.8.15 and GDPR Art 32
-- equally — "who looked at this customer's data, and was that appropriate" is
-- the same question under all of them.
--
-- WHY THERE IS NO admin_access_log TABLE HERE.
--
-- The access records themselves go into audit_log, which is already
-- hash-chained and periodically signed (BASE-10). A second, separate table
-- would be a LESS protected copy of the most security-sensitive log the
-- platform keeps — access records are exactly what someone covering their
-- tracks would want to edit, so they belong in the tamper-evident store, not
-- next to it.
--
-- But a review is a mutable assertion ABOUT an immutable record, and audit_log
-- must stay append-only for the chain to mean anything. So the review lives
-- here, keyed to the audit row it concerns. The evidence cannot be edited; the
-- judgement about it can be added later, which is exactly the required shape.

CREATE TABLE IF NOT EXISTS admin_access_reviews (
    -- The audit_log row being reviewed. ON DELETE RESTRICT: audit retention
    -- must not silently orphan a review that says an access was inappropriate.
    audit_id     BIGINT PRIMARY KEY REFERENCES audit_log(id) ON DELETE RESTRICT,
    reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_by  TEXT NOT NULL,
    -- 'appropriate'  : access was within the reviewer's expectation
    -- 'inappropriate': it was not. This is a finding and requires a note.
    decision     TEXT NOT NULL CHECK (decision IN ('appropriate', 'inappropriate')),
    note         TEXT,
    -- A finding with no explanation is not a finding anyone can act on.
    CONSTRAINT admin_access_reviews_note_required
        CHECK (decision <> 'inappropriate' OR (note IS NOT NULL AND length(trim(note)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_admin_access_reviews_decision
    ON admin_access_reviews (decision, reviewed_at DESC);
