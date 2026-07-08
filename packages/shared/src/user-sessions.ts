// Human login sessions.
//
// Opaque bearer token "mpu_<random>"; only its HMAC is stored. A session carries
// an active-org context (current_customer_id) so a user with several
// memberships can switch org without re-authenticating, and an mfa_satisfied
// flag so a password-only session is "pending" until the second factor passes.

import { db } from './db.js';
import { randomToken, hashUserToken } from './tokens.js';
import { listMembershipsForUser, getMembership, type Membership } from './memberships.js';
import type { MembershipRole } from './schema.js';

const SESSION_PREFIX = 'mpu_';

export interface UserSessionContext {
  session_id: string;
  user_id: string;
  email: string;
  name: string | null;
  mfa_enabled: boolean;
  mfa_satisfied: boolean;
  current_customer_id: string | null;
  current_role: MembershipRole | null;
  memberships: Membership[];
}

export async function createUserSession(
  userId: string,
  opts: { ip?: string; userAgent?: string; ttlHours?: number; mfaSatisfied?: boolean; currentCustomerId?: string } = {}
): Promise<{ token: string; session_id: string; expires_at: Date }> {
  const token = randomToken(SESSION_PREFIX, 32);
  const ttlHours = opts.ttlHours ?? 24 * 14; // 14 days
  const expires_at = new Date(Date.now() + ttlHours * 3600_000);

  // Default the active org to the user's first membership, if any.
  let currentCustomerId = opts.currentCustomerId ?? null;
  if (!currentCustomerId) {
    const memberships = await listMembershipsForUser(userId);
    currentCustomerId = memberships[0]?.customer_id ?? null;
  }

  const row = await db
    .insertInto('user_sessions')
    .values({
      user_id: userId,
      token_hash: hashUserToken(token),
      current_customer_id: currentCustomerId,
      ip: opts.ip ?? null,
      user_agent: opts.userAgent ?? null,
      mfa_satisfied: opts.mfaSatisfied ?? false,
      expires_at,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  return { token, session_id: row.id, expires_at };
}

export async function resolveUserSession(token: string): Promise<UserSessionContext | null> {
  if (!token.startsWith(SESSION_PREFIX)) return null;
  const row = await db
    .selectFrom('user_sessions')
    .innerJoin('users', 'users.id', 'user_sessions.user_id')
    .select([
      'user_sessions.id as session_id',
      'user_sessions.user_id as user_id',
      'user_sessions.current_customer_id as current_customer_id',
      'user_sessions.mfa_satisfied as mfa_satisfied',
      'user_sessions.expires_at as expires_at',
      'user_sessions.revoked_at as revoked_at',
      'users.email as email',
      'users.name as name',
      'users.status as status',
      'users.mfa_enabled as mfa_enabled',
    ])
    .where('user_sessions.token_hash', '=', hashUserToken(token))
    .executeTakeFirst();

  if (!row || row.revoked_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  if (row.status !== 'active') return null;

  const memberships = await listMembershipsForUser(row.user_id);
  const current_role = row.current_customer_id
    ? memberships.find((m) => m.customer_id === row.current_customer_id)?.role ?? null
    : null;

  // Touch last_seen in the background; never block request handling.
  db.updateTable('user_sessions').set({ last_seen_at: new Date() }).where('id', '=', row.session_id).execute().catch(() => {});

  return {
    session_id: row.session_id,
    user_id: row.user_id,
    email: row.email,
    name: row.name,
    mfa_enabled: row.mfa_enabled,
    mfa_satisfied: row.mfa_satisfied,
    current_customer_id: row.current_customer_id,
    current_role,
    memberships,
  };
}

export async function markSessionMfaSatisfied(sessionId: string): Promise<void> {
  await db.updateTable('user_sessions').set({ mfa_satisfied: true }).where('id', '=', sessionId).execute();
}

/** Switch the active org. Verifies the user is actually a member first. */
export async function setSessionOrg(sessionId: string, userId: string, customerId: string): Promise<boolean> {
  const m = await getMembership(userId, customerId);
  if (!m) return false;
  await db.updateTable('user_sessions').set({ current_customer_id: customerId }).where('id', '=', sessionId).where('user_id', '=', userId).execute();
  return true;
}

export async function revokeUserSession(token: string): Promise<void> {
  await db.updateTable('user_sessions').set({ revoked_at: new Date() }).where('token_hash', '=', hashUserToken(token)).execute();
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  await db.updateTable('user_sessions').set({ revoked_at: new Date() }).where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
}

export interface UserSessionSummary {
  id: string;
  ip: string | null;
  user_agent: string | null;
  current_customer_id: string | null;
  mfa_satisfied: boolean;
  last_seen_at: Date;
  created_at: Date;
  expires_at: Date;
}

/**
 * List a user's active (non-revoked, non-expired) sessions, most recently
 * active first. Returns metadata only — never the token hash. Powers the
 * "active sessions / devices" view in the dashboard.
 */
export async function listUserSessions(userId: string): Promise<UserSessionSummary[]> {
  const rows = await db
    .selectFrom('user_sessions')
    .select(['id', 'ip', 'user_agent', 'current_customer_id', 'mfa_satisfied', 'last_seen_at', 'created_at', 'expires_at'])
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', new Date())
    .orderBy('last_seen_at', 'desc')
    .execute();
  return rows as unknown as UserSessionSummary[];
}

/**
 * Revoke one specific session, scoped to its owner so a user can only end their
 * own sessions. Returns false if no such active session belongs to the user
 * (already revoked counts as success — idempotent).
 */
export async function revokeUserSessionById(userId: string, sessionId: string): Promise<boolean> {
  const existing = await db
    .selectFrom('user_sessions')
    .select(['id', 'revoked_at'])
    .where('id', '=', sessionId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!existing) return false;
  if (existing.revoked_at) return true; // already revoked — idempotent
  await db.updateTable('user_sessions').set({ revoked_at: new Date() }).where('id', '=', sessionId).where('user_id', '=', userId).execute();
  return true;
}

/**
 * Revoke every session for a user except the one given ("log out everywhere
 * else"). Returns the number of sessions revoked.
 */
export async function revokeOtherUserSessions(userId: string, keepSessionId: string): Promise<number> {
  const res = await db
    .updateTable('user_sessions')
    .set({ revoked_at: new Date() })
    .where('user_id', '=', userId)
    .where('id', '!=', keepSessionId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}
