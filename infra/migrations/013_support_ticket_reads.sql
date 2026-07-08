-- Per-viewer read state for support ticket inboxes.

CREATE TABLE IF NOT EXISTS support_ticket_reads (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id       UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    viewer_type     TEXT NOT NULL CHECK (viewer_type IN ('customer_user', 'admin')),
    viewer_user_id  UUID REFERENCES users(id) ON DELETE CASCADE,
    viewer_admin_user_id UUID REFERENCES admin_users(id) ON DELETE CASCADE,
    last_read_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
      (viewer_type = 'customer_user' AND viewer_user_id IS NOT NULL AND viewer_admin_user_id IS NULL)
      OR (viewer_type = 'admin' AND viewer_admin_user_id IS NOT NULL AND viewer_user_id IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_ticket_reads_customer_user
    ON support_ticket_reads (ticket_id, viewer_user_id)
    WHERE viewer_type = 'customer_user';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_ticket_reads_admin
    ON support_ticket_reads (ticket_id, viewer_admin_user_id)
    WHERE viewer_type = 'admin';

CREATE INDEX IF NOT EXISTS idx_support_ticket_reads_user
    ON support_ticket_reads (viewer_user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_ticket_reads_admin
    ON support_ticket_reads (viewer_admin_user_id, updated_at DESC);

CREATE TRIGGER support_ticket_reads_updated_at
    BEFORE UPDATE ON support_ticket_reads
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
