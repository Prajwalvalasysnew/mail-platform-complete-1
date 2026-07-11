-- Customer SSO enforcement. When an organization enables sso_enforced, its
-- members can no longer authenticate with a password — they must go through the
-- identity provider (SSO/SCIM). This is the tenant-level equivalent of the admin
-- plane's password_login_disabled posture, and lets an enterprise mandate SSO
-- for everyone in their tenant.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS sso_enforced BOOLEAN NOT NULL DEFAULT false;
