-- Just-in-time admin elevation + break-glass (enterprise least-privilege).
--
-- Admins hold a low STANDING role day-to-day. Elevated privileges are granted
-- just-in-time for a bounded window, with a reason, and are audited. Two paths:
--   * normal JIT grant — a higher admin grants another admin a time-boxed role
--     (four-eyes: you cannot grant yourself, and not above the grantor's role);
--   * break-glass — an on-call admin self-elevates in an emergency (flagged,
--     short-TTL, heavily audited) when four-eyes approval isn't possible.
-- The effective role of an admin session is max(standing, active elevation).
CREATE TABLE IF NOT EXISTS admin_elevations (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('support', 'operator', 'admin', 'superadmin')),
  reason        TEXT NOT NULL,
  granted_by    UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  break_glass   BOOLEAN NOT NULL DEFAULT false,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  revoked_by    UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Drives the per-request effective-role lookup and the expiry sweep.
CREATE INDEX IF NOT EXISTS idx_admin_elevations_active
  ON admin_elevations(admin_user_id, status, expires_at);
