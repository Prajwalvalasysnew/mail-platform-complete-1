-- CCPA-05 (compliance implementation plan): right to limit the use and
-- disclosure of sensitive personal information (§1798.121).
--
-- WHY THIS APPLIES TO A MAIL PLATFORM AT ALL. §1798.140(ae)(1)(E) lists, as
-- sensitive personal information, "the contents of a consumer's mail, email,
-- and text messages unless the business is the intended recipient of the
-- communication". This platform is never the intended recipient — it carries
-- communications between a customer and their recipients. Message content is
-- therefore SPI by definition, not by configuration, and §1798.121 gives the
-- consumer a right to limit its use to what is necessary to perform the
-- service.
--
-- THE LINE THIS DRAWS, and why:
--
--   LIMITED (secondary use, not necessary to deliver the message)
--     * open tracking      building an engagement profile from whether and
--     * click tracking     when someone reads their mail is inference ABOUT
--                          the consumer, not delivery OF the message.
--
--   NOT LIMITED (expressly permitted purposes under §1798.121(a))
--     * delivery, bounce and complaint handling — performing the service
--     * content scanning for abuse and malware — preventing malicious or
--       fraudulent activity is a permitted purpose; disabling it on request
--       would let the limit be used as an evasion technique
--     * the CAN-SPAM footer and suppression checks — legal obligations, which
--       a consumer preference cannot switch off
--
-- Drawing the line anywhere else would either under-enforce (profiling
-- continues) or over-enforce (the platform stops doing things the law
-- requires of it).

CREATE TABLE IF NOT EXISTS sensitive_pi_limits (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email        TEXT NOT NULL,
    source       TEXT NOT NULL DEFAULT 'api'
        CHECK (source IN ('api', 'web_form', 'authorized_agent', 'support', 'privacy_case')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A consumer may lift their own limit; nothing else should.
    released_at  TIMESTAMPTZ,
    released_reason TEXT,
    -- BASE-03: erasure replaces the address with the keyed pseudonym.
    pseudonymized_at TIMESTAMPTZ
);

-- One active limit per recipient per tenant; the send path reads this on
-- every message, so keep it a single indexed lookup.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sensitive_pi_limits_active
    ON sensitive_pi_limits (customer_id, email)
    WHERE released_at IS NULL;

ALTER TABLE sensitive_pi_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensitive_pi_limits FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sensitive_pi_limits_tenant_isolation ON sensitive_pi_limits;
CREATE POLICY sensitive_pi_limits_tenant_isolation ON sensitive_pi_limits
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
