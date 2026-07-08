-- =====================================================
-- Mail Platform - Phase 2/3/4 scale, deliverability, trust, billing
--   Adds: sending IPs + per-IP reputation, blocklist tracking, DKIM selector
--   rotation, ARC, KYC, spam-trap domains, GDPR deletion log, billing
--   subscriptions + invoices + metering reconciliation, admin users + sessions,
--   message body offload pointers, monthly partitioning helpers, durable volume
--   baselines, and a migrations bookkeeping table.
-- =====================================================

-- =====================================================
-- Migration bookkeeping (used by the Node migration runner)
-- =====================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checksum    TEXT
);

-- =====================================================
-- Sending IPs + per-IP warmup and reputation
-- =====================================================
CREATE TABLE IF NOT EXISTS sending_ips (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ip              INET NOT NULL UNIQUE,
    pool_id         UUID REFERENCES ip_pools(id) ON DELETE SET NULL,
    ptr_record      TEXT,
    warmup_stage    INTEGER NOT NULL DEFAULT 0,
    warmup_started  DATE,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'retired')),
    dedicated_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sending_ips_pool ON sending_ips(pool_id);
CREATE INDEX IF NOT EXISTS idx_sending_ips_status ON sending_ips(status);

-- Per-IP, per-day reputation snapshot (ingested from Postmaster/SNDS + computed locally)
CREATE TABLE IF NOT EXISTS ip_reputation (
    ip              INET NOT NULL,
    snapshot_date   DATE NOT NULL,
    sent            INTEGER NOT NULL DEFAULT 0,
    delivered       INTEGER NOT NULL DEFAULT 0,
    bounced         INTEGER NOT NULL DEFAULT 0,
    complained      INTEGER NOT NULL DEFAULT 0,
    bounce_rate     NUMERIC(6,5) NOT NULL DEFAULT 0,
    complaint_rate  NUMERIC(6,5) NOT NULL DEFAULT 0,
    google_reputation TEXT,        -- HIGH | MEDIUM | LOW | BAD (Postmaster)
    google_spam_rate  NUMERIC(6,5),
    snds_color        TEXT,        -- green | yellow | red (Microsoft SNDS)
    PRIMARY KEY (ip, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_ip_reputation_date ON ip_reputation(snapshot_date);

-- Blocklist check results per IP
CREATE TABLE IF NOT EXISTS blocklist_checks (
    id              BIGSERIAL PRIMARY KEY,
    ip              INET NOT NULL,
    provider        TEXT NOT NULL,  -- spamhaus_zen, spamcop, barracuda, sorbs ...
    listed          BOOLEAN NOT NULL,
    return_code     TEXT,
    checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_blocklist_ip_time ON blocklist_checks(ip, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_blocklist_listed ON blocklist_checks(listed, checked_at DESC) WHERE listed = TRUE;

-- =====================================================
-- DKIM selector rotation: multiple selectors per domain, one active
-- =====================================================
CREATE TABLE IF NOT EXISTS dkim_keys (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    domain_id       UUID NOT NULL REFERENCES sending_domains(id) ON DELETE CASCADE,
    selector        TEXT NOT NULL,
    public_key      TEXT NOT NULL,
    private_key     TEXT NOT NULL,         -- AES-256-GCM ciphertext
    state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active', 'retiring', 'retired')),
    activated_at    TIMESTAMPTZ,
    retired_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (domain_id, selector)
);
CREATE INDEX IF NOT EXISTS idx_dkim_keys_domain_state ON dkim_keys(domain_id, state);

-- =====================================================
-- KYC / verification records
-- =====================================================
ALTER TABLE customers ADD COLUMN IF NOT EXISTS kyc_level TEXT NOT NULL DEFAULT 'email'
    CHECK (kyc_level IN ('email', 'domain', 'payment', 'business'));
ALTER TABLE customers ADD COLUMN IF NOT EXISTS new_account_until TIMESTAMPTZ;

-- =====================================================
-- Spam-trap / disposable / dirty domains for list-quality scoring
-- =====================================================
CREATE TABLE IF NOT EXISTS recipient_domain_intel (
    domain          TEXT PRIMARY KEY,
    category        TEXT NOT NULL CHECK (category IN ('spam_trap', 'disposable', 'role', 'high_bounce', 'clean')),
    notes           TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =====================================================
-- Soft-bounce escalation tracking
-- =====================================================
CREATE TABLE IF NOT EXISTS soft_bounce_tracker (
    customer_id     UUID NOT NULL,
    email           TEXT NOT NULL,
    count           INTEGER NOT NULL DEFAULT 0,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, email)
);

-- =====================================================
-- GDPR / data-deletion request log
-- =====================================================
CREATE TABLE IF NOT EXISTS deletion_requests (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    recipient       TEXT NOT NULL,
    requested_by    TEXT,
    messages_deleted INTEGER NOT NULL DEFAULT 0,
    events_deleted   INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deletion_customer ON deletion_requests(customer_id, created_at DESC);

-- =====================================================
-- Billing: subscriptions + invoices + metering reconciliation
-- =====================================================
CREATE TABLE IF NOT EXISTS subscriptions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL DEFAULT 'stripe',
    provider_subscription_id TEXT UNIQUE,
    price_id        TEXT,
    plan            TEXT NOT NULL DEFAULT 'free',
    status          TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'past_due', 'canceled', 'trialing', 'incomplete', 'unpaid')),
    current_period_start TIMESTAMPTZ,
    current_period_end   TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id);

CREATE TABLE IF NOT EXISTS invoices (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    provider_invoice_id TEXT UNIQUE,
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    billed_quantity INTEGER NOT NULL DEFAULT 0,   -- emails billed
    metered_quantity INTEGER NOT NULL DEFAULT 0,  -- emails we metered (for reconciliation)
    amount_cents    INTEGER NOT NULL DEFAULT 0,
    currency        TEXT NOT NULL DEFAULT 'usd',
    status          TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
    drift           INTEGER NOT NULL DEFAULT 0,   -- metered - billed
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id, period_start DESC);

-- Idempotent billing webhook event log (replay protection)
CREATE TABLE IF NOT EXISTS billing_events (
    provider_event_id TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Quota-usage notification log (so we alert once per threshold per period)
CREATE TABLE IF NOT EXISTS quota_notifications (
    customer_id     UUID NOT NULL,
    period          TEXT NOT NULL,   -- e.g. '2026-05' (monthly) or '2026-05-28' (daily)
    threshold       INTEGER NOT NULL,  -- 80 or 100
    notified_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, period, threshold)
);

-- =====================================================
-- Admin authz plane (separate from customer API keys)
-- =====================================================
CREATE TABLE IF NOT EXISTS admin_users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           TEXT NOT NULL UNIQUE,
    name            TEXT,
    role            TEXT NOT NULL DEFAULT 'support'
        CHECK (role IN ('support', 'operator', 'admin', 'superadmin')),
    oidc_subject    TEXT UNIQUE,       -- subject claim from SSO/OIDC provider
    disabled        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS admin_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_user_id   UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(admin_user_id);

-- =====================================================
-- Message body offload pointers (S3) — keep metadata hot in Postgres
-- =====================================================
ALTER TABLE messages ADD COLUMN IF NOT EXISTS body_storage TEXT NOT NULL DEFAULT 'inline'
    CHECK (body_storage IN ('inline', 's3'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS body_object_key TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS body_size INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS body_hash TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS send_at TIMESTAMPTZ;

-- =====================================================
-- Per-API-key publishable/secret + test-mode flag
-- =====================================================
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_type TEXT NOT NULL DEFAULT 'secret'
    CHECK (key_type IN ('secret', 'publishable', 'test'));
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rotated_from UUID;

-- =====================================================
-- Durable volume baselines (so a Redis flush is treated as suspicious, not permissive)
-- =====================================================
CREATE TABLE IF NOT EXISTS volume_baselines (
    customer_id     UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    hourly_baseline INTEGER NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed three default sending IPs into the pools (documentation IPs; replace in prod)
INSERT INTO sending_ips (ip, pool_id, warmup_stage, warmup_started, status)
SELECT '192.0.2.10'::inet, id, 0, CURRENT_DATE, 'active' FROM ip_pools WHERE name = 'transactional'
ON CONFLICT (ip) DO NOTHING;
INSERT INTO sending_ips (ip, pool_id, warmup_stage, warmup_started, status)
SELECT '192.0.2.11'::inet, id, 0, CURRENT_DATE, 'active' FROM ip_pools WHERE name = 'marketing'
ON CONFLICT (ip) DO NOTHING;

CREATE TRIGGER subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
