-- SCIM 2.0 provisioning support for customer (enterprise) tenants.
-- Gap analysis Top-20 #9: "Admin OIDC exists; customer enterprise SSO/SCIM is
-- not complete." This adds the persistence for SCIM user provisioning and
-- deprovisioning (RFC 7644): a per-tenant bearer token the IdP authenticates
-- with, and columns on users to carry the SCIM externalId + active flag.

-- Per-tenant SCIM bearer token. The IdP (Okta / Entra ID / etc.) presents this
-- as `Authorization: Bearer <token>` on the SCIM base URL. Stored only as an
-- HMAC hash (never plaintext), mirroring how api_keys and sessions are stored.
CREATE TABLE IF NOT EXISTS scim_tokens (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,          -- HMAC-SHA256 of the bearer token
    token_prefix    TEXT NOT NULL,          -- first chars, for identification in listings
    label           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scim_tokens_hash ON scim_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_scim_tokens_customer ON scim_tokens(customer_id);

-- SCIM linkage on users. externalId is the IdP's stable identifier for the
-- user; scim_active mirrors the SCIM `active` attribute (deprovisioning sets it
-- false rather than hard-deleting, so audit history and memberships survive).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS scim_external_id TEXT,
  ADD COLUMN IF NOT EXISTS scim_managed BOOLEAN NOT NULL DEFAULT FALSE;

-- externalId is unique per provisioning source; enforce per (customer via
-- membership is many-to-many, so uniqueness is on the IdP externalId globally
-- among SCIM-managed users). A partial unique index avoids colliding with
-- non-SCIM users that have a null externalId.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_scim_external_id
  ON users (scim_external_id) WHERE scim_external_id IS NOT NULL;
