-- =====================================================
-- Migration 021 - Customer email verification
--
-- Adds email ownership verification to the API-first customer signup flow
-- (POST /v1/signup). Distinct from users.email_verified_at, which covers
-- the human-portal flow (POST /v1/auth/register).
--
-- Existing customers are pre-verified (they are already operational).
-- Only new signups after this migration require verification before sending.
-- =====================================================

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS email_verified_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_verify_token_hash  TEXT,
  ADD COLUMN IF NOT EXISTS email_verify_token_expires_at TIMESTAMPTZ;

-- Pre-verify all existing customers so they are not locked out.
UPDATE customers
  SET email_verified_at = NOW()
  WHERE email_verified_at IS NULL;

-- Unique index on the token hash so lookups are fast and collisions impossible.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email_verify_token
  ON customers (email_verify_token_hash)
  WHERE email_verify_token_hash IS NOT NULL;
