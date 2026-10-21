-- AI runs are the per-user quota and one-at-a-time markers. Deleting a chat used to cascade to
-- its runs, so users could reset their daily limit by deleting conversations. Runs now outlive
-- their chat (content is erased on delete) and are purged by retention maintenance.
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_chat_id_fkey;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_chat_id_fkey FOREIGN KEY(chat_id) REFERENCES ai_chats(id) ON DELETE SET NULL;
