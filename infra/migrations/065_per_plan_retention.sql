-- Per-plan / per-tenant retention windows (DATABASE_10_10_PLAN Phase 2.1).
--
-- SendGrid ships 3 days of activity history by default and sells 30; Mailgun
-- tiers log retention 1–30 days by plan; Postmark sells 7–365 days. This adds
-- the same commercial lever: retention windows on the plan catalog, plus
-- per-customer overrides for enterprise deals.
--
-- Model: LOGICAL retention on reads, PHYSICAL purge at the platform ceiling.
--   - The platform env windows (RETENTION_EVENT_DAYS / RETENTION_BODY_DAYS /
--     RETENTION_MESSAGE_DAYS) remain the physical ceiling: partition drops
--     and the row-level sweeps never keep anything longer than those.
--   - A tenant's effective window = customer override, else plan value, else
--     the platform default. Events windows can only TIGHTEN (the partition
--     ceiling is physical); body windows may extend up to the message-row
--     lifetime (bodies are purged per-tenant).
--   - Tenants with NO plan value and NO override keep exactly today's
--     behavior — logical read filtering activates only for explicit windows,
--     so existing API consumers see no surprise history loss.
--
-- NULL = "no explicit window" (inherit platform default) at every level.

ALTER TABLE billing_plans
  ADD COLUMN IF NOT EXISTS events_retention_days INTEGER
    CHECK (events_retention_days IS NULL OR events_retention_days > 0),
  ADD COLUMN IF NOT EXISTS body_retention_days INTEGER
    CHECK (body_retention_days IS NULL OR body_retention_days > 0);

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS events_retention_days INTEGER
    CHECK (events_retention_days IS NULL OR events_retention_days > 0),
  ADD COLUMN IF NOT EXISTS body_retention_days INTEGER
    CHECK (body_retention_days IS NULL OR body_retention_days > 0);

-- Catalog defaults per tier (only where not already set, so operators who
-- customized the catalog aren't overridden).
UPDATE billing_plans SET events_retention_days = 7,   body_retention_days = 7
  WHERE plan_key = 'free' AND events_retention_days IS NULL;
UPDATE billing_plans SET events_retention_days = 30,  body_retention_days = 30
  WHERE plan_key = 'starter' AND events_retention_days IS NULL;
UPDATE billing_plans SET events_retention_days = 90,  body_retention_days = 90
  WHERE plan_key = 'pro' AND events_retention_days IS NULL;
UPDATE billing_plans SET events_retention_days = 365, body_retention_days = 90
  WHERE plan_key = 'enterprise' AND events_retention_days IS NULL;
