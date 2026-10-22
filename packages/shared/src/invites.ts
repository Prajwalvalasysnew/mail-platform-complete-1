// Teammate invitations.
//
// An owner/admin invites an email to their org with a role. The invitee may not
// have a users row yet; accepting the invite creates/links the user and grants
// the stored membership. Tokens are hashed at rest and single-use.

import { db } from './db.js';
import { randomToken, hashUserToken } from './tokens.js';
import { createUser } from './users.js';
import {sql} from 'kysely';
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
  return db.transaction().execute(async trx=>{
  const invite = await trx
    .selectFrom('user_invites')
    .select(['id', 'customer_id', 'email', 'role', 'expires_at', 'accepted_at'])
    .where('token_hash', '=', hashUserToken(token))
    .forUpdate()
    .executeTakeFirst();
  if (!invite || invite.accepted_at) return { error: 'invalid_invite' };
  if (new Date(invite.expires_at) < new Date()) return { error: 'expired_invite' };

  // Serialize separate invitations for the same email as well as token reuse.
  await sql`select pg_advisory_xact_lock(hashtextextended(${invite.email},0))`.execute(trx);
  let user = await trx.selectFrom('users').select(['id','email','name','status','email_verified_at','mfa_enabled']).where('email','=',invite.email).executeTakeFirst();
  const existingUser = !!user;
  if (!user) {
    if (!opts.password || opts.password.length < 8) return { error: 'password_required' };
    user = await createUser({ email: invite.email, name: opts.name ?? null, password: opts.password },trx);
  }
  if(user.status!=='active')return {error:'invalid_invite'};
  // Joining is not a role-change operation; never demote an existing owner.
  const member=await trx.selectFrom('memberships').select('user_id').where('user_id','=',user.id).where('customer_id','=',invite.customer_id).executeTakeFirst();
  if(!member)await addMembership(user.id, invite.customer_id, invite.role as MembershipRole,trx);
  await trx.updateTable('user_invites').set({ accepted_at: new Date() }).where('id', '=', invite.id).execute();
  return {
    user_id: user.id,
    customer_id: invite.customer_id,
    existing_user: existingUser,
    mfa_enabled: user.mfa_enabled === true,
  };
  });
}
