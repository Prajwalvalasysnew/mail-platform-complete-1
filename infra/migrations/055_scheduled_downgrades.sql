-- Period-end downgrade scheduling and rollback.
--
-- Downgrades no longer apply immediately (which would credit unused time and
-- drop the customer's capacity mid-period). Instead they are recorded as
-- 'scheduled' with an effective date at the current period end, keeping the
-- customer on their paid plan until then, and remain cancellable (rollback)
-- until applied.

ALTER TABLE billing_plan_change_requests
  DROP CONSTRAINT IF EXISTS billing_plan_change_requests_status_check;
ALTER TABLE billing_plan_change_requests
  ADD CONSTRAINT billing_plan_change_requests_status_check
  CHECK (status IN ('previewed', 'checkout_started', 'scheduled', 'applied', 'canceled', 'expired'));

ALTER TABLE billing_plan_change_requests
  ADD COLUMN IF NOT EXISTS scheduled_effective_at TIMESTAMPTZ;

-- Drives the billing_scheduled_downgrade_apply scheduler job.
CREATE INDEX IF NOT EXISTS idx_plan_change_scheduled
  ON billing_plan_change_requests(status, scheduled_effective_at) WHERE status = 'scheduled';
