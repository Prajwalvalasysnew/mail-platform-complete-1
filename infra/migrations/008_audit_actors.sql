-- =====================================================
-- Mail Platform - Audit actor attribution
--
-- The audit_log already records customer_id, action, resource, ip, metadata.
-- To power an account "activity log" (à la SendGrid Teammate Activity) we also
-- need to know *who* performed each action — a human user, an API key, an
-- internal admin, or the system itself. These columns are additive and
-- nullable, so every existing audit row (and the existing admin audit writer)
-- keeps working unchanged.
-- =====================================================

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_type  TEXT
    CHECK (actor_type IN ('user', 'api_key', 'admin', 'system'));
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_id    UUID;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_label TEXT;   -- e.g. email, for display

-- Support filtering the activity feed by action and by actor.
CREATE INDEX IF NOT EXISTS idx_audit_customer_action ON audit_log(customer_id, action);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_type, actor_id);
