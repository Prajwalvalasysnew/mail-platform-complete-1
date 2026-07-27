-- BASE-08 (compliance implementation plan): observed transport security per
-- recipient domain.
--
-- `customers.tls_required` (069) marked a tenant's INTENT to require encrypted
-- downstream delivery, and Haraka recorded per-delivery tls_secured evidence
-- plus a violation log line. That is purely detective: the message had already
-- gone out in the clear by the time anything noticed.
--
-- This table turns that evidence into a preventive control. Every delivery
-- records whether the hop was TLS-secured, per recipient domain. A domain
-- observed accepting mail without TLS is then refused for TLS-required
-- tenants, so the failure happens at most once per domain instead of on every
-- message.
--
-- LIMITATION, STATED PLAINLY: the FIRST delivery to an unseen domain cannot be
-- protected retroactively — the evidence only exists after the hop completes.
-- This control bounds exposure; it does not eliminate it. That residual risk is
-- why PHI and equivalent data remain prohibited (BASE-15) until message-level
-- encryption or secure-portal delivery exists. See docs/TRANSPORT_SECURITY.md.

CREATE TABLE IF NOT EXISTS recipient_domain_tls (
    domain                TEXT PRIMARY KEY,
    -- Running counts, so a single anomalous hop does not permanently condemn a
    -- domain and a domain that fixes its TLS can recover.
    deliveries_secured    BIGINT NOT NULL DEFAULT 0,
    deliveries_plaintext  BIGINT NOT NULL DEFAULT 0,
    last_secured_at       TIMESTAMPTZ,
    last_plaintext_at     TIMESTAMPTZ,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The gate reads by domain (primary key). This index serves the operator
-- report of currently-unsafe domains.
CREATE INDEX IF NOT EXISTS idx_recipient_domain_tls_plaintext
    ON recipient_domain_tls (last_plaintext_at DESC)
    WHERE deliveries_plaintext > 0;
