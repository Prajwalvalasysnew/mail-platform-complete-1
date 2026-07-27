-- Resolve ordering when secure/plaintext outcomes are recorded within the
-- same timestamp precision. Timestamps remain useful evidence, but an
-- explicit last outcome is the authoritative state transition.
ALTER TABLE recipient_domain_tls
  ADD COLUMN IF NOT EXISTS last_outcome_secured BOOLEAN;

UPDATE recipient_domain_tls
SET last_outcome_secured = CASE
  WHEN last_secured_at IS NULL THEN FALSE
  WHEN last_plaintext_at IS NULL THEN TRUE
  WHEN last_secured_at > last_plaintext_at THEN TRUE
  ELSE FALSE
END
WHERE last_outcome_secured IS NULL;
