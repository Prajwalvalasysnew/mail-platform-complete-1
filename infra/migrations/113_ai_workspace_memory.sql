-- What Valasys AI knows about a workspace (business, brand voice, audience, rules, and facts the
-- user asked it to remember such as the website or brand colour), shared by every AI surface so
-- users never have to repeat themselves. One row per workspace; editable on the AI agent page.
CREATE TABLE ai_workspace_memory (
 customer_id UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
 memory JSONB NOT NULL DEFAULT '{}'::jsonb,
 revision INTEGER NOT NULL DEFAULT 0,
 updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE ai_workspace_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_workspace_memory FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_workspace_memory FOR ALL USING(customer_id=current_tenant_id()) WITH CHECK(customer_id=current_tenant_id());
REVOKE ALL ON ai_workspace_memory FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mail_api') THEN GRANT SELECT,INSERT,UPDATE,DELETE ON ai_workspace_memory TO mail_api; END IF; END $$;
