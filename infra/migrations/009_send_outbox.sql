-- Durable send outbox.
--
-- The API accepts messages by committing message rows and outbox rows together.
-- BullMQ enqueueing can then be retried safely if Redis is briefly unavailable
-- after the database commit.

CREATE TABLE IF NOT EXISTS send_outbox (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id      TEXT NOT NULL UNIQUE REFERENCES messages(message_id) ON DELETE CASCADE,
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    priority        INTEGER NOT NULL DEFAULT 10,
    run_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'enqueued', 'failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    enqueued_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_send_outbox_pending
    ON send_outbox (run_at, created_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_send_outbox_customer_status
    ON send_outbox (customer_id, status, created_at DESC);

CREATE TRIGGER send_outbox_updated_at
    BEFORE UPDATE ON send_outbox
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
