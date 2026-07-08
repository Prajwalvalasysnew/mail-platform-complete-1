-- User account lockout after repeated failed login attempts.
-- After 5 failures the account is locked for 15 minutes, matching
-- the admin lockout policy in migration 024.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;
