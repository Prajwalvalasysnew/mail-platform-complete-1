-- Support ticket/conversation backend for admin console and future customer chat.

CREATE TABLE IF NOT EXISTS support_tickets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    subject         TEXT NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 300),
    status          TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
    priority        TEXT NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    category        TEXT NOT NULL DEFAULT 'general'
        CHECK (category IN ('general', 'billing', 'deliverability', 'technical', 'abuse', 'account')),
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    assigned_admin_user_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_customer_status
    ON support_tickets (customer_id, status, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned_status
    ON support_tickets (assigned_admin_user_id, status, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status_priority
    ON support_tickets (status, priority, last_message_at DESC);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id       UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    author_type     TEXT NOT NULL CHECK (author_type IN ('customer_user', 'admin', 'system')),
    author_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    author_admin_user_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    body            TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
    internal        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
      (author_type = 'customer_user' AND author_user_id IS NOT NULL AND author_admin_user_id IS NULL AND internal = FALSE)
      OR (author_type = 'admin' AND author_admin_user_id IS NOT NULL AND author_user_id IS NULL)
      OR (author_type = 'system' AND author_user_id IS NULL AND author_admin_user_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket_created
    ON support_ticket_messages (ticket_id, created_at ASC);

CREATE TRIGGER support_tickets_updated_at
    BEFORE UPDATE ON support_tickets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
