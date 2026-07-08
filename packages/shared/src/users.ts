// User accounts — the human identity service.
//
// Distinct from `customers` (the account/tenant) and from API keys (programmatic
// auth). A user is a person who logs in with email + password (+ optional MFA)
// and belongs to one or more customers via `memberships`.

import { sql, type Kysely } from 'kysely';
import { db } from './db.js';
import type { Database, MembershipRole } from './schema.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { randomToken, hashUserToken } from './tokens.js';
import { addMembership } from './memberships.js';

// A Kysely instance or an open transaction; both satisfy the query builder API,
// so identity writes can either run standalone or enlist in a caller's
// transaction. Mirrors the `executor` convention in outbox.ts.
type DbLike = Kysely<Database>;

export class IdentityError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'IdentityError';
  }
}

export interface UserRecord {
  id: string;
  email: string;
  name: string | null;
  status: 'active' | 'disabled';
  email_verified_at: Date | null;
  mfa_enabled: boolean;
}

const USER_COLS = ['id', 'email', 'name', 'status', 'email_verified_at', 'mfa_enabled'] as const;

// A valid-format hash over a zero key, used to keep authenticate() timing flat
// when the email doesn't exist (mitigates user enumeration via timing).
const DUMMY_HASH = `scrypt$32768$8$1$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(32).toString('base64url')}`;

/** Create a user. Throws IdentityError('email_exists') on duplicate email. */
export async function createUser(
  input: {
    email: string;
    name?: string | null;
    password?: string;
  },
  executor: DbLike = db
): Promise<UserRecord> {
  const password_hash = input.password ? await hashPassword(input.password) : null;
  try {
    return await executor
      .insertInto('users')
      .values({
        email: input.email.toLowerCase().trim(),
        name: input.name ?? null,
        password_hash,
      })
      .returning([...USER_COLS])
      .executeTakeFirstOrThrow() as unknown as UserRecord;
  } catch (err: any) {
    if (err?.code === '23505') throw new IdentityError('email_exists', 'A user with that email already exists');
    throw err;
  }
}

export interface RegisterOrgResult {
  user: UserRecord;
  customerId: string;
}

/**
 * Atomically register a new user, the org (customer) they own, and the owner
 * membership linking the two. All three writes commit together or not at all,
 * so a mid-sequence failure can never leave an orphaned user, an org with no
 * owner, or a user with no membership.
 *
 * Throws IdentityError('email_exists') if the user email is taken, or
 * IdentityError('org_exists') if the org email is taken. Both abort the
 * transaction, leaving no partial rows behind.
 */
export async function registerOrgWithOwner(input: {
  email: string;
  password: string;
  name?: string | null;
  orgName?: string | null;
}): Promise<RegisterOrgResult> {
  const email = input.email.toLowerCase().trim();
  try {
    return await db.transaction().execute(async (trx) => {
      const user = await createUser({ email, name: input.name ?? null, password: input.password }, trx);
      const customer = await trx
        .insertInto('customers')
        .values({ email, name: input.orgName ?? input.name ?? null })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      await addMembership(user.id, customer.id, 'owner' as MembershipRole, trx);
      return { user, customerId: customer.id };
    });
  } catch (err: any) {
    // createUser already maps the users-email collision to IdentityError;
    // a remaining 23505 here is the customers-email unique violation.
    if (err instanceof IdentityError) throw err;
    if (err?.code === '23505') throw new IdentityError('org_exists', 'An organization already uses this email.');
    throw err;
  }
}

export async function findUserByEmail(email: string): Promise<UserRecord | undefined> {
  return (await db
    .selectFrom('users')
    .select([...USER_COLS])
    .where(sql`lower(email)`, '=', email.toLowerCase().trim())
    .executeTakeFirst()) as unknown as UserRecord | undefined;
}

export async function getUserById(id: string): Promise<UserRecord | undefined> {
  return (await db
    .selectFrom('users')
    .select([...USER_COLS])
    .where('id', '=', id)
    .executeTakeFirst()) as unknown as UserRecord | undefined;
}

const USER_LOCKOUT_THRESHOLD = 5;
const USER_LOCKOUT_DURATION_MS = 15 * 60_000;

/**
 * Verify an email + password. Returns the user on success, null on unknown
 * email / wrong password / disabled account. Throws IdentityError('account_locked')
 * when the account is temporarily locked after repeated failures.
 * Transparently upgrades the stored hash when parameters are stale.
 */
export async function authenticate(email: string, password: string): Promise<UserRecord | null> {
  const row = await db
    .selectFrom('users')
    .select([...USER_COLS, 'password_hash', 'failed_login_attempts', 'locked_until'])
    .where(sql`lower(email)`, '=', email.toLowerCase().trim())
    .executeTakeFirst() as any;

  if (!row || !row.password_hash) {
    await verifyPassword(password, DUMMY_HASH);
    return null;
  }

  // Reject immediately if lockout window has not elapsed.
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    const retryAfter = Math.ceil((new Date(row.locked_until).getTime() - Date.now()) / 1000);
    const err = new IdentityError('account_locked', 'Account is temporarily locked due to repeated failed login attempts.');
    (err as any).retry_after = retryAfter;
    throw err;
  }

  const result = await verifyPassword(password, row.password_hash);
  if (!result.ok) {
    const newCount = (row.failed_login_attempts ?? 0) + 1;
    const lockedUntil = newCount >= USER_LOCKOUT_THRESHOLD ? new Date(Date.now() + USER_LOCKOUT_DURATION_MS) : null;
    db.updateTable('users')
      .set({ failed_login_attempts: newCount, ...(lockedUntil ? { locked_until: lockedUntil } : {}) })
      .where('id', '=', row.id)
      .execute()
      .catch(() => {});
    return null;
  }
  if (row.status !== 'active') return null;

  // Reset lockout state and optionally rehash on successful login.
  const updates: Record<string, any> = { failed_login_attempts: 0, locked_until: null };
  if (result.needsRehash) updates.password_hash = await hashPassword(password);
  db.updateTable('users').set({ ...updates, updated_at: new Date() }).where('id', '=', row.id).execute().catch(() => {});

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    email_verified_at: row.email_verified_at,
    mfa_enabled: row.mfa_enabled,
  };
}

export async function setPassword(userId: string, newPassword: string): Promise<void> {
  const password_hash = await hashPassword(newPassword);
  await db.updateTable('users').set({ password_hash, updated_at: new Date() }).where('id', '=', userId).execute();
}

export async function recordLogin(userId: string): Promise<void> {
  await db.updateTable('users').set({ last_login_at: new Date() }).where('id', '=', userId).execute();
}

// ---- email verification / password reset tokens ----

/** Issue a single-use token for a flow; returns the plaintext token (emailed). */
export async function issueUserToken(
  userId: string,
  purpose: 'email_verify' | 'password_reset',
  ttlMinutes = 60
): Promise<string> {
  const token = randomToken('', 32);
  await db
    .insertInto('user_tokens')
    .values({
      user_id: userId,
      purpose,
      token_hash: hashUserToken(token),
      expires_at: new Date(Date.now() + ttlMinutes * 60_000),
    })
    .execute();
  return token;
}

/**
 * Consume a token: validates purpose, expiry, and unused state, marks it used,
 * and returns the user_id (or null). For email_verify it also stamps
 * users.email_verified_at.
 */
export async function consumeUserToken(
  purpose: 'email_verify' | 'password_reset',
  token: string
): Promise<{ user_id: string } | null> {
  const row = await db
    .selectFrom('user_tokens')
    .select(['id', 'user_id', 'expires_at', 'used_at'])
    .where('token_hash', '=', hashUserToken(token))
    .where('purpose', '=', purpose)
    .executeTakeFirst();
  if (!row || row.used_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  await db.updateTable('user_tokens').set({ used_at: new Date() }).where('id', '=', row.id).execute();
  if (purpose === 'email_verify') {
    await db.updateTable('users').set({ email_verified_at: new Date() }).where('id', '=', row.user_id).execute();
  }
  return { user_id: row.user_id };
}
