// Teammate invitations.
//
// An owner/admin invites an email to their org with a role. The invitee may not
// have a users row yet; accepting the invite creates/links the user and grants
// the stored membership. Tokens are hashed at rest and single-use.

import { db } from './db.js';
import { randomToken, hashUserToken } from './tokens.js';
import { createUser, findUserByEmail } from './users.js';
import { addMembership } from './memberships.js';
import type { MembershipRole } from './schema.js';

export async function createInvite(
  customerId: string,
  email: string,
  role: MembershipRole,
  invitedByUserId: string | null,
  ttlHours = 72
): Promise<{ invite_id: string; token: string }> {
  const token = randomToken('', 24);
  const token_hash = hashUserToken(token);
  const expires_at = new Date(Date.now() + ttlHours * 3600_000);
  const row = await db
    .insertInto('user_invites')
    .values({
      customer_id: customerId,
      email: email.toLowerCase().trim(),
      role,
      token_hash,
      invited_by_user_id: invitedByUserId,
      expires_at,
    })
    .onConflict((oc) =>
      oc.columns(['customer_id', 'email']).doUpdateSet({ role, token_hash, expires_at, accepted_at: null })
    )
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return { invite_id: row.id, token };
}

export async function listInvites(customerId: string) {
  return db
    .selectFrom('user_invites')
    .select(['id', 'email', 'role', 'expires_at', 'accepted_at', 'created_at'])
    .where('customer_id', '=', customerId)
    .orderBy('created_at', 'desc')
    .execute();
}

export async function revokeInvite(customerId: string, inviteId: string): Promise<void> {
  await db.deleteFrom('user_invites').where('customer_id', '=', customerId).where('id', '=', inviteId).execute();
}

/**
 * Accept an invite. Creates the user if needed (password required for a new
 * user), grants the membership, and marks the invite accepted. Returns the
 * user_id + customer_id so the caller can start a session.
 */
export async function acceptInvite(
  token: string,
  opts: { name?: string; password?: string } = {}
): Promise<{ user_id: string; customer_id: string; existing_user: boolean; mfa_enabled: boolean } | { error: string }> {
  const invite = await db
    .selectFrom('user_invites')
    .select(['id', 'customer_id', 'email', 'role', 'expires_at', 'accepted_at'])
    .where('token_hash', '=', hashUserToken(token))
    .executeTakeFirst();
  if (!invite || invite.accepted_at) return { error: 'invalid_invite' };
  if (new Date(invite.expires_at) < new Date()) return { error: 'expired_invite' };

  let user = await findUserByEmail(invite.email);
  const existingUser = !!user;
  if (!user) {
    if (!opts.password || opts.password.length < 8) return { error: 'password_required' };
    user = await createUser({ email: invite.email, name: opts.name ?? null, password: opts.password });
  }

  await addMembership(user.id, invite.customer_id, invite.role as MembershipRole);
  await db.updateTable('user_invites').set({ accepted_at: new Date() }).where('id', '=', invite.id).execute();
  return {
    user_id: user.id,
    customer_id: invite.customer_id,
    existing_user: existingUser,
    mfa_enabled: user.mfa_enabled === true,
  };
}
