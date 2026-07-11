-- WebAuthn / passkeys (phishing-resistant MFA).
--
-- Stores registered public-key credentials and single-use ceremony challenges.
-- The private key never leaves the authenticator; we keep only the public key
-- (SPKI PEM), the COSE algorithm, and the signature counter used for clone
-- detection.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,      -- base64url credential id
  public_key    TEXT NOT NULL,             -- SPKI PEM
  alg           INTEGER NOT NULL,          -- COSE alg (-7 ES256, -8 EdDSA)
  sign_count    BIGINT NOT NULL DEFAULT 0,
  aaguid        TEXT,
  transports    TEXT,
  name          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_webauthn_cred_user ON webauthn_credentials(user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL CHECK (purpose IN ('register', 'authenticate')),
  challenge  TEXT NOT NULL,                -- base64url; single-use
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenge_lookup ON webauthn_challenges(user_id, purpose, challenge);
