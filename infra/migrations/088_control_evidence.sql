-- SOC2-06 (compliance implementation plan): evidence automation.
--
-- Every control added to this platform produces evidence — unsubscribe
-- monitor runs, sender-health verdicts, privacy-case timeliness, erasure
-- completion, audit checkpoints. None of it was collected anywhere an auditor
-- could look, and "the control operated" was inferrable only by querying
-- eight different tables by hand.
--
-- TWO TABLES, FOR TWO DIFFERENT REASONS.
--
-- retention_runs closes an evidence GAP rather than aggregating one. The
-- retention sweep returned its counts to the caller and persisted nothing, so
-- there was no record that it had ever run. That matters more than it sounds:
-- the failure mode for retention is SILENCE — a sweep that stops running looks
-- exactly like a sweep with nothing to do, and data accumulates unnoticed
-- past its window. A run record makes the absence detectable.
--
-- control_evidence_runs is the periodic collection itself: one row per control
-- per period, with the metrics, a completeness verdict, and a reviewer
-- decision.
--
-- NO SECRETS, NO PERSONAL DATA. Metrics are counts and timestamps only. An
-- evidence system is a place people grant auditors time-bounded access to; it
-- must not become a second copy of the data the controls exist to protect.

CREATE TABLE IF NOT EXISTS retention_runs (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    started_at   TIMESTAMPTZ NOT NULL,
    finished_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    duration_ms  INTEGER NOT NULL,
    -- The full RetentionResult: per-step purge counts plus the preserved-row
    -- counters (legal hold, open access request, regulatory lock).
    result       JSONB NOT NULL,
    -- Set when the sweep threw. A failed run is evidence too — arguably the
    -- more important kind.
    error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_retention_runs_finished
    ON retention_runs (finished_at DESC);

CREATE TABLE IF NOT EXISTS control_evidence_runs (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- Plan control id: 'CANSPAM-05', 'BASE-06', 'CCPA-07', …
    control_id    TEXT NOT NULL,
    period_start  TIMESTAMPTZ NOT NULL,
    period_end    TIMESTAMPTZ NOT NULL,
    collected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Counts and timestamps only. Never identifiers, content, or secrets.
    metrics       JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- complete : the control produced evidence across the period
    -- partial  : evidence exists but a sub-check is missing or failing
    -- missing  : NO evidence at all. This is a finding, not a blank —
    --            "the job never ran" and "nothing happened" look identical
    --            until something asserts the difference.
    completeness  TEXT NOT NULL
        CHECK (completeness IN ('complete', 'partial', 'missing')),
    notes         TEXT,
    -- Reviewer approval. Evidence nobody looked at does not demonstrate
    -- operating effectiveness, which is the thing an auditor is testing.
    reviewed_at   TIMESTAMPTZ,
    reviewed_by   TEXT,
    review_note   TEXT
);

-- One row per control per period; re-collection updates rather than duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_evidence_unique
    ON control_evidence_runs (control_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_control_evidence_unreviewed
    ON control_evidence_runs (period_end DESC)
    WHERE reviewed_at IS NULL;
