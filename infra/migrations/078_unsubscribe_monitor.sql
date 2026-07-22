-- CANSPAM-05 (compliance implementation plan): synthetic unsubscribe
-- monitoring evidence.
--
-- CAN-SPAM requires the unsubscribe mechanism to keep working for at least
-- 30 days after a commercial send and opt-outs to be honored promptly. This
-- table stores the dated evidence: each scheduled run's chain validations
-- (sampled across the 30-day window, oldest first), synthetic one-click
-- exercises with measured suppression latency, and SLA scans that cross-check
-- every unsubscribe consent event against an enforced suppression.
--
-- Platform-level operational evidence (no RLS): rows carry message ids,
-- counts, and latencies — never recipient addresses.
CREATE TABLE IF NOT EXISTS unsubscribe_monitor_runs (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    kind           TEXT NOT NULL
        CHECK (kind IN ('chain_validation', 'one_click_synthetic', 'sla_scan')),
    ok             BOOLEAN NOT NULL,
    target_message_id TEXT,
    message_age_days  DOUBLE PRECISION,
    latency_ms        DOUBLE PRECISION,
    detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
    error          TEXT
);

-- Report window scans (last 30 days, newest first).
CREATE INDEX IF NOT EXISTS idx_unsub_monitor_runs_at
    ON unsubscribe_monitor_runs (run_at DESC);
