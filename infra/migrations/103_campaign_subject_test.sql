ALTER TABLE customer_campaigns
 ADD COLUMN campaign_type TEXT NOT NULL DEFAULT 'regular'
 CHECK(campaign_type IN ('regular','ab_subject')),
 ADD COLUMN subject_b TEXT NOT NULL DEFAULT '';
-- The launch snapshot freezes random assignments before the guarded send.
-- Existing regular campaign snapshots and recovery remain backward compatible.
