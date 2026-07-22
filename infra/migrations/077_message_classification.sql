-- CANSPAM-01 (compliance implementation plan): authoritative message
-- classification.
--
-- CAN-SPAM obligations differ by message class (commercial vs transactional/
-- relationship), so the class must be an explicit, restricted, audited fact —
-- not something inferred later. Every message defaults to 'commercial' (the
-- safe class: full CAN-SPAM treatment). Declaring 'transactional' or
-- 'relationship' requires an API key holding the 'classify' scope, and the
-- accepted declaration is audit-logged.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_class TEXT NOT NULL DEFAULT 'commercial'
    CHECK (message_class IN ('transactional', 'relationship', 'commercial'));
