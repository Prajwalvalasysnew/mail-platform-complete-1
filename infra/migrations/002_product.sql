-- =====================================================
-- Migration 002 - Templates, usage metering, audit log
-- =====================================================

-- =====================================================
-- Email templates (reusable, versioned by updated_at)
-- =====================================================
CREATE TABLE templates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    subject         TEXT NOT NULL,
    html_body       TEXT,
    text_body       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, name)
);

CREATE INDEX idx_templates_customer ON templates(customer_id);

CREATE TRIGGER templates_updated_at
    BEFORE UPDATE ON templates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================
-- Usage records (for billing / metering)
-- One row per day per customer, upserted as mail is sent.
-- =====================================================
CREATE TABLE usage_daily (
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    usage_date      DATE NOT NULL,
    sent            INTEGER NOT NULL DEFAULT 0,
    delivered       INTEGER NOT NULL DEFAULT 0,
    bounced         INTEGER NOT NULL DEFAULT 0,
    complained      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (customer_id, usage_date)
);

CREATE INDEX idx_usage_date ON usage_daily(usage_date);

-- =====================================================
-- Billing plans + customer subscription state
-- =====================================================
ALTER TABLE customers ADD COLUMN IF NOT EXISTS monthly_quota INTEGER NOT NULL DEFAULT 3000;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'active'
    CHECK (billing_status IN ('active', 'past_due', 'canceled', 'trialing'));

-- =====================================================
-- Audit log (security-relevant actions)
-- =====================================================
CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    customer_id     UUID,
    api_key_id      UUID,
    action          TEXT NOT NULL,
    resource        TEXT,
    ip              INET,
    metadata        JSONB DEFAULT '{}'::JSONB,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_customer ON audit_log(customer_id, occurred_at DESC);

-- =====================================================
-- Message review queue (content flagged by abuse scanner)
-- =====================================================
CREATE TABLE review_queue (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id      TEXT NOT NULL,
    customer_id     UUID NOT NULL,
    risk_score      INTEGER NOT NULL,
    reasons         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at     TIMESTAMPTZ
);

CREATE INDEX idx_review_pending ON review_queue(status, created_at) WHERE status = 'pending';

-- Add template reference + provider message id to messages
ALTER TABLE messages ADD COLUMN IF NOT EXISTS template_id UUID;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS risk_score INTEGER DEFAULT 0;
