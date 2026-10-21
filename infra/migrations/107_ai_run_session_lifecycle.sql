-- Login-session cleanup must not erase durable chat authority history or reset daily AI quotas.
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_session_id_fkey;
ALTER TABLE ai_runs ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_session_id_fkey FOREIGN KEY(session_id) REFERENCES user_sessions(id) ON DELETE SET NULL;
