-- =====================================================
-- Mail Platform - Human identity & sessions
--
-- Everything customer-facing so far has been API-key only. Dashboards, the
-- admin console, support tooling, and "teammates" all need *human* identities
-- with passwords/MFA and sessions — distinct from programmatic API keys.
--
-- Model (SendGrid "Teammates" style):
--   users        — a person (global, one row per human, identified by email)
--   memberships  — user <-> customer (org) with a role; a user can belong to many
--   user_sessions— browser/CLI login sessions (opaque token, hashed at rest)
--   mfa_factors  — TOTP authenticators (secret encrypted at rest)
--   mfa_recovery_codes — one-time backup codes (hashed)
--   user_tokens  — short-lived email-verify / password-reset tokens (hashed)
--   user_invites — pending teammate invitations (hashed token)
--
-- `customers` stays the account/tenant; this is purely additive and does not
-- alter existing tables, so existing API-key flows are unaffected.
-- =====================================================

-- ---------- users ----------
CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email               TEXT NOT NULL,
    name                TEXT,
    -- Nullable: SSO/OIDC-only users have no local password.
    password_hash       TEXT,
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    email_verified_at   TIMESTAMPTZ,
    mfa_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Email is the human login identifier; enforce case-insensitive uniqueness.
-- (The app lowercases on write; this index is the hard guarantee.)
CREATE UNIQUE INDEX idx_users_email_lower ON users (lower(email));

-- ---------- memberships ----------
-- A user's role is scoped to a customer (org). Ascending privilege:
--   analyst < developer < billing < admin < owner
-- (billing sits beside developer in scope but is broken out so finance-only
--  staff can be granted billing without sending/API access.)
CREATE TABLE memberships (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'developer'
                        CHECK (role IN ('owner', 'admin', 'developer', 'analyst', 'billing')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, customer_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);
CREATE INDEX idx_memberships_customer ON memberships(customer_id);

-- ---------- user_sessions ----------
-- Opaque high-entropy token, stored only as an HMAC hash (never plaintext).
-- current_customer_id is the active org context for the session (a user with
-- multiple memberships switches org without re-authenticating).
CREATE TABLE user_sessions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash          TEXT NOT NULL UNIQUE,
    current_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    ip                  TEXT,
    user_agent          TEXT,
    -- Sessions that have passed the MFA challenge. A password-only session is
    -- "pending" until the second factor is satisfied.
    mfa_satisfied       BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at          TIMESTAMPTZ NOT NULL,
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires ON user_sessions(expires_at) WHERE revoked_at IS NULL;

-- ---------- mfa_factors ----------
-- TOTP secret is sensitive; stored encrypted at rest via the envelope scheme in
-- encryption.ts (column holds ciphertext, not the raw base32 secret).
CREATE TABLE mfa_factors (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type                TEXT NOT NULL DEFAULT 'totp' CHECK (type IN ('totp')),
    secret_encrypted    TEXT NOT NULL,
    -- Null until the user confirms a first valid code (proves enrollment worked).
    confirmed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_mfa_factors_user ON mfa_factors(user_id);

-- ---------- mfa_recovery_codes ----------
CREATE TABLE mfa_recovery_codes (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash   TEXT NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_mfa_recovery_user ON mfa_recovery_codes(user_id) WHERE used_at IS NULL;

-- ---------- user_tokens ----------
-- Short-lived, single-use, hashed tokens for email verification and password
-- reset. Kept generic via `purpose` so we add flows without new tables.
CREATE TABLE user_tokens (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     TEXT NOT NULL CHECK (purpose IN ('email_verify', 'password_reset')),
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_user_tokens_user ON user_tokens(user_id, purpose) WHERE used_at IS NULL;

-- ---------- user_invites ----------
-- Pending teammate invitations. The invitee may not yet have a users row; on
-- acceptance we create/link the user and a membership with the stored role.
CREATE TABLE user_invites (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email               TEXT NOT NULL,
    role                TEXT NOT NULL DEFAULT 'developer'
                            CHECK (role IN ('owner', 'admin', 'developer', 'analyst', 'billing')),
    token_hash          TEXT NOT NULL UNIQUE,
    invited_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    accepted_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, email)
);
CREATE INDEX idx_user_invites_customer ON user_invites(customer_id);
