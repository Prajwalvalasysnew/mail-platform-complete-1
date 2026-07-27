-- Secure portal payloads for HIPAA/FERPA modes. Sensitive content is encrypted
-- before persistence; portal and access credentials are stored only as HMACs.

CREATE TABLE IF NOT EXISTS secure_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    recipient_email TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    portal_token_hash TEXT NOT NULL UNIQUE,
    access_code_hash TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('hipaa', 'ferpa')),
    expires_at TIMESTAMPTZ NOT NULL,
    accessed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_by_api_key UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_secure_messages_customer_created
    ON secure_messages(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_secure_messages_expiry
    ON secure_messages(expires_at) WHERE revoked_at IS NULL;

ALTER TABLE secure_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE secure_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS secure_messages_tenant_isolation ON secure_messages;
CREATE POLICY secure_messages_tenant_isolation ON secure_messages
    USING (customer_id = current_setting('app.customer_id', true)::uuid)
    WITH CHECK (customer_id = current_setting('app.customer_id', true)::uuid);
