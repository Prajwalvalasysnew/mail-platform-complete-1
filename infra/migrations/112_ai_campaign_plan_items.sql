-- Campaign plans from Valasys AI have several parts (audience, emails, workflow, launch) that the
-- user approves one at a time. Each part's decision and the record it created are kept here, keyed
-- by part ("audience", "email:<key>", "workflow", "launch").
ALTER TABLE ai_chat_messages ADD COLUMN plan_items jsonb NOT NULL DEFAULT '{}'::jsonb;
