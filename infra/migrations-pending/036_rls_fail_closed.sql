-- ============================================================================
-- STATUS: application-code rollout is COMPLETE (see
-- docs/RLS_FAIL_CLOSED_ROLLOUT.md for the verified checklist — every
-- production request-path touch of the 8 tables below now runs through
-- tenantScoped()/withTenant()). This file is still gated out of
-- infra/migrations/ (the auto-applied directory) because the remaining steps
-- are OPERATIONAL, not code:
--
--   1. Run scripts/setup-rls-roles.sql against the target database.
--   2. Point each service's DATABASE_URL at the correct role (API -> mail_api,
--      everything else -> mail_service).
--   3. Load-test /send/batch (see the rollout doc's "Follow-up on send.ts"
--      item) — the per-recipient suppression check in the batch handler now
--      opens one short transaction per recipient; confirm that's acceptable
--      at your expected batch sizes/volume before going live with this.
--   4. Run the two-customer cross-tenant smoke test described in the rollout
--      doc against a staging database.
--
-- Once all four are done, move this file into infra/migrations/ under the
-- next free sequence number and run it through the normal migration pipeline.
-- ============================================================================

-- Row-Level Security, fail-closed: removes the `OR current_tenant_id() IS
-- NULL` escape hatch from 023_rls.sql. Without app.customer_id set on the
-- session, queries against these tables now match zero rows instead of all
-- rows. Also FORCE ROW LEVEL SECURITY so even the table owner is subject to
-- the policy (only a role with BYPASSRLS, e.g. the worker/admin service role
-- from scripts/setup-rls-roles.sql, can see all tenants' rows).

ALTER TABLE messages        FORCE ROW LEVEL SECURITY;
ALTER TABLE events          FORCE ROW LEVEL SECURITY;
ALTER TABLE suppressions    FORCE ROW LEVEL SECURITY;
ALTER TABLE templates       FORCE ROW LEVEL SECURITY;
ALTER TABLE sending_domains FORCE ROW LEVEL SECURITY;
ALTER TABLE webhooks        FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys        FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_daily     FORCE ROW LEVEL SECURITY;
ALTER TABLE review_queue    FORCE ROW LEVEL SECURITY;
ALTER TABLE consent_events  FORCE ROW LEVEL SECURITY;
ALTER TABLE legal_holds     FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS messages_tenant        ON messages;
DROP POLICY IF EXISTS events_tenant          ON events;
DROP POLICY IF EXISTS suppressions_tenant    ON suppressions;
DROP POLICY IF EXISTS templates_tenant       ON templates;
DROP POLICY IF EXISTS sending_domains_tenant ON sending_domains;
DROP POLICY IF EXISTS webhooks_tenant        ON webhooks;
DROP POLICY IF EXISTS api_keys_tenant        ON api_keys;
DROP POLICY IF EXISTS usage_daily_tenant     ON usage_daily;
DROP POLICY IF EXISTS review_queue_tenant    ON review_queue;
DROP POLICY IF EXISTS consent_events_tenant  ON consent_events;
DROP POLICY IF EXISTS legal_holds_tenant     ON legal_holds;

-- api_keys is intentionally excluded from the fail-closed set below: the
-- API-key auth lookup (packages/api/src/plugins/auth.ts) happens BEFORE the
-- tenant is known (it looks up a key by prefix across all customers to find
-- out who the caller is) — a chicken-and-egg problem no amount of
-- withTenant() wiring can fix, since you need the key to know the tenant.
-- Leave its existing (null-tenant-permissive) policy in place; it stays
-- protected by the app-level WHERE key_prefix filter plus HMAC verification,
-- and by requiring a dedicated non-BYPASSRLS, least-privilege role for the
-- API (see scripts/setup-rls-roles.sql) rather than by RLS row-scoping.
CREATE POLICY api_keys_tenant ON api_keys
  USING (customer_id = current_tenant_id() OR current_tenant_id() IS NULL);

CREATE POLICY messages_tenant ON messages
  USING (customer_id = current_tenant_id());

CREATE POLICY events_tenant ON events
  USING (customer_id = current_tenant_id());

CREATE POLICY suppressions_tenant ON suppressions
  USING (customer_id = current_tenant_id());

CREATE POLICY templates_tenant ON templates
  USING (customer_id = current_tenant_id());

CREATE POLICY sending_domains_tenant ON sending_domains
  USING (customer_id = current_tenant_id());

CREATE POLICY webhooks_tenant ON webhooks
  USING (customer_id = current_tenant_id());

CREATE POLICY usage_daily_tenant ON usage_daily
  USING (customer_id = current_tenant_id());

CREATE POLICY review_queue_tenant ON review_queue
  USING (customer_id = current_tenant_id());

CREATE POLICY consent_events_tenant ON consent_events
  USING (customer_id = current_tenant_id());

CREATE POLICY legal_holds_tenant ON legal_holds
  USING (customer_id = current_tenant_id());
