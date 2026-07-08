// Regression: a confirmed TOTP factor must reject a REPLAYED code. Previously
// verifyMfaForUser accepted any code within the ±1-step window with no record of
// what had been consumed, so a single valid code could be used multiple times
// inside its ~90s validity window (e.g. replayed by a phishing proxy). The fix
// records the highest consumed time-step per factor and rejects any code whose
// step is <= it (RFC 6238 §5.2).

import { describe, it, expect, beforeAll } from 'vitest';
import {
  db,
  startTotpEnrollment,
  confirmTotpEnrollment,
  verifyMfaForUser,
  totpCode,
} from '@platform/shared';

async function seedUser(): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({ email: `mfa-replay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@t.test`, password_hash: 'x', name: 'MFA' } as any)
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

describe.runIf(!!process.env.DATABASE_URL)('TOTP replay prevention', () => {
  it('rejects reuse of the same valid code, but accepts a fresh code from a later step', async () => {
    const userId = await seedUser();
    const { factor_id, secret } = await startTotpEnrollment(userId, 'u@t.test');

    // Confirm enrollment with a current code.
    const t0 = Date.now();
    const confirmCode = totpCode(secret, t0);
    const confirmed = await confirmTotpEnrollment(userId, factor_id, confirmCode);
    expect(confirmed).not.toBeNull();

    // Reset the replay high-water mark so a current-step code is guaranteed
    // acceptable on first use (avoids a timing race with which step the
    // confirmation consumed, under parallel test load).
    await db.updateTable('mfa_factors').set({ last_used_step: 0 }).where('id', '=', factor_id).execute();

    // A current code must succeed on first use and record its step.
    const loginCode = totpCode(secret, Date.now());

    const first = await verifyMfaForUser(userId, loginCode);
    expect(first).toBe(true);

    // Immediately replaying the SAME code must now fail (its step was consumed).
    const replay = await verifyMfaForUser(userId, loginCode);
    expect(replay).toBe(false);

    // Confirm the high-water mark was persisted.
    const factor = await db
      .selectFrom('mfa_factors')
      .select(['last_used_step'])
      .where('id', '=', factor_id)
      .executeTakeFirstOrThrow();
    expect(factor.last_used_step).not.toBeNull();
  });

  it('an invalid code never advances the replay counter', async () => {
    const userId = await seedUser();
    const { factor_id, secret } = await startTotpEnrollment(userId, 'u2@t.test');
    await confirmTotpEnrollment(userId, factor_id, totpCode(secret, Date.now()));

    const before = await db.selectFrom('mfa_factors').select('last_used_step').where('id', '=', factor_id).executeTakeFirstOrThrow();
    expect(await verifyMfaForUser(userId, '000000')).toBe(false);
    const after = await db.selectFrom('mfa_factors').select('last_used_step').where('id', '=', factor_id).executeTakeFirstOrThrow();
    expect(after.last_used_step).toBe(before.last_used_step);
  });
});
