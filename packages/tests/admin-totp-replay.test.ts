// Regression: admin TOTP must reject a replayed code (mirrors mfa-replay for the
// higher-value admin path). verifyAdminTotp previously used bare verifyTotp with
// no consumed-step tracking, so an admin's valid code could be reused within its
// ~90s window. The fix records totp_last_used_step and rejects reuse.

import { describe, it, expect } from 'vitest';
import {
  db,
  createAdminUser,
  beginAdminTotpEnrollment,
  confirmAdminTotpEnrollment,
  verifyAdminTotp,
  totpCode,
} from '@platform/shared';

describe.runIf(!!process.env.DATABASE_URL)('admin TOTP replay prevention', () => {
  it('rejects reuse of a consumed admin TOTP code', async () => {
    const email = `admin-replay-${Date.now()}@t.test`;
    const created = await createAdminUser({ email, role: 'operator', password: 'StrongP@ssw0rd-123456' });
    expect('id' in created).toBe(true);
    const adminUserId = (created as { id: string }).id;

    const enroll = await beginAdminTotpEnrollment(adminUserId);
    expect(enroll).not.toBeNull();
    const secret = enroll!.secret;

    // Confirm enrollment with a current code.
    const confirmed = await confirmAdminTotpEnrollment(adminUserId, totpCode(secret, Date.now()));
    expect(confirmed).toBe(true);

    // Reset the replay high-water mark to a low value so the current-step code is
    // guaranteed to be accepted on first use, independent of which step the
    // confirmation above happened to consume (avoids a timing race under load).
    await db.updateTable('admin_users').set({ totp_last_used_step: 0 }).where('id', '=', adminUserId).execute();

    // Use a CURRENT code (always inside the verification window) for the first
    // login. It must succeed and record its step.
    const code = totpCode(secret, Date.now());
    const first = await verifyAdminTotp(adminUserId, code);
    expect(first).toBe(true);

    // Replaying the same code must now fail (its step was consumed).
    const replay = await verifyAdminTotp(adminUserId, code);
    expect(replay).toBe(false);

    // High-water mark persisted.
    const row = await db.selectFrom('admin_users').select('totp_last_used_step').where('id', '=', adminUserId).executeTakeFirstOrThrow();
    expect(row.totp_last_used_step).not.toBeNull();
    expect(Number(row.totp_last_used_step)).toBeGreaterThan(0);
  });
});
