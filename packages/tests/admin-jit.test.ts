// Just-in-time admin elevation + break-glass. Proves the least-privilege model:
// four-eyes on normal grants, self-service (flagged) break-glass with a standing
// floor, TTL/expiry, revocation, and that the effective admin-session role
// reflects an active elevation and reverts when it lapses.

import { describe, it, expect } from 'vitest';
import {
  db, createAdminUser, createAdminSessionWithPassword, resolveAdminSession,
  grantElevation, activeElevatedRole, revokeElevation, expireElevations, listActiveElevations,
} from '@platform/shared';

let n = 0;
async function seedAdmin(role: 'support' | 'operator' | 'admin' | 'superadmin') {
  const email = `jit-${role}-${Date.now()}-${n++}@example.com`;
  const created = await createAdminUser({ email, role, password: 'a-strong-admin-password' });
  if ('error' in created) throw new Error(created.error);
  return { id: created.id, email, password: 'a-strong-admin-password' };
}

describe('JIT admin elevation', () => {
  it('enforces four-eyes on a normal grant (no self-grant)', async () => {
    const admin = await seedAdmin('admin');
    const r = await grantElevation({ adminUserId: admin.id, role: 'superadmin', reason: 'self attempt', ttlMinutes: 30, grantedBy: admin.id });
    expect(r).toMatchObject({ ok: false, error: 'self_grant_forbidden', status: 403 });
  });

  it('refuses to grant above the grantor standing role', async () => {
    const grantor = await seedAdmin('operator');
    const grantee = await seedAdmin('support');
    const r = await grantElevation({ adminUserId: grantee.id, role: 'superadmin', reason: 'too high', ttlMinutes: 30, grantedBy: grantor.id });
    expect(r).toMatchObject({ ok: false, error: 'exceeds_grantor_role', status: 403 });
  });

  it('grants a time-boxed elevation that raises the effective session role', async () => {
    const grantor = await seedAdmin('superadmin');
    const grantee = await seedAdmin('support');
    // Standing role is support.
    const session = await createAdminSessionWithPassword(grantee.email, grantee.password);
    expect((await resolveAdminSession(session!.token))).toMatchObject({ role: 'support', standing_role: 'support', elevated: false });

    const r = await grantElevation({ adminUserId: grantee.id, role: 'operator', reason: 'incident triage', ttlMinutes: 30, grantedBy: grantor.id });
    expect(r.ok).toBe(true);
    expect(await activeElevatedRole(grantee.id)).toBe('operator');

    // Effective session role is now operator, standing role unchanged.
    expect(await resolveAdminSession(session!.token)).toMatchObject({ role: 'operator', standing_role: 'support', elevated: true });

    // It appears in the active list and can be revoked.
    expect((await listActiveElevations()).some((e) => e.admin_user_id === grantee.id)).toBe(true);
    expect(await revokeElevation((r as any).elevation.id, grantor.id)).toBe(true);
    expect(await resolveAdminSession(session!.token)).toMatchObject({ role: 'support', elevated: false });
  });

  it('allows break-glass self-elevation above the standing role, but not below the floor', async () => {
    // support is below the break-glass standing floor (operator).
    const support = await seedAdmin('support');
    expect(await grantElevation({ adminUserId: support.id, role: 'superadmin', reason: 'panic', ttlMinutes: 15, grantedBy: support.id, breakGlass: true }))
      .toMatchObject({ ok: false, error: 'break_glass_standing_too_low', status: 403 });

    // operator can break the glass up to superadmin.
    const op = await seedAdmin('operator');
    const r = await grantElevation({ adminUserId: op.id, role: 'superadmin', reason: 'prod incident, four-eyes unavailable', ttlMinutes: 15, grantedBy: op.id, breakGlass: true });
    expect(r.ok).toBe(true);
    expect((r as any).elevation.break_glass).toBe(true);
    expect(await activeElevatedRole(op.id)).toBe('superadmin');
  });

  it('rejects a TTL beyond the cap and a missing reason', async () => {
    const grantor = await seedAdmin('superadmin');
    const grantee = await seedAdmin('support');
    expect(await grantElevation({ adminUserId: grantee.id, role: 'operator', reason: 'ok reason', ttlMinutes: 100000, grantedBy: grantor.id }))
      .toMatchObject({ ok: false, error: 'ttl_out_of_range' });
    expect(await grantElevation({ adminUserId: grantee.id, role: 'operator', reason: '', ttlMinutes: 30, grantedBy: grantor.id }))
      .toMatchObject({ ok: false, error: 'reason_required' });
  });

  it('stops counting an elevation once it has expired', async () => {
    const grantor = await seedAdmin('superadmin');
    const grantee = await seedAdmin('support');
    const r = await grantElevation({ adminUserId: grantee.id, role: 'admin', reason: 'short window', ttlMinutes: 5, grantedBy: grantor.id });
    expect(r.ok).toBe(true);
    // Force expiry in the past.
    await db.updateTable('admin_elevations').set({ expires_at: new Date(Date.now() - 1000) as any }).where('id', '=', (r as any).elevation.id).execute();
    expect(await activeElevatedRole(grantee.id)).toBeNull();
    expect(await expireElevations()).toBeGreaterThanOrEqual(1);
    expect(await db.selectFrom('admin_elevations').select('status').where('id', '=', (r as any).elevation.id).executeTakeFirstOrThrow()).toMatchObject({ status: 'expired' });
  });
});
