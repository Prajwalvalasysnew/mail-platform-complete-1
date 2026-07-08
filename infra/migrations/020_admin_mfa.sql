-- =====================================================
-- Migration 020 - Admin TOTP MFA
-- =====================================================

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS totp_secret TEXT;

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_admin_users_totp_enabled
  ON admin_users(totp_enabled)
  WHERE totp_enabled = TRUE;
