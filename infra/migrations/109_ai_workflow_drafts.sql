-- AI chat proposals can now be workflow drafts; approval saves an inactive draft workflow.
ALTER TABLE ai_chat_messages ADD COLUMN workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL;
