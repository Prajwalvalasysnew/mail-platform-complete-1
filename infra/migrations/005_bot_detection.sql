-- 005_bot_detection.sql
-- Open/click bot & machine-event detection.
--
-- Records the bot-detection verdict on each engagement event, and separates
-- *human* open/click timestamps from machine pre-fetches on the message row so
-- engagement metrics can exclude scanners (Apple MPP, security gateways, image
-- proxies) without discarding the raw events.

-- Per-event verdict. NULL for non-engagement events (delivered/bounced/etc).
ALTER TABLE events ADD COLUMN IF NOT EXISTS bot_verdict TEXT
    CHECK (bot_verdict IS NULL OR bot_verdict IN ('human', 'bot', 'suspicious'));
ALTER TABLE events ADD COLUMN IF NOT EXISTS bot_score REAL;

-- Index for analytics that filter machine events out of engagement reporting.
CREATE INDEX IF NOT EXISTS idx_events_bot
    ON events (event_type, bot_verdict, occurred_at DESC);

-- Human-confirmed engagement timestamps on the message. The pre-existing
-- opened_at / first_clicked_at columns continue to record the *first* event of
-- any kind (preserving current behavior); these new columns record the first
-- event classified as human, which is what dashboards should report.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS human_opened_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS human_clicked_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS machine_opened_at TIMESTAMPTZ;
