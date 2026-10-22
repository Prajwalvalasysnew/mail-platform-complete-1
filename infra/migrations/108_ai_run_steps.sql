-- Model-visible read observations and bounded agent-loop progress.
CREATE TABLE ai_run_steps (
 id UUID PRIMARY KEY, customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 run_id UUID NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE, attempt INTEGER NOT NULL,
 seq INTEGER NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
 arguments JSONB NOT NULL, observation JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(run_id,attempt,seq)
);
CREATE INDEX ai_run_steps_tenant ON ai_run_steps(customer_id,run_id,attempt,seq);
ALTER TABLE ai_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_run_steps FOR ALL USING(customer_id=current_tenant_id()) WITH CHECK(customer_id=current_tenant_id());
REVOKE ALL ON ai_run_steps FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mail_api') THEN GRANT SELECT,INSERT,UPDATE,DELETE ON ai_run_steps TO mail_api; END IF; END $$;
