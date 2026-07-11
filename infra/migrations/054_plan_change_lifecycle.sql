ALTER TABLE billing_plan_change_requests ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
ALTER TABLE billing_plan_change_requests ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_plan_change_expiry
  ON billing_plan_change_requests(status, expires_at) WHERE status = 'previewed';
