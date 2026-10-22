-- Tenant-owned, short-lived generation records. Model calls never run inside SQL transactions.
CREATE TABLE ai_runs (
 id UUID PRIMARY KEY,
 customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id UUID NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
 request_id UUID NOT NULL,
 request_hash TEXT NOT NULL,
 input JSONB,
 result JSONB,
 warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled','timed_out')),
 attempt INTEGER NOT NULL DEFAULT 0,
 lease_until TIMESTAMPTZ,
 deadline TIMESTAMPTZ NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 model TEXT NOT NULL,
 error TEXT,
 prompt_tokens INTEGER,
 output_tokens INTEGER,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(customer_id,user_id,request_id),
 UNIQUE(customer_id,id)
);
CREATE INDEX ai_runs_dispatch ON ai_runs(customer_id,status,created_at);
CREATE INDEX ai_runs_expiry ON ai_runs(expires_at);
ALTER TABLE ai_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_runs_tenant ON ai_runs FOR ALL
 USING(customer_id=current_tenant_id()) WITH CHECK(customer_id=current_tenant_id());
REVOKE ALL ON ai_runs FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mail_api') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON ai_runs TO mail_api;
 END IF;
END $$;
