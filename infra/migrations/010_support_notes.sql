-- Internal support notes for the admin console.
--
-- These are operator-authored notes attached to a customer for support handoffs,
-- incident follow-up, billing context, or deliverability investigations. They
-- are internal-only and separate from immutable admin audit events.

CREATE TABLE IF NOT EXISTS support_notes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    admin_user_id   UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    body            TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
    visibility      TEXT NOT NULL DEFAULT 'internal'
        CHECK (visibility IN ('internal', 'escalation')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_notes_customer_created
    ON support_notes (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_notes_admin_created
    ON support_notes (admin_user_id, created_at DESC);
