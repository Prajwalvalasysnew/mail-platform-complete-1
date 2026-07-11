ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS provider_plan_item_id TEXT;
ALTER TABLE billing_plan_change_requests ADD COLUMN IF NOT EXISTS proration_date BIGINT;
ALTER TABLE billing_plan_change_requests ADD COLUMN IF NOT EXISTS proration_amount_cents INTEGER;
ALTER TABLE billing_plan_change_requests ADD COLUMN IF NOT EXISTS preview_amount_due_cents INTEGER;
ALTER TABLE billing_plan_change_requests ADD COLUMN IF NOT EXISTS preview_currency TEXT;
