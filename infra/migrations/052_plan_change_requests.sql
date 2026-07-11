CREATE TABLE IF NOT EXISTS billing_plan_change_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  current_plan TEXT NOT NULL,
  target_plan TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_price_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('upgrade', 'downgrade', 'lateral')),
  status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'checkout_started', 'applied', 'canceled', 'expired')),
  quota_delta JSONB NOT NULL DEFAULT '{}'::JSONB,
  feature_delta JSONB NOT NULL DEFAULT '{}'::JSONB,
  warnings JSONB NOT NULL DEFAULT '[]'::JSONB,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 minutes'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plan_change_customer ON billing_plan_change_requests(customer_id, created_at DESC);
