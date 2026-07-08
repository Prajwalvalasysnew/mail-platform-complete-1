// DB integration tests for active-session management:
// listing, per-session revocation (owner-scoped), and "log out everywhere else".

import { describe, expect, it } from 'vitest';
import {
  createUser,
  createUserSession,
  resolveUserSession,
  listUserSessions,
  revokeUserSessionById,
  revokeOtherUserSessions,
  db,
} from '@platform/shared';

function uniqueEmail(p: string): string {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function freshUser() {
  return createUser({ email: uniqueEmail('sess'), password: 'a-good-long-password' });
}

describe('listUserSessions', () => {
  it('returns active sessions newest-active first, with metadata', async () => {
    const u = await freshUser();
    await createUserSession(u.id, { ip: '10.0.0.1', userAgent: 'DeviceA' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await createUserSession(u.id, { ip: '10.0.0.2', userAgent: 'DeviceB' });

    const sessions = await listUserSessions(u.id);
    expect(sessions.length).toBe(2);
    // Most recently created/seen first.
    expect(sessions[0].id).toBe(b.session_id);
    expect(sessions[0].user_agent).toBe('DeviceB');
    expect(sessions[0].ip).toBe('10.0.0.2');
    // Never leaks the token hash.
    expect((sessions[0] as any).token_hash).toBeUndefined();
  });

  it('excludes revoked and expired sessions', async () => {
    const u = await freshUser();
    const active = await createUserSession(u.id, {});
    const revoked = await createUserSession(u.id, {});
    const expired = await createUserSession(u.id, {});
    await revokeUserSessionById(u.id, revoked.session_id);
    await db.updateTable('user_sessions').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', expired.session_id).execute();

    const ids = (await listUserSessions(u.id)).map((s) => s.id);
    expect(ids).toContain(active.session_id);
    expect(ids).not.toContain(revoked.session_id);
    expect(ids).not.toContain(expired.session_id);
  });
});

describe('revokeUserSessionById', () => {
  it('revokes the session so its token no longer resolves', async () => {
    const u = await freshUser();
    const s = await createUserSession(u.id, {});
    expect(await resolveUserSession(s.token)).not.toBeNull();

    expect(await revokeUserSessionById(u.id, s.session_id)).toBe(true);
    expect(await resolveUserSession(s.token)).toBeNull();
  });

  it('is idempotent', async () => {
    const u = await freshUser();
    const s = await createUserSession(u.id, {});
    expect(await revokeUserSessionById(u.id, s.session_id)).toBe(true);
    expect(await revokeUserSessionById(u.id, s.session_id)).toBe(true);
  });

  it('will not revoke another user\'s session', async () => {
    const owner = await freshUser();
    const attacker = await freshUser();
    const s = await createUserSession(owner.id, {});

    expect(await revokeUserSessionById(attacker.id, s.session_id)).toBe(false);
    // The owner's session is untouched and still resolves.
    expect(await resolveUserSession(s.token)).not.toBeNull();
  });

  it('returns false for an unknown session id', async () => {
    const u = await freshUser();
    expect(await revokeUserSessionById(u.id, '00000000-0000-0000-0000-000000000000')).toBe(false);
  });
});

describe('revokeOtherUserSessions', () => {
  it('revokes every session except the kept one and reports the count', async () => {
    const u = await freshUser();
    const keep = await createUserSession(u.id, {});
    const a = await createUserSession(u.id, {});
    const b = await createUserSession(u.id, {});

    const revoked = await revokeOtherUserSessions(u.id, keep.session_id);
    expect(revoked).toBe(2);

    // Kept session still resolves; the others don't.
    expect(await resolveUserSession(keep.token)).not.toBeNull();
    expect(await resolveUserSession(a.token)).toBeNull();
    expect(await resolveUserSession(b.token)).toBeNull();
  });

  it('returns 0 when there are no other sessions', async () => {
    const u = await freshUser();
    const only = await createUserSession(u.id, {});
    expect(await revokeOtherUserSessions(u.id, only.session_id)).toBe(0);
    expect(await resolveUserSession(only.token)).not.toBeNull();
  });

  it('does not touch a different user\'s sessions', async () => {
    const u = await freshUser();
    const other = await freshUser();
    const keep = await createUserSession(u.id, {});
    await createUserSession(u.id, {});
    const otherSession = await createUserSession(other.id, {});

    await revokeOtherUserSessions(u.id, keep.session_id);
    expect(await resolveUserSession(otherSession.token)).not.toBeNull();
  });
});
