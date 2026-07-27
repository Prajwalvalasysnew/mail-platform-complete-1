-- CCPA-04 (compliance implementation plan): opt-out of sale/sharing, and the
-- Global Privacy Control signal.
--
-- This is a THIRD opt-out state, and it is not either of the two that already
-- exist:
--
--   suppression  "do not email me"        stops delivery
--   restriction  "do not process me"      Art 18 legal hold on processing
--   sale/share   "do not sell or share    stops the address being transferred
--                 my personal information" for cross-context advertising —
--                                          and says nothing about email
--
-- A recipient can legitimately want to keep receiving mail while refusing to
-- have their address sold, so folding this into suppression would both
-- over-enforce (silently unsubscribing them) and under-record (losing the
-- distinct legal basis). CCPA §1798.135(b)(1) also requires an opt-out
-- preference signal — Global Privacy Control — to be treated as a valid
-- request from the consumer, which is why `source` distinguishes a browser
-- signal from a submitted request.

CREATE TABLE IF NOT EXISTS sale_share_optouts (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email         TEXT NOT NULL,
    -- 'gpc' is a browser preference signal; the others are submitted requests.
    -- Recorded because an authorized-agent request has different verification
    -- duties than a GPC header.
    source        TEXT NOT NULL
        CHECK (source IN ('gpc', 'api', 'web_form', 'authorized_agent', 'support')),
    -- Which surface observed it (e.g. 'tracker_click', 'tracker_unsubscribe').
    -- Never a URL or user agent: this is evidence, not telemetry.
    context       TEXT,
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at   TIMESTAMPTZ,
    released_reason TEXT
);

-- One ACTIVE opt-out per recipient per tenant. GPC arrives on every request
-- from a consenting browser, so re-recording must be a no-op rather than an
-- unbounded row-per-pageview.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_share_optouts_active
    ON sale_share_optouts (customer_id, email)
    WHERE released_at IS NULL;

ALTER TABLE sale_share_optouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_share_optouts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sale_share_optouts_tenant_isolation ON sale_share_optouts;
CREATE POLICY sale_share_optouts_tenant_isolation ON sale_share_optouts
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
