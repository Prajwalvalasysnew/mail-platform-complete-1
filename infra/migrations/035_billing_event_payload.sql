-- Billing event replay support.
--
-- billing_events previously stored only (provider_event_id, type, processed_at)
-- — enough for idempotency (don't process the same event twice) but NOT enough
-- to REPLAY an event: the raw provider payload was discarded after processing,
-- so a mis-applied or dropped subscription change could not be re-run.
--
-- This adds nullable columns so the webhook can persist the raw payload and
-- provider, enabling an admin replay tool (see /admin/billing-events*). Nullable
-- + no backfill keeps it backward compatible: pre-existing rows simply have a
-- null payload and are reported as "not replayable" by the admin API.

ALTER TABLE billing_events
  ADD COLUMN IF NOT EXISTS provider TEXT,
  ADD COLUMN IF NOT EXISTS payload  JSONB,
  ADD COLUMN IF NOT EXISTS replayed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replay_count INTEGER NOT NULL DEFAULT 0;

-- Index for the admin listing (newest first).
CREATE INDEX IF NOT EXISTS idx_billing_events_processed_at
  ON billing_events (processed_at DESC);
