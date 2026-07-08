-- Admin account lockout after repeated failed login attempts.
-- After 5 failures in a row, the account is locked for 15 minutes.

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS failed_login_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;
