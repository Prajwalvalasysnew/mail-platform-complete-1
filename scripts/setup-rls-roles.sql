-- One-time, per-environment setup for RLS-aware DB roles. Run this manually
-- (as a Postgres superuser / cluster admin) against each environment's
-- database — it is NOT part of the tracked migration pipeline because role
-- creation is cluster-level, not schema-level, and typically needs different
-- credentials than the app's migration user.
--
-- See docs/RLS_FAIL_CLOSED_ROLLOUT.md for the context and rollout checklist.
--
-- Usage:
--   psql "$SUPERUSER_DATABASE_URL" -v api_password="'change-me-api'" \
--        -v service_password="'change-me-service'" -f scripts/setup-rls-roles.sql
--
-- Then set, per service:
--   API:                DATABASE_URL=postgresql://mail_api:...@host/db
--   worker/scheduler:    DATABASE_URL=postgresql://mail_service:...@host/db
--   tracker:             DATABASE_URL=postgresql://mail_service:...@host/db
--   Haraka inbound:      DATABASE_URL=postgresql://mail_service:...@host/db
--   admin console:       DATABASE_URL=postgresql://mail_service:...@host/db
--   migration runner:    keep using the existing owner/superuser role
--                        (it needs DDL rights the app roles should not have)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mail_api') THEN
    CREATE ROLE mail_api LOGIN PASSWORD :api_password;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mail_service') THEN
    CREATE ROLE mail_service LOGIN PASSWORD :service_password BYPASSRLS;
  ELSE
    ALTER ROLE mail_service BYPASSRLS;
  END IF;
END
$$;

-- Explicitly ensure mail_api is NOT superuser and does NOT bypass RLS —
-- packages/api/src/server.ts refuses to boot in production if this role can
-- bypass RLS, so this is the condition that check is verifying.
ALTER ROLE mail_api NOSUPERUSER NOBYPASSRLS;

-- Standard DML privileges (the migration runner owns DDL; app roles only
-- need to read/write rows).
GRANT USAGE ON SCHEMA public TO mail_api, mail_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mail_api, mail_service;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mail_api, mail_service;

-- Make sure future tables created by migrations also grant these roles
-- access without a manual follow-up step.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mail_api, mail_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO mail_api, mail_service;

-- Sanity check you can run right after: confirms mail_api cannot bypass RLS
-- and mail_service can (mirrors the rlsIsEnforced() check in the API).
-- SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('mail_api','mail_service');
