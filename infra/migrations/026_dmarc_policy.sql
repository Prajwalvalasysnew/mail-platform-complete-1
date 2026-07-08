-- Store the DMARC policy level discovered during domain verification.
-- Levels: null (not yet checked), 'none', 'quarantine', 'reject'.
-- The API warns customers when p=none (monitoring only) and can optionally
-- block production sends until they move to quarantine or reject.

ALTER TABLE sending_domains
  ADD COLUMN IF NOT EXISTS dmarc_policy text
    CHECK (dmarc_policy IS NULL OR dmarc_policy IN ('none', 'quarantine', 'reject'));
