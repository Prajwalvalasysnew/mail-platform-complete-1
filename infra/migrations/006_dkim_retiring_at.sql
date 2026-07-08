-- 006_dkim_retiring_at.sql
-- DKIM rotation grace-period fix.
--
-- retireOldKeys previously compared activated_at against the cutoff, but
-- activated_at marks when a key first became active — so any key active longer
-- than the TTL was retired immediately on demotion, collapsing the grace period
-- during which in-flight mail still needs the old key to verify. We track the
-- moment of demotion separately and retire based on that.

ALTER TABLE dkim_keys ADD COLUMN IF NOT EXISTS retiring_at TIMESTAMPTZ;

-- Backfill: any key already in 'retiring' state with no timestamp starts its
-- grace window now (conservative — keeps them around for the full TTL).
UPDATE dkim_keys SET retiring_at = NOW() WHERE state = 'retiring' AND retiring_at IS NULL;
