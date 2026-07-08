-- Support desk: SLA tracking, CSAT, and canned responses (agent macros).
--
-- SLA: due timestamps are set from the ticket's priority at creation and
-- recomputed if priority changes; first_responded_at is stamped on the first
-- non-internal agent reply. Breaches are derived at query time.
-- CSAT: a customer can rate a resolved/closed ticket 1-5 with an optional note.

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS first_response_due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolution_due_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_responded_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS satisfaction_rating   SMALLINT
    CHECK (satisfaction_rating IS NULL OR satisfaction_rating BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS satisfaction_comment  TEXT,
  ADD COLUMN IF NOT EXISTS rated_at              TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS support_canned_responses (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title                    TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    body                     TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 10000),
    category                 TEXT NOT NULL DEFAULT 'general'
        CHECK (category IN ('general', 'billing', 'deliverability', 'technical', 'abuse', 'account')),
    created_by_admin_user_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
