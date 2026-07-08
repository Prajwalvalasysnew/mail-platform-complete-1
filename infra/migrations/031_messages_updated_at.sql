-- Add messages.sending_at + messages.updated_at.
--
-- BUG FIX (stale-send recovery): the scheduler's `stale_send_recovery` job
-- queried `WHERE updated_at < NOW() - INTERVAL '10 minutes'` against the
-- messages table, but no such column existed. Every run threw
--   ERROR: column "updated_at" of relation "messages" does not exist
-- so messages stranded in status='sending' after a worker crash were never
-- recovered — they sat in 'sending' forever.
--
-- DESIGN: recovery must measure "how long has this row been stuck in the
-- 'sending' state". A trigger-managed updated_at is the WRONG signal for that:
--   * the recovery UPDATE itself would bump it (the row never looks stale), and
--   * any unrelated later mutation would reset it.
-- So we add a dedicated `sending_at` that the send worker stamps at the moment
-- it transitions a row INTO 'sending', and recover based on that.
--
-- We also add `updated_at` (a generic "last modified" audit column with the
-- standard trigger) because it's broadly useful; it is intentionally NOT used
-- for stale recovery.

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS sending_at TIMESTAMPTZ;

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Backfill updated_at to the most meaningful existing timestamp so the first
-- post-deploy run doesn't treat historical rows as freshly touched.
UPDATE messages
SET updated_at = COALESCE(accepted_at, delivered_at, bounced_at, queued_at, NOW())
WHERE updated_at IS NULL;

-- Any row ALREADY stuck in 'sending' at deploy time has a NULL sending_at. Seed
-- it from queued_at so the recovery sweep can rescue pre-existing strandings on
-- its first run rather than ignoring them forever.
UPDATE messages
SET sending_at = COALESCE(queued_at, NOW())
WHERE status = 'sending' AND sending_at IS NULL;

-- set_updated_at() is defined in 001_init.sql. Reuse it for the audit column.
DROP TRIGGER IF EXISTS messages_updated_at ON messages;
CREATE TRIGGER messages_updated_at
    BEFORE UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Partial index matching the recovery query shape: only 'sending' rows are
-- candidates, so a partial index on sending_at stays tiny and the sweep cheap.
CREATE INDEX IF NOT EXISTS idx_messages_sending_at
    ON messages (sending_at)
    WHERE status = 'sending';
