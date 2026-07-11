CREATE TABLE IF NOT EXISTS billing_plans (
  plan_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('free', 'paid', 'enterprise')),
  daily_quota INTEGER NOT NULL CHECK (daily_quota >= 0),
  monthly_quota INTEGER NOT NULL CHECK (monthly_quota >= 0),
  features JSONB NOT NULL DEFAULT '{}'::JSONB,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing_plan_prices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  plan_key TEXT NOT NULL REFERENCES billing_plans(plan_key),
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'paypal', 'cashfree', 'mock')),
  environment TEXT NOT NULL DEFAULT 'live' CHECK (environment IN ('test', 'live')),
  provider_price_id TEXT NOT NULL,
  currency TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, environment, provider_price_id)
);

INSERT INTO billing_plans (plan_key, display_name, tier, daily_quota, monthly_quota)
VALUES
  ('free', 'Free', 'free', 100, 3000),
  ('starter', 'Starter', 'paid', 5000, 50000),
  ('pro', 'Pro', 'paid', 50000, 1000000),
  ('enterprise', 'Enterprise', 'enterprise', 1000000, 50000000)
ON CONFLICT (plan_key) DO NOTHING;
