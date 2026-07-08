// DB integration tests for SCIM 2.0 provisioning (gap analysis Top-20 #9).
// Exercises the service layer end-to-end against live Postgres: token
// mint/resolve/revoke, and the User provisioning/deprovisioning lifecycle
// (create -> get -> list/filter -> patch-deactivate -> delete), including the
// key enterprise requirement that deprovisioning removes org access while
// preserving the user row for audit.

import { describe, it, expect } from 'vitest';
import {
  createScimToken,
  resolveScimToken,
  listScimTokens,
  revokeScimToken,
  scimCreateUser,
  scimGetUser,
  scimListUsers,
  scimPatchUser,
  scimDeleteUser,
  seedCustomer,
  getMembership,
  db,
} from '@platform/shared';

const BASE = 'https://api.test';
const rndEmail = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@corp.example.com`;

describe('SCIM token management', () => {
  it('mints a token, resolves it to the tenant, and revokes it', async () => {
    const c = await seedCustomer();
    const { id, token, token_prefix } = await createScimToken(c.customerId, 'Okta');
    expect(token).toMatch(/^scim_/);
    expect(token_prefix.length).toBeGreaterThan(0);

    const resolved = await resolveScimToken(token);
    expect(resolved?.customerId).toBe(c.customerId);

    const list = await listScimTokens(c.customerId);
    expect(list.find((t) => t.id === id)).toBeTruthy();

    expect(await revokeScimToken(c.customerId, id)).toBe(true);
    // Revoked token no longer resolves.
    expect(await resolveScimToken(token)).toBeNull();
  });

  it('rejects an unknown or empty token', async () => {
    expect(await resolveScimToken(undefined)).toBeNull();
    expect(await resolveScimToken('scim_not_a_real_token')).toBeNull();
  });

  it('does not resolve a token across tenants', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    const { token } = await createScimToken(a.customerId);
    const resolved = await resolveScimToken(token);
    expect(resolved?.customerId).toBe(a.customerId);
    expect(resolved?.customerId).not.toBe(b.customerId);
  });
});

describe('SCIM user provisioning lifecycle', () => {
  it('creates a user, grants membership, and is idempotent on email', async () => {
    const c = await seedCustomer();
    const email = rndEmail('prov');
    const extId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const created = await scimCreateUser(c.customerId, {
      userName: email,
      externalId: extId,
      name: { givenName: 'Ada', familyName: 'Lovelace' },
      active: true,
    }, BASE);

    expect(created.userName).toBe(email);
    expect(created.active).toBe(true);
    expect(created.externalId).toBe(extId);
    expect(created.meta.resourceType).toBe('User');

    // Membership was granted (default lowest role).
    const m = await getMembership(created.id, c.customerId);
    expect(m?.role).toBe('analyst');

    // Idempotent re-provision returns the same user, not a duplicate/error.
    const again = await scimCreateUser(c.customerId, { userName: email, externalId: extId }, BASE);
    expect(again.id).toBe(created.id);
  });

  it('gets a user by id and rejects cross-tenant access', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    const u = await scimCreateUser(a.customerId, { userName: rndEmail('x') }, BASE);

    const got = await scimGetUser(a.customerId, u.id, BASE);
    expect(got.id).toBe(u.id);

    // Tenant B's token cannot read tenant A's user.
    await expect(scimGetUser(b.customerId, u.id, BASE)).rejects.toThrow(/not found/i);
  });

  it('lists users with a userName eq filter', async () => {
    const c = await seedCustomer();
    const email = rndEmail('filter');
    await scimCreateUser(c.customerId, { userName: email }, BASE);
    await scimCreateUser(c.customerId, { userName: rndEmail('other') }, BASE);

    const filtered = await scimListUsers(c.customerId, { filter: `userName eq "${email}"` }, BASE);
    expect(filtered.totalResults).toBe(1);
    expect(filtered.Resources[0].userName).toBe(email);
    expect(filtered.schemas[0]).toContain('ListResponse');
  });

  it('PATCH active=false deprovisions (disables the user, revoking all access)', async () => {
    const c = await seedCustomer();
    const email = rndEmail('deprov');
    const u = await scimCreateUser(c.customerId, { userName: email }, BASE);
    expect(await getMembership(u.id, c.customerId)).toBeTruthy();

    const patched = await scimPatchUser(c.customerId, u.id, {
      Operations: [{ op: 'replace', path: 'active', value: false }],
    }, BASE);
    expect(patched.active).toBe(false);

    // The user is DISABLED — a disabled account is rejected at session
    // resolution and password auth, so access is fully revoked. The membership
    // row is preserved so the tenant can re-activate the user later, and the
    // user row is preserved for audit.
    const row = await db.selectFrom('users').select(['status']).where('id', '=', u.id).executeTakeFirst();
    expect(row?.status).toBe('disabled');
  });

  it('PATCH also accepts the { value: { active: false } } shape', async () => {
    const c = await seedCustomer();
    const u = await scimCreateUser(c.customerId, { userName: rndEmail('shape') }, BASE);
    const patched = await scimPatchUser(c.customerId, u.id, {
      Operations: [{ op: 'replace', value: { active: false } }],
    }, BASE);
    expect(patched.active).toBe(false);
  });

  it('DELETE deprovisions (soft) while preserving the user row', async () => {
    const c = await seedCustomer();
    const u = await scimCreateUser(c.customerId, { userName: rndEmail('del') }, BASE);
    await scimDeleteUser(c.customerId, u.id);

    // User row still exists (audit preservation) but is disabled (access revoked).
    const row = await db.selectFrom('users').select(['id', 'status']).where('id', '=', u.id).executeTakeFirst();
    expect(row).toBeTruthy();
    expect(row?.status).toBe('disabled');
  });

  it('re-activating via PATCH restores access (user re-enabled)', async () => {
    const c = await seedCustomer();
    const u = await scimCreateUser(c.customerId, { userName: rndEmail('react') }, BASE);
    await scimPatchUser(c.customerId, u.id, { Operations: [{ op: 'replace', path: 'active', value: false }] }, BASE);
    let row = await db.selectFrom('users').select(['status']).where('id', '=', u.id).executeTakeFirst();
    expect(row?.status).toBe('disabled');

    const reactivated = await scimPatchUser(c.customerId, u.id, { Operations: [{ op: 'replace', path: 'active', value: true }] }, BASE);
    expect(reactivated.active).toBe(true);
    row = await db.selectFrom('users').select(['status']).where('id', '=', u.id).executeTakeFirst();
    expect(row?.status).toBe('active');
    expect(await getMembership(u.id, c.customerId)).toBeTruthy();
  });
});
