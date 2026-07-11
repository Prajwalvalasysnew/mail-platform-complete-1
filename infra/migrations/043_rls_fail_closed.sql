-- Fail-closed row-level security for API tenant tables.
--
-- Migration 023 deliberately allowed all rows when app.customer_id was unset.
-- API routes are now tenant-transaction scoped, so that rollout escape hatch
-- must be removed. Cross-tenant service processes use a separate BYPASSRLS
-- role; the API role must be non-superuser and non-BYPASSRLS.

ALTER TABLE messages         FORCE ROW LEVEL SECURITY;
ALTER TABLE events           FORCE ROW LEVEL SECURITY;
ALTER TABLE suppressions     FORCE ROW LEVEL SECURITY;
ALTER TABLE templates        FORCE ROW LEVEL SECURITY;
ALTER TABLE sending_domains  FORCE ROW LEVEL SECURITY;
ALTER TABLE webhooks         FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_daily      FORCE ROW LEVEL SECURITY;
ALTER TABLE review_queue     FORCE ROW LEVEL SECURITY;
ALTER TABLE consent_events   FORCE ROW LEVEL SECURITY;
ALTER TABLE legal_holds      FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS messages_tenant        ON messages;
DROP POLICY IF EXISTS events_tenant          ON events;
DROP POLICY IF EXISTS suppressions_tenant    ON suppressions;
DROP POLICY IF EXISTS templates_tenant       ON templates;
DROP POLICY IF EXISTS sending_domains_tenant ON sending_domains;
DROP POLICY IF EXISTS webhooks_tenant        ON webhooks;
DROP POLICY IF EXISTS usage_daily_tenant     ON usage_daily;
DROP POLICY IF EXISTS review_queue_tenant    ON review_queue;
DROP POLICY IF EXISTS consent_events_tenant  ON consent_events;
DROP POLICY IF EXISTS legal_holds_tenant     ON legal_holds;

CREATE POLICY messages_tenant ON messages FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
CREATE POLICY events_tenant ON events FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
CREATE POLICY suppressions_tenant ON suppressions FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
CREATE POLICY templates_tenant ON templates FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
CREATE POLICY sending_domains_tenant ON sending_domains FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
CREATE POLICY webhooks_tenant ON webhooks FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
CREATE POLICY usage_daily_tenant ON usage_daily FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
CREATE POLICY review_queue_tenant ON review_queue FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
CREATE POLICY consent_events_tenant ON consent_events FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
CREATE POLICY legal_holds_tenant ON legal_holds FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());

-- api_keys remains a narrowly documented exception: authentication must find
-- a key prefix before the tenant is known. It retains the migration-023 policy
-- until lookup moves behind a security-definer function/dedicated auth role.
