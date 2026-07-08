-- =====================================================
-- Migration 030 - Add cashfree to billing provider constraint
-- =====================================================

ALTER TABLE customers
  DROP CONSTRAINT IF EXISTS customers_billing_provider_check;

ALTER TABLE customers
  ADD CONSTRAINT customers_billing_provider_check
  CHECK (billing_provider IN ('stripe', 'paypal', 'mock', 'cashfree'));
