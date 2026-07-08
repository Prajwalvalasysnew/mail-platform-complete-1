// Memberships + role-based access control.
//
// A user's authority is scoped per customer (org) by their membership role.
// Roles aren't a clean ladder (billing and developer are siblings with
// different scopes), so authorization is capability-based rather than a single
// numeric rank. A coarse rank is kept only for "is at least admin" style checks
// and for protecting higher roles from lower ones.

import { type Kysely } from 'kysely';
import { db } from './db.js';
import type { Database, MembershipRole } from './schema.js';

type DbLike = Kysely<Database>;

export type Capability =
  | 'members:manage'   // invite/remove teammates, change roles
  | 'billing:manage'   // plans, invoices, payment methods
  | 'apikeys:manage'   // create/revoke API keys
  | 'domains:manage'   // add/verify sending domains
  | 'send'             // send mail / manage suppressions & templates
  | 'logs:read'        // activity, usage, stats
  | 'settings:manage'  // webhooks, account settings
  | 'org:delete';      // delete the account

const ALL: Capability[] = [
  'members:manage', 'billing:manage', 'apikeys:manage', 'domains:manage',
  'send', 'logs:read', 'settings:manage', 'org:delete',
];

const ROLE_CAPS: Record<MembershipRole, Capability[]> = {
  owner: ALL,
  admin: ['members:manage', 'apikeys:manage', 'domains:manage', 'send', 'logs:read', 'settings:manage'],
  developer: ['apikeys:manage', 'domains:manage', 'send', 'logs:read'],
  analyst: ['logs:read'],
  billing: ['billing:manage', 'logs:read'],
};

/** Coarse rank for hierarchy checks (only owner/admin sit above the siblings). */
export const MEMBERSHIP_ROLE_RANK: Record<MembershipRole, number> = {
  analyst: 1, developer: 2, billing: 2, admin: 3, owner: 4,
};

export function roleHasCapability(role: MembershipRole, cap: Capability): boolean {
  return ROLE_CAPS[role]?.includes(cap) ?? false;
}

export function membershipRoleAtLeast(have: MembershipRole, need: MembershipRole): boolean {
  return MEMBERSHIP_ROLE_RANK[have] >= MEMBERSHIP_ROLE_RANK[need];
}

export interface Membership {
  user_id: string;
  customer_id: string;
  role: MembershipRole;
}

export async function getMembership(userId: string, customerId: string): Promise<Membership | undefined> {
  return (await db
    .selectFrom('memberships')
    .select(['user_id', 'customer_id', 'role'])
    .where('user_id', '=', userId)
    .where('customer_id', '=', customerId)
    .executeTakeFirst()) as Membership | undefined;
}

export async function listMembershipsForUser(userId: string): Promise<Membership[]> {
  return (await db
    .selectFrom('memberships')
    .select(['user_id', 'customer_id', 'role'])
    .where('user_id', '=', userId)
    .execute()) as Membership[];
}

export async function listMembersOfCustomer(
  customerId: string
): Promise<Array<{ user_id: string; email: string; name: string | null; role: MembershipRole; mfa_enabled: boolean }>> {
  return (await db
    .selectFrom('memberships')
    .innerJoin('users', 'users.id', 'memberships.user_id')
    .select([
      'memberships.user_id as user_id',
      'users.email as email',
      'users.name as name',
      'memberships.role as role',
      'users.mfa_enabled as mfa_enabled',
    ])
    .where('memberships.customer_id', '=', customerId)
    .orderBy('users.email', 'asc')
    .execute()) as any;
}

export async function addMembership(
  userId: string,
  customerId: string,
  role: MembershipRole,
  executor: DbLike = db
): Promise<void> {
  await executor
    .insertInto('memberships')
    .values({ user_id: userId, customer_id: customerId, role })
    .onConflict((oc) => oc.columns(['user_id', 'customer_id']).doUpdateSet({ role }))
    .execute();
}

export async function countOwners(customerId: string): Promise<number> {
  const row = await db
    .selectFrom('memberships')
    .select(db.fn.countAll<number>().as('c'))
    .where('customer_id', '=', customerId)
    .where('role', '=', 'owner')
    .executeTakeFirstOrThrow();
  return Number((row as any).c);
}

/** Change a member's role. Refuses to demote the last owner. */
export async function updateMembershipRole(
  customerId: string,
  userId: string,
  role: MembershipRole
): Promise<{ ok: boolean; error?: string }> {
  const current = await getMembership(userId, customerId);
  if (!current) return { ok: false, error: 'not_a_member' };
  if (current.role === 'owner' && role !== 'owner' && (await countOwners(customerId)) <= 1) {
    return { ok: false, error: 'last_owner' };
  }
  await db.updateTable('memberships').set({ role }).where('customer_id', '=', customerId).where('user_id', '=', userId).execute();
  return { ok: true };
}

/** Remove a member. Refuses to remove the last owner. */
export async function removeMembership(customerId: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const current = await getMembership(userId, customerId);
  if (!current) return { ok: false, error: 'not_a_member' };
  if (current.role === 'owner' && (await countOwners(customerId)) <= 1) {
    return { ok: false, error: 'last_owner' };
  }
  await db.deleteFrom('memberships').where('customer_id', '=', customerId).where('user_id', '=', userId).execute();
  return { ok: true };
}
