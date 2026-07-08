-- =====================================================
-- Migration 019 - Per-customer billing provider
-- =====================================================

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS billing_provider TEXT NOT NULL DEFAULT 'stripe';

ALTER TABLE customers
  DROP CONSTRAINT IF EXISTS customers_billing_provider_check;

ALTER TABLE customers
  ADD CONSTRAINT customers_billing_provider_check
  CHECK (billing_provider IN ('stripe', 'paypal', 'mock'));

CREATE INDEX IF NOT EXISTS idx_customers_billing_provider
  ON customers(billing_provider);
