-- Admin TOTP replay prevention (mirrors 032 for customer MFA).
--
-- verifyAdminTotp used bare verifyTotp with no record of the consumed time-step,
-- so an admin's valid 6-digit code could be replayed within its ~90s window.
-- Admin accounts are the highest-value target, so this matters even more than the
-- customer case. Track the highest consumed step per admin and reject reuse
-- (RFC 6238 §5.2). NULL = no code consumed yet.

ALTER TABLE admin_users
    ADD COLUMN IF NOT EXISTS totp_last_used_step BIGINT;
