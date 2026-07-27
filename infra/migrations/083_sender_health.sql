-- CANSPAM-08 (compliance implementation plan): per-sender complaint, bounce
-- and unsubscribe monitoring with automated holds and reviewer evidence.
--
-- The platform already watches IP-POOL health (reputation.ts:
-- evaluatePoolHealth / poolAction) and can throttle or pause a pool. That
-- protects the shared sending infrastructure — it says nothing about WHICH
-- tenant caused the damage, and it cannot hold one sender while letting the
-- rest of the pool keep sending.
--
-- CANSPAM-08 is about governing SENDERS: a customer, agency, affiliate or
-- reseller whose complaint or bounce rate indicates they are mailing people
-- who did not ask to hear from them. That needs per-tenant rates, thresholds,
-- an automated action, and a retained reviewer decision.
--
-- WHY THE ACTION IS 'hold' AND NOT 'suspend': suspending a tenant is a
-- commercial decision with contractual consequences. A hold stops NEW sends
-- pending human review and is reversible by a reviewer, which is the
-- proportionate automated response — and it produces the reviewer evidence the
-- control actually asks for. Escalation to suspension stays a human decision.

CREATE TABLE IF NOT EXISTS sender_health_runs (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    window_start   TIMESTAMPTZ NOT NULL,
    window_end     TIMESTAMPTZ NOT NULL,
    sent           BIGINT NOT NULL DEFAULT 0,
    bounced        BIGINT NOT NULL DEFAULT 0,
    complained     BIGINT NOT NULL DEFAULT 0,
    unsubscribed   BIGINT NOT NULL DEFAULT 0,
    bounce_rate      NUMERIC(6,5) NOT NULL DEFAULT 0,
    complaint_rate   NUMERIC(6,5) NOT NULL DEFAULT 0,
    unsubscribe_rate NUMERIC(6,5) NOT NULL DEFAULT 0,
    -- ok    : within thresholds
    -- watch : over the warning line — recorded and alerted, no enforcement
    -- hold  : over the enforcement line — new sends blocked pending review
    verdict        TEXT NOT NULL CHECK (verdict IN ('ok', 'watch', 'hold')),
    -- Which indicator drove the verdict, so a reviewer does not have to
    -- re-derive it from the rates.
    triggered_by   TEXT[] NOT NULL DEFAULT '{}',
    action_taken   TEXT NOT NULL DEFAULT 'none'
        CHECK (action_taken IN ('none', 'alerted', 'held')),
    -- Reviewer evidence. A hold that nobody ever looked at is an outage, not a
    -- control, so these are what close the loop.
    reviewed_at    TIMESTAMPTZ,
    reviewed_by    TEXT,
    review_decision TEXT CHECK (review_decision IN ('released', 'upheld', 'escalated')),
    review_notes   TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sender_health_customer
    ON sender_health_runs (customer_id, created_at DESC);

-- The send-path gate and the reviewer queue both read "open holds".
CREATE INDEX IF NOT EXISTS idx_sender_health_open_holds
    ON sender_health_runs (customer_id)
    WHERE verdict = 'hold' AND reviewed_at IS NULL;
