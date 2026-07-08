// DB integration tests for atomic org registration.
//
// registerOrgWithOwner must commit the user, the customer (org), and the owner
// membership together — or roll all three back. The headline guarantee is that
// a customer-email collision leaves NO orphan user behind, which the previous
// non-transactional flow could not promise.

import { describe, expect, it } from 'vitest';
import {
  db,
  registerOrgWithOwner,
  findUserByEmail,
  getMembership,
  listMembershipsForUser,
  IdentityError,
} from '@platform/shared';

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

describe('registerOrgWithOwner (atomic registration)', () => {
  it('creates the user, the org, and the owner membership together', async () => {
    const email = uniqueEmail('owner');
    const { user, customerId } = await registerOrgWithOwner({
      email,
      password: 'correct horse battery staple',
      name: 'Ada',
      orgName: 'Ada Co',
    });

    expect(user.email).toBe(email.toLowerCase());

    const customer = await db
      .selectFrom('customers')
      .select(['id', 'email', 'name'])
      .where('id', '=', customerId)
      .executeTakeFirst();
    expect(customer?.email).toBe(email.toLowerCase());
    expect(customer?.name).toBe('Ada Co');

    const membership = await getMembership(user.id, customerId);
    expect(membership?.role).toBe('owner');
  });

  it('normalizes the email to lowercase for both user and org', async () => {
    const raw = uniqueEmail('MixedCase').toUpperCase();
    const { user, customerId } = await registerOrgWithOwner({
      email: raw,
      password: 'a-good-long-password',
    });
    expect(user.email).toBe(raw.toLowerCase());
    const customer = await db.selectFrom('customers').select(['email']).where('id', '=', customerId).executeTakeFirst();
    expect(customer?.email).toBe(raw.toLowerCase());
  });

  it('rejects a duplicate user email with email_exists and creates no org', async () => {
    const email = uniqueEmail('dupuser');
    await registerOrgWithOwner({ email, password: 'first-registration-pw' });

    const customersBefore = await db
      .selectFrom('customers')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('email', '=', email.toLowerCase())
      .executeTakeFirstOrThrow();

    await expect(
      registerOrgWithOwner({ email, password: 'second-registration-pw' })
    ).rejects.toMatchObject({ code: 'email_exists' });

    // The failed second attempt must not have created another org row.
    const customersAfter = await db
      .selectFrom('customers')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('email', '=', email.toLowerCase())
      .executeTakeFirstOrThrow();
    expect(Number(customersAfter.c)).toBe(Number(customersBefore.c));
  });

  it('rolls back the user when the org email collides — no orphan user', async () => {
    // Pre-seed a customer with this email but NO matching user. This is the
    // exact orphan scenario: createUser would succeed, then the customers
    // insert fails, and the whole transaction must roll back.
    const email = uniqueEmail('orgcollision');
    await db.insertInto('customers').values({ email: email.toLowerCase(), name: 'Existing Org' }).execute();

    // Sanity: no user with this email exists yet.
    expect(await findUserByEmail(email)).toBeUndefined();

    await expect(
      registerOrgWithOwner({ email, password: 'should-roll-back' })
    ).rejects.toMatchObject({ code: 'org_exists' });

    // The critical assertion: the user insert was rolled back, so there is
    // still no user with this email. The pre-fix flow would leave one here.
    const orphan = await findUserByEmail(email);
    expect(orphan).toBeUndefined();
  });

  it('throws IdentityError (not a raw pg error) on collisions', async () => {
    const email = uniqueEmail('errtype');
    await registerOrgWithOwner({ email, password: 'pw-one-two-three' });
    const err = await registerOrgWithOwner({ email, password: 'pw-again' }).catch((e) => e);
    expect(err).toBeInstanceOf(IdentityError);
  });

  it('makes the owner membership immediately resolvable for the new user', async () => {
    const email = uniqueEmail('resolve');
    const { user, customerId } = await registerOrgWithOwner({ email, password: 'resolve-me-please' });
    const memberships = await listMembershipsForUser(user.id);
    expect(memberships.map((m) => m.customer_id)).toContain(customerId);
    expect(memberships.find((m) => m.customer_id === customerId)?.role).toBe('owner');
  });
});
