-- =====================================================
-- Mail Platform - Initial Schema
-- =====================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =====================================================
-- Customers (tenants)
-- =====================================================
CREATE TABLE customers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           TEXT NOT NULL UNIQUE,
    name            TEXT,
    tier            TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'paid', 'enterprise')),
    daily_quota     INTEGER NOT NULL DEFAULT 100,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'banned')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customers_email ON customers(email);
CREATE INDEX idx_customers_status ON customers(status);

-- =====================================================
-- API Keys
-- =====================================================
CREATE TABLE api_keys (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    key_prefix      TEXT NOT NULL,           -- first 8 chars for identification, e.g. 'mp_live_'
    key_hash        TEXT NOT NULL,           -- bcrypt hash of the full key
    scopes          TEXT[] DEFAULT ARRAY['send']::TEXT[],
    last_used_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_customer ON api_keys(customer_id);
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix) WHERE revoked_at IS NULL;

-- =====================================================
-- Sending Domains (verified per customer)
-- =====================================================
CREATE TABLE sending_domains (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    domain              TEXT NOT NULL,
    dkim_selector       TEXT NOT NULL DEFAULT 'default',
    dkim_public_key     TEXT NOT NULL,
    dkim_private_key    TEXT NOT NULL,        -- encrypted at rest in production!
    verified_at         TIMESTAMPTZ,
    verification_token  TEXT NOT NULL DEFAULT encode(gen_random_bytes(16), 'hex'),
    spf_verified        BOOLEAN DEFAULT FALSE,
    dkim_verified       BOOLEAN DEFAULT FALSE,
    dmarc_verified      BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, domain)
);

CREATE INDEX idx_sending_domains_customer ON sending_domains(customer_id);
CREATE INDEX idx_sending_domains_domain ON sending_domains(domain);

-- =====================================================
-- Messages (every email we accept for delivery)
-- =====================================================
CREATE TABLE messages (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id          TEXT NOT NULL UNIQUE,   -- RFC 5322 Message-ID
    customer_id         UUID NOT NULL REFERENCES customers(id),
    from_address        TEXT NOT NULL,
    from_name           TEXT,
    to_address          TEXT NOT NULL,
    reply_to            TEXT,
    subject             TEXT NOT NULL,
    html_body           TEXT,
    text_body           TEXT,
    headers             JSONB DEFAULT '{}'::JSONB,
    tags                TEXT[] DEFAULT ARRAY[]::TEXT[],
    metadata            JSONB DEFAULT '{}'::JSONB,
    tracking_opens      BOOLEAN DEFAULT TRUE,
    tracking_clicks     BOOLEAN DEFAULT TRUE,
    ip_pool             TEXT DEFAULT 'transactional',
    status              TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
                            'queued', 'sending', 'accepted', 'delivered',
                            'soft_bounced', 'hard_bounced', 'failed', 'suppressed'
                        )),
    smtp_response       TEXT,
    failure_reason      TEXT,
    queued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at         TIMESTAMPTZ,
    delivered_at        TIMESTAMPTZ,
    bounced_at          TIMESTAMPTZ,
    opened_at           TIMESTAMPTZ,
    first_clicked_at    TIMESTAMPTZ,
    attempts            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_messages_customer_queued ON messages(customer_id, queued_at DESC);
CREATE INDEX idx_messages_status ON messages(status) WHERE status IN ('queued', 'sending');
CREATE INDEX idx_messages_to ON messages(to_address);
CREATE INDEX idx_messages_tags ON messages USING GIN(tags);

-- =====================================================
-- Events (delivery, opens, clicks, bounces, complaints)
-- =====================================================
CREATE TABLE events (
    id              BIGSERIAL PRIMARY KEY,
    message_id      TEXT NOT NULL,
    customer_id     UUID NOT NULL,
    event_type      TEXT NOT NULL CHECK (event_type IN (
                        'queued', 'sent', 'delivered', 'soft_bounce', 'hard_bounce',
                        'complaint', 'opened', 'clicked', 'unsubscribed', 'failed'
                    )),
    payload         JSONB DEFAULT '{}'::JSONB,
    ip              INET,
    user_agent      TEXT,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_message ON events(message_id, occurred_at);
CREATE INDEX idx_events_customer_time ON events(customer_id, occurred_at DESC);
CREATE INDEX idx_events_type ON events(event_type, occurred_at DESC);

-- =====================================================
-- Suppression list (hard bounces, complaints, unsubscribes)
-- =====================================================
CREATE TABLE suppressions (
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email           TEXT NOT NULL,
    reason          TEXT NOT NULL CHECK (reason IN (
                        'hard_bounce', 'complaint', 'unsubscribe', 'manual', 'invalid'
                    )),
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, email)
);

CREATE INDEX idx_suppressions_email ON suppressions(email);

-- =====================================================
-- Tracked links (for click tracking)
-- =====================================================
CREATE TABLE tracked_links (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id      TEXT NOT NULL,
    original_url    TEXT NOT NULL,
    label           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tracked_links_message ON tracked_links(message_id);

-- =====================================================
-- Webhooks (customer-configured event subscriptions)
-- =====================================================
CREATE TABLE webhooks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    url             TEXT NOT NULL,
    secret          TEXT NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
    events          TEXT[] NOT NULL DEFAULT ARRAY['delivered', 'bounced', 'complaint']::TEXT[],
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhooks_customer ON webhooks(customer_id) WHERE enabled = TRUE;

-- =====================================================
-- IP Pools (which IPs/MTAs to route through)
-- =====================================================
CREATE TABLE ip_pools (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL UNIQUE,
    description     TEXT,
    is_default      BOOLEAN DEFAULT FALSE,
    warmup_stage    INTEGER DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ip_pools (name, description, is_default)
VALUES
    ('transactional', 'High-priority transactional mail', TRUE),
    ('marketing', 'Bulk marketing campaigns', FALSE),
    ('quarantine', 'Suspect/new senders under review', FALSE);

-- =====================================================
-- Update trigger for updated_at
-- =====================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER customers_updated_at
    BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
