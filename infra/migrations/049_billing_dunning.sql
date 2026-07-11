CREATE TABLE IF NOT EXISTS billing_dunning_state (
  customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'healthy' CHECK (state IN ('healthy', 'grace', 'restricted', 'recovered', 'canceled')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  grace_ends_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  recovered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

UPDATE billing_plans SET features = CASE plan_key
  WHEN 'free' THEN '{"webhooks":true,"analytics_days":7,"team_seats":1}'::jsonb
  WHEN 'starter' THEN '{"webhooks":true,"analytics_days":30,"team_seats":5}'::jsonb
  WHEN 'pro' THEN '{"webhooks":true,"analytics_days":90,"team_seats":25,"dedicated_pools":true}'::jsonb
  WHEN 'enterprise' THEN '{"webhooks":true,"analytics_days":365,"team_seats":1000,"dedicated_pools":true,"sso":true,"scim":true}'::jsonb
  ELSE features END,
  updated_at = NOW();
