-- TLS-required delivery posture (healthcare/finance compliance).
--
-- When enabled, every outbound message is stamped with an internal
-- require-TLS marker; the delivery layer records whether each individual
-- delivery was actually made over a TLS-secured connection (tls_secured in
-- the delivered event payload), giving per-message transport-encryption
-- evidence for HIPAA/PCI reviews. Blocking (refuse-to-send-plaintext)
-- enforcement lands with the dedicated SMTP relay.

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS tls_required BOOLEAN NOT NULL DEFAULT FALSE;
