-- Admin console backend gaps (design parity for the confirmed console design):
--
--  1. KYC decision workflow: the console design has Approve / More info /
--     Reject per tenant. `kyc_level` (email/domain/payment/business) stays the
--     capability ladder; `kyc_status` is the review-decision state driven by
--     the new /admin/kyc/* endpoints.
--  2. platform_settings: key/value (JSONB) store backing the Settings screen
--     panels (default quotas, bounce thresholds, warmup, security) and the
--     payment-gateway enable toggles. Secrets never live here.
--  3. Cookie sessions + CSRF: admin sessions gain a per-session CSRF secret
--     hash and an audience tag so the __Host- cookie plane is bound to the
--     admin console and mutations can enforce a CSRF token.
--  4. Audit cursor pagination: partial index so `WHERE action LIKE 'admin:%'
--     AND id < cursor ORDER BY id DESC` stays index-driven as the log grows.

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS kyc_status TEXT NOT NULL DEFAULT 'none'
        CHECK (kyc_status IN ('none', 'pending', 'more_info', 'approved', 'rejected')),
    ADD COLUMN IF NOT EXISTS kyc_note TEXT,
    ADD COLUMN IF NOT EXISTS kyc_submitted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS kyc_reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS kyc_reviewed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL;

-- The review queue is small relative to the tenant population; a partial
-- index keeps the "needs a decision" scan cheap.
CREATE INDEX IF NOT EXISTS idx_customers_kyc_open
    ON customers (kyc_submitted_at ASC)
    WHERE kyc_status IN ('pending', 'more_info');

CREATE TABLE IF NOT EXISTS platform_settings (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_by  UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE admin_sessions
    ADD COLUMN IF NOT EXISTS csrf_hash TEXT,
    ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'admin';

CREATE INDEX IF NOT EXISTS idx_audit_log_admin_cursor
    ON audit_log (id DESC)
    WHERE action LIKE 'admin:%';
