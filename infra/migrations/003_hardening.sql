-- =====================================================
-- Mail Platform - Phase 1 hardening
--   1. Add 'held' message status (content held for manual review)
--   2. Idempotency keys for POST /v1/send (prevent double-sends on retry)
-- =====================================================

-- ---------- 1. 'held' status ----------
-- Messages flagged by the content scanner for manual review must NOT sit in
-- 'queued' (the send worker only processes 'queued'). They go to 'held' and are
-- moved to 'queued' only when an operator approves them.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check CHECK (status IN (
    'queued', 'held', 'sending', 'accepted', 'delivered',
    'soft_bounced', 'hard_bounced', 'failed', 'suppressed'
));

-- ---------- 2. Idempotency keys ----------
-- A client may safely retry POST /v1/send with the same Idempotency-Key header.
-- We store the first response and replay it for any subsequent request with the
-- same (customer_id, idempotency_key) within the retention window.
CREATE TABLE IF NOT EXISTS idempotency_keys (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    request_hash    TEXT NOT NULL,            -- hash of the request body; mismatch => 422
    status_code     INTEGER,                  -- null until the first request completes
    response_body   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    UNIQUE (customer_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
