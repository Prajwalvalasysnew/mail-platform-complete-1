-- TOTP replay prevention.
--
-- verifyTotp accepts any code within the ±1-step (90s) skew window, but the MFA
-- login flow did not record which step was consumed. A valid 6-digit code could
-- therefore be replayed multiple times within its validity window — e.g. a code
-- captured by a phishing proxy or shoulder-surf could be reused by an attacker.
--
-- RFC 6238 §5.2 calls for the verifier to reject a code from a time-step that is
-- <= the last successfully used step. We track that high-water mark per factor.
-- NULL means "no code consumed yet" (any step is acceptable on first use).

ALTER TABLE mfa_factors
    ADD COLUMN IF NOT EXISTS last_used_step BIGINT;
