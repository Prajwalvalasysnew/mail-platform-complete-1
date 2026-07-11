// Customer SSO enforcement (enterprise identity).
//
// When an organization sets sso_enforced, its members must authenticate through
// the identity provider (SSO/SCIM) instead of a password — the tenant-level
// equivalent of the admin plane's password_login_disabled posture. The login
// route consults isSsoEnforcedForUser() after verifying the password and rejects
// with password_login_disabled (403) if any of the user's orgs mandate SSO.

import { db } from './db.js';

/**
 * True if ANY organization the user actively belongs to enforces SSO. We fail
 * strict: an enterprise tenant that mandates SSO must not be bypassable because
 * the same user also belongs to a non-enforcing org. SSO login itself does not
 * go through the password path, so it is unaffected.
 */
export async function isSsoEnforcedForUser(userId: string): Promise<boolean> {
  const row = await db
    .selectFrom('memberships')
    .innerJoin('customers', 'customers.id', 'memberships.customer_id')
    .select('customers.id')
    .where('memberships.user_id', '=', userId)
    .where('memberships.scim_active', '=', true)
    .where('customers.sso_enforced', '=', true)
    .executeTakeFirst();
  return !!row;
}

/** Read one organization's SSO-enforcement flag. */
export async function getOrgSsoEnforcement(customerId: string): Promise<boolean> {
  const row = await db.selectFrom('customers').select('sso_enforced').where('id', '=', customerId).executeTakeFirst();
  return !!row?.sso_enforced;
}

/** Set one organization's SSO-enforcement flag. */
export async function setOrgSsoEnforcement(customerId: string, enforced: boolean): Promise<void> {
  await db.updateTable('customers').set({ sso_enforced: enforced, updated_at: new Date() as any }).where('id', '=', customerId).execute();
}
