-- Password-based admin authentication.
--
-- The admin plane previously only had an OIDC seam (createAdminSession by
-- oidc_subject), which was never wired, leaving no way to actually authenticate
-- an operator. Add a password credential so the admin console/back-office is
-- usable end-to-end. OIDC remains supported in parallel via oidc_subject.

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS password_hash TEXT;
