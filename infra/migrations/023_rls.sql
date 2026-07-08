-- Row-Level Security: defense-in-depth tenant isolation.
--
-- The application already filters by customer_id at the query level.  RLS adds
-- a second layer so a SQL injection or application bug cannot leak cross-tenant
-- data.  The API sets `SET LOCAL app.customer_id = '<uuid>'` inside every
-- request-scoped transaction.  The worker uses a service role that bypasses RLS
-- via BYPASSRLS (granted separately in production).
--
-- service role bypass: GRANT BYPASSRLS ON SCHEMA public TO mail_service;
-- (Not in this migration — it is environment-specific.)

-- Enable RLS on the core tenant-scoped tables.
ALTER TABLE messages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppressions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE sending_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys       ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_daily    ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_queue   ENABLE ROW LEVEL SECURITY;

-- Helper: returns current tenant UUID from the session-local setting, or NULL
-- when the connection bypasses RLS (worker, migration runner, admin console).
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$
  SELECT NULLIF(current_setting('app.customer_id', true), '')::uuid
$$;

-- Messages
CREATE POLICY messages_tenant ON messages
  USING (customer_id = current_tenant_id() OR current_tenant_id() IS NULL);

-- Events
CREATE POLICY events_tenant ON events
  USING (customer_id = current_tenant_id() OR current_tenant_id() IS NULL);

-- Suppressions
CREATE POLICY suppressions_tenant ON suppressions
  USING (customer_id = current_tenant_id() OR current_tenant_id() IS NULL);

-- Templates
CREATE POLICY templates_tenant ON templates
  USING (customer_id = current_tenant_id() OR current_tenant_id() IS NULL);

-- Sending domains
CREATE POLICY sending_domains_tenant ON sending_domains
  USING (customer_id = current_tenant_id() OR current_tenant_id() IS NULL);

-- Webhooks
CREATE POLICY webhooks_tenant ON webhooks
  USING (customer_id = current_tenant_id() OR current_tenant_id() IS NULL);

-- API keys
CREATE POLICY api_keys_tenant ON api_keys
  USING (customer_id = current_tenant_id() OR current_tenant_id() IS NULL);

-- Usage daily
CREATE POLICY usage_daily_tenant ON usage_daily
  USING (customer_id = current_tenant_id() OR current_tenant_id() IS NULL);

-- Review queue
CREATE POLICY review_queue_tenant ON review_queue
  USING (customer_id = current_tenant_id() OR current_tenant_id() IS NULL);
