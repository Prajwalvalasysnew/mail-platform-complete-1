// Internal admin authorization plane — fully separate from customer API keys.
//
// Customer keys must never be able to suspend accounts, action the review
// queue, or issue refunds. Admin users authenticate via SSO/OIDC (subject claim
// mapped to an admin_users row) and carry a role. Sessions are opaque tokens
// hashed at rest. Every privileged action is audit-logged.
//
// Roles (ascending): support < operator < admin < superadmin.

import crypto from 'node:crypto';
import { db } from './db.js';
import { decryptSecret, encryptSecret } from './encryption.js';
import { generateTotpSecret, otpauthUri, verifyTotp, verifyTotpStep } from './totp.js';
import { activeElevation } from './admin-jit.js';

export type AdminRole = 'support' | 'operator' | 'admin' | 'superadmin';
const ROLE_RANK: Record<AdminRole, number> = { support: 1, operator: 2, admin: 3, superadmin: 4 };

export function roleAtLeast(have: AdminRole, need: AdminRole): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[need];
}

function hashToken(token: string): string {
  // Admin session tokens are high-entropy; HMAC with the pepper, constant-time compared.
  const pepper = process.env.ADMIN_SESSION_PEPPER ?? process.env.JWT_SECRET ?? 'dev-admin-pepper';
  return crypto.createHmac('sha256', pepper).update(token).digest('base64url');
}

function generateCsrfToken(): string {
  return `mpcsrf_${crypto.randomBytes(32).toString('base64url')}`;
}

export interface AdminSessionIssued {
  token: string;
  /** Per-session CSRF secret for cookie-based clients. Returned once at issue/rotate. */
  csrf_token: string;
  role: AdminRole;
  admin_user_id: string;
  expires_at: Date;
}

async function createAdminSessionForUser(
  adminUserId: string,
  role: AdminRole,
  ttlHours = 8
): Promise<AdminSessionIssued> {
  const token = `mpadm_${crypto.randomBytes(32).toString('base64url')}`;
  const csrfToken = generateCsrfToken();
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  await db
    .insertInto('admin_sessions')
    .values({ admin_user_id: adminUserId, token_hash: hashToken(token), csrf_hash: hashToken(csrfToken), expires_at: expiresAt })
    .execute();
  await db.updateTable('admin_users').set({ last_login_at: new Date() }).where('id', '=', adminUserId).execute();
  return { token, csrf_token: csrfToken, role, admin_user_id: adminUserId, expires_at: expiresAt };
}

/**
 * Rotate the CSRF secret for a live session and return the new value. Used by
 * the bootstrap endpoint so a page reload (cookie present, CSRF secret lost
 * with the old JS heap) can re-arm mutation protection without re-login.
 */
export async function rotateAdminSessionCsrf(token: string): Promise<string | null> {
  if (!token.startsWith('mpadm_')) return null;
  const csrfToken = generateCsrfToken();
  const res = await db
    .updateTable('admin_sessions')
    .set({ csrf_hash: hashToken(csrfToken) })
    .where('token_hash', '=', hashToken(token))
    .where('expires_at', '>', new Date())
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0) > 0 ? csrfToken : null;
}

/** Constant-time check of a presented CSRF token against the session's stored hash. */
export async function verifyAdminSessionCsrf(token: string, csrfToken: string): Promise<boolean> {
  if (!token.startsWith('mpadm_') || !csrfToken.startsWith('mpcsrf_')) return false;
  const row = await db
    .selectFrom('admin_sessions')
    .select(['csrf_hash'])
    .where('token_hash', '=', hashToken(token))
    .executeTakeFirst();
  if (!row?.csrf_hash) return false;
  const presented = Buffer.from(hashToken(csrfToken));
  const stored = Buffer.from(row.csrf_hash);
  return presented.length === stored.length && crypto.timingSafeEqual(presented, stored);
}

/**
 * Establish an admin session from a verified OIDC subject. In production the
 * OIDC verification (issuer, audience, signature, expiry) happens upstream; we
 * trust the verified subject + email here and map to an admin_users row.
 */
export async function createAdminSession(
  oidcSubject: string,
  email: string,
  ttlHours = 8
): Promise<AdminSessionIssued | null> {
  let user = await db
    .selectFrom('admin_users')
    .select(['id', 'role', 'disabled'])
    .where('oidc_subject', '=', oidcSubject)
    .executeTakeFirst();

  // First login: map by pre-provisioned email, else deny (no self-service admin).
  if (!user) {
    const byEmail = await db
      .selectFrom('admin_users')
      .select(['id', 'role', 'disabled'])
      .where('email', '=', email.toLowerCase())
      .executeTakeFirst();
    if (!byEmail) return null;
    await db.updateTable('admin_users').set({ oidc_subject: oidcSubject }).where('id', '=', byEmail.id).execute();
    user = byEmail;
  }
  if (user.disabled) return null;

  return createAdminSessionForUser(user.id, user.role as AdminRole, ttlHours);
}

export interface AdminContext {
  admin_user_id: string;
  /** Effective role = max(standing role, active JIT elevation). Guards use this. */
  role: AdminRole;
  /** The admin's day-to-day (unelevated) role, for display/audit. */
  standing_role: AdminRole;
  /** True when the effective role is currently raised by a JIT elevation. */
  elevated: boolean;
  /**
   * True when that elevation is a break-glass self-grant rather than one
   * approved by someone else. Carried separately because after the fact the
   * two need very different scrutiny — see access-audit.ts.
   */
  break_glass: boolean;
  email: string;
}

/** Resolve an admin session token to an AdminContext, or null if invalid/expired. */
export async function resolveAdminSession(token: string): Promise<AdminContext | null> {
  if (!token.startsWith('mpadm_')) return null;
  const row = await db
    .selectFrom('admin_sessions')
    .innerJoin('admin_users', 'admin_users.id', 'admin_sessions.admin_user_id')
    .select(['admin_sessions.admin_user_id as admin_user_id', 'admin_sessions.expires_at as expires_at', 'admin_users.role as role', 'admin_users.email as email', 'admin_users.disabled as disabled'])
    .where('admin_sessions.token_hash', '=', hashToken(token))
    // Audience binding: only sessions minted for the admin plane resolve here.
    .where('admin_sessions.audience', '=', 'admin')
    .executeTakeFirst();
  if (!row || row.disabled) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  const standing = row.role as AdminRole;
  // Effective role is the higher of the standing role and any active,
  // unexpired JIT elevation. Existing route guards read `role`, so elevation
  // takes effect everywhere without touching each guard.
  const elevation = await activeElevation(row.admin_user_id);
  const raised = elevation && ROLE_RANK[elevation.role] > ROLE_RANK[standing];
  const role = raised ? elevation!.role : standing;
  return {
    admin_user_id: row.admin_user_id,
    role,
    standing_role: standing,
    elevated: role !== standing,
    // Only meaningful when the elevation is what raised the role.
    break_glass: Boolean(raised && elevation!.break_glass),
    email: row.email,
  };
}

/** Write a privileged admin action to the audit log. */
export async function auditAdminAction(
  admin: AdminContext,
  action: string,
  resource: string,
  metadata: Record<string, unknown> = {},
  customerId?: string
): Promise<void> {
  await db
    .insertInto('audit_log')
    .values({
      customer_id: customerId ?? null,
      api_key_id: null,
      action: `admin:${action}`,
      resource,
      ip: null,
      metadata: { ...metadata, admin_user_id: admin.admin_user_id, admin_email: admin.email, admin_role: admin.role },
    })
    .execute();
}

// ---------------------------------------------------------------------------
// Password-based admin auth + admin-user management.
//
// Admins authenticate with email + password (bcrypt at rest), receiving the
// same opaque, hashed session token as the OIDC path. Admin users are
// provisioned only by a superadmin (no self-service signup), mirroring how
// SendGrid/Mailgun gate their internal back-office.
// ---------------------------------------------------------------------------

import bcrypt from 'bcryptjs';

export async function hashAdminPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export interface AdminPasswordAuth {
  admin_user_id: string;
  role: AdminRole;
  totp_enabled: boolean;
}

export async function verifyAdminPasswordCredentials(email: string, password: string): Promise<AdminPasswordAuth | null> {
  const user = await db
    .selectFrom('admin_users')
    .select(['id', 'role', 'disabled', 'password_hash', 'totp_enabled'])
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst();
  if (!user || user.disabled || !user.password_hash) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  return { admin_user_id: user.id, role: user.role as AdminRole, totp_enabled: user.totp_enabled === true };
}

export async function createAdminSessionForPasswordAuth(
  auth: AdminPasswordAuth,
  ttlHours = 8
): Promise<AdminSessionIssued> {
  return createAdminSessionForUser(auth.admin_user_id, auth.role, ttlHours);
}

/**
 * Authenticate an admin by email + password. Returns a fresh session token, or
 * null on any failure (unknown email, disabled, no password set, bad password)
 * — the caller must not leak which.
 */
export async function createAdminSessionWithPassword(
  email: string,
  password: string,
  ttlHours = 8
): Promise<AdminSessionIssued | null> {
  const auth = await verifyAdminPasswordCredentials(email, password);
  if (!auth || auth.totp_enabled) return null;
  return createAdminSessionForPasswordAuth(auth, ttlHours);
}

export async function adminRequiresTotp(adminUserId: string): Promise<boolean> {
  const row = await db
    .selectFrom('admin_users')
    .select(['totp_enabled'])
    .where('id', '=', adminUserId)
    .where('disabled', '=', false)
    .executeTakeFirst();
  return row?.totp_enabled === true;
}

async function getAdminTotpSecret(adminUserId: string): Promise<string | null> {
  const row = await db
    .selectFrom('admin_users')
    .select(['totp_secret'])
    .where('id', '=', adminUserId)
    .where('disabled', '=', false)
    .executeTakeFirst();
  if (!row?.totp_secret) return null;
  return decryptSecret(row.totp_secret);
}

export async function beginAdminTotpEnrollment(adminUserId: string): Promise<{ secret: string; otpauth_url: string } | null> {
  const admin = await db
    .selectFrom('admin_users')
    .select(['id', 'email', 'disabled'])
    .where('id', '=', adminUserId)
    .executeTakeFirst();
  if (!admin || admin.disabled) return null;

  const secret = generateTotpSecret();
  await db
    .updateTable('admin_users')
    .set({ totp_secret: encryptSecret(secret), totp_enabled: false })
    .where('id', '=', adminUserId)
    .execute();

  return {
    secret,
    otpauth_url: otpauthUri(secret, admin.email, process.env.ADMIN_TOTP_ISSUER ?? 'Mail Platform Admin'),
  };
}

export async function confirmAdminTotpEnrollment(adminUserId: string, code: string): Promise<boolean> {
  const secret = await getAdminTotpSecret(adminUserId);
  if (!secret) return false;
  if (!verifyTotp(secret, code)) return false;
  const res = await db
    .updateTable('admin_users')
    .set({ totp_enabled: true })
    .where('id', '=', adminUserId)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0) > 0;
}

export async function verifyAdminTotp(adminUserId: string, code: string): Promise<boolean> {
  const row = await db
    .selectFrom('admin_users')
    .select(['totp_secret', 'totp_enabled', 'disabled', 'totp_last_used_step'])
    .where('id', '=', adminUserId)
    .executeTakeFirst();
  if (!row || row.disabled || !row.totp_enabled || !row.totp_secret) return false;
  const step = verifyTotpStep(decryptSecret(row.totp_secret), code);
  if (step === null) return false;
  // Replay prevention (RFC 6238 §5.2): atomically record the step and reject any
  // code from a step we've already accepted. The conditional UPDATE also guards
  // against two concurrent logins replaying the same code.
  const res = await db
    .updateTable('admin_users')
    .set({ totp_last_used_step: step })
    .where('id', '=', adminUserId)
    .where((eb) => eb.or([
      eb('totp_last_used_step', 'is', null),
      eb('totp_last_used_step', '<', step),
    ]))
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0) > 0;
}

export async function disableAdminTotp(adminUserId: string): Promise<boolean> {
  const res = await db
    .updateTable('admin_users')
    .set({ totp_secret: null, totp_enabled: false })
    .where('id', '=', adminUserId)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0) > 0;
}

/** Revoke a single admin session (logout). Idempotent. */
export async function revokeAdminSession(token: string): Promise<void> {
  await db.deleteFrom('admin_sessions').where('token_hash', '=', hashToken(token)).execute();
}

/** Revoke every active session for an admin user (e.g. on disable/role change). */
export async function revokeAllAdminSessions(adminUserId: string): Promise<void> {
  await db.deleteFrom('admin_sessions').where('admin_user_id', '=', adminUserId).execute();
}

export async function listAdminUsers() {
  return db
    .selectFrom('admin_users')
    .select(['id', 'email', 'name', 'role', 'disabled', 'created_at', 'last_login_at'])
    .orderBy('created_at', 'asc')
    .execute();
}

export async function createAdminUser(input: {
  email: string;
  name?: string | null;
  role: AdminRole;
  password: string;
}): Promise<{ id: string } | { error: 'email_exists' }> {
  const email = input.email.toLowerCase();
  const existing = await db.selectFrom('admin_users').select('id').where('email', '=', email).executeTakeFirst();
  if (existing) return { error: 'email_exists' };
  const row = await db
    .insertInto('admin_users')
    .values({ email, name: input.name ?? null, role: input.role, password_hash: await hashAdminPassword(input.password) })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id };
}

export async function updateAdminUser(
  id: string,
  patch: { role?: AdminRole; disabled?: boolean; name?: string | null }
): Promise<boolean> {
  const set: Record<string, unknown> = {};
  if (patch.role !== undefined) set.role = patch.role;
  if (patch.disabled !== undefined) set.disabled = patch.disabled;
  if (patch.name !== undefined) set.name = patch.name;
  if (Object.keys(set).length === 0) return false;
  const res = await db.updateTable('admin_users').set(set).where('id', '=', id).executeTakeFirst();
  // Disabling an admin should also kill their live sessions.
  if (patch.disabled === true) await revokeAllAdminSessions(id);
  return Number(res.numUpdatedRows ?? 0) > 0;
}

export async function setAdminPassword(id: string, password: string): Promise<boolean> {
  const res = await db
    .updateTable('admin_users')
    .set({ password_hash: await hashAdminPassword(password) })
    .where('id', '=', id)
    .executeTakeFirst();
  // Force re-login everywhere after a password reset.
  await revokeAllAdminSessions(id);
  return Number(res.numUpdatedRows ?? 0) > 0;
}
