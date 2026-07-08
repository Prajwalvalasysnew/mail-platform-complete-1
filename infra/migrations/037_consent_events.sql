-- Consent ledger (gap analysis Top-20 #8).
--
-- `suppressions` stores only the CURRENT opt-out state (mutable, one row per
-- recipient). For GDPR / CAN-SPAM compliance you must be able to PROVE the
-- history: when a recipient opted out, why, through what channel, and when they
-- were resubscribed. This append-only ledger records every consent-affecting
-- event so that history is auditable and non-repudiable.
--
-- Append-only by design: rows are INSERTed on every suppression add/remove and
-- never updated or deleted (except by the recipient-erasure path, which is
-- itself a logged consent action). There is deliberately no UPDATE path.

CREATE TABLE IF NOT EXISTS consent_events (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email           TEXT NOT NULL,
    -- The direction of the consent change:
    --   suppress   -> recipient was added to the suppression list (opt-out)
    --   unsuppress -> recipient was removed from the suppression list (opt-in / resubscribe)
    action          TEXT NOT NULL CHECK (action IN ('suppress', 'unsuppress')),
    -- Why it happened (mirrors suppression reasons; 'resubscribe'/'erasure' for removals).
    reason          TEXT NOT NULL,
    -- Where the change originated, for audit: 'api', 'one_click_unsubscribe',
    -- 'bounce_escalation', 'complaint', 'bulk_import', 'gdpr_erasure', 'admin'.
    source          TEXT NOT NULL DEFAULT 'api',
    -- Optional free-text note and the message id that triggered it (e.g. the
    -- email whose List-Unsubscribe link was clicked).
    notes           TEXT,
    message_id      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary access pattern: full history for one recipient under one customer,
-- newest first.
CREATE INDEX IF NOT EXISTS idx_consent_events_customer_email
    ON consent_events (customer_id, email, created_at DESC);

-- RLS: consent_events is tenant-scoped, mirroring the permissive 023_rls.sql
-- policy (allows all rows when current_tenant_id() is unset, for worker/admin
-- service-role access). The pending fail-closed migration
-- (infra/migrations-pending/036_rls_fail_closed.sql) removes the null-tenant
-- escape hatch for this table too once the rollout is complete.
ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY consent_events_tenant ON consent_events
  USING (customer_id = current_tenant_id() OR current_tenant_id() IS NULL);
