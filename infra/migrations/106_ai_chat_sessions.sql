-- Durable customer conversations. Raw messages survive context compaction.
CREATE TABLE ai_chats (
 id UUID PRIMARY KEY, customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL,
 next_seq INTEGER NOT NULL DEFAULT 1, settings JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL, UNIQUE(customer_id,id)
);
ALTER TABLE ai_runs ADD COLUMN chat_id UUID REFERENCES ai_chats(id) ON DELETE CASCADE;
ALTER TABLE ai_runs ADD COLUMN chat_seq INTEGER;
CREATE TABLE ai_chat_messages (
 id UUID PRIMARY KEY, customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 chat_id UUID NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
 run_id UUID REFERENCES ai_runs(id) ON DELETE SET NULL, seq INTEGER NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'queued', result JSONB, error TEXT,
 template_id UUID REFERENCES templates(id) ON DELETE SET NULL, decision TEXT CHECK(decision IN ('applied','skipped')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(chat_id,seq), UNIQUE(run_id,role)
);
CREATE TABLE ai_chat_checkpoints (
 id UUID PRIMARY KEY, customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 chat_id UUID NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE, through_seq INTEGER NOT NULL,
 summary TEXT NOT NULL, run_id UUID REFERENCES ai_runs(id) ON DELETE SET NULL, attempt INTEGER NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(chat_id,through_seq)
);
CREATE INDEX ai_chats_owner ON ai_chats(customer_id,user_id,updated_at DESC);
CREATE INDEX ai_chat_messages_order ON ai_chat_messages(customer_id,chat_id,seq);
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['ai_chats','ai_chat_messages','ai_chat_checkpoints'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL USING(customer_id=current_tenant_id()) WITH CHECK(customer_id=current_tenant_id())',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mail_api') THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO mail_api',t);
  END IF;
 END LOOP;
END $$;
