-- Dual-secret webhook rotation window.
--
-- Previously rotate-secret was an instant cutover: the moment you rotated,
-- every in-flight or not-yet-updated customer verifier would start rejecting
-- valid deliveries signed with the new secret, because the old secret was
-- gone entirely. This adds a grace-period "previous secret" so both the old
-- and new secret verify successfully for a configurable window after
-- rotation (default 24h) -- the same pattern Stripe/GitHub use for webhook
-- secret rotation.
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS previous_secret TEXT;
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS previous_secret_expires_at TIMESTAMPTZ;

-- Index to let the scheduler cheaply find expired previous secrets to clear.
CREATE INDEX IF NOT EXISTS idx_webhooks_previous_secret_expiry
  ON webhooks (previous_secret_expires_at)
  WHERE previous_secret IS NOT NULL;
