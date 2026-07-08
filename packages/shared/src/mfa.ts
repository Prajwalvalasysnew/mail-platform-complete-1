// MFA service — TOTP enrollment + challenge, recovery codes.
//
// The TOTP secret is stored encrypted at rest (envelope encryption from
// encryption.ts); the raw base32 secret is only ever returned once at
// enrollment so the user can add it to their authenticator app.

import { db } from './db.js';
import { encryptSecret, decryptSecret } from './encryption.js';
import {
  generateTotpSecret,
  verifyTotp,
  verifyTotpStep,
  otpauthUri,
  generateRecoveryCodes,
  verifyRecoveryCode,
} from './totp.js';
import { IdentityError } from './users.js';

export async function hasConfirmedMfa(userId: string): Promise<boolean> {
  const row = await db
    .selectFrom('mfa_factors')
    .select('id')
    .where('user_id', '=', userId)
    .where('confirmed_at', 'is not', null)
    .executeTakeFirst();
  return !!row;
}

/**
 * Begin TOTP enrollment: generate a secret, store it (unconfirmed, encrypted),
 * and return the secret + provisioning URI for the QR code. Any prior
 * unconfirmed factor is discarded first. Throws if MFA is already active.
 */
export async function startTotpEnrollment(
  userId: string,
  accountEmail: string,
  issuer = process.env.MFA_ISSUER ?? 'MailPlatform'
): Promise<{ factor_id: string; secret: string; otpauth_uri: string }> {
  if (await hasConfirmedMfa(userId)) throw new IdentityError('mfa_already_enabled');
  await db.deleteFrom('mfa_factors').where('user_id', '=', userId).where('confirmed_at', 'is', null).execute();

  const secret = generateTotpSecret();
  const row = await db
    .insertInto('mfa_factors')
    .values({ user_id: userId, type: 'totp', secret_encrypted: encryptSecret(secret) })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  return { factor_id: row.id, secret, otpauth_uri: otpauthUri(secret, accountEmail, issuer) };
}

/**
 * Confirm enrollment by verifying a code against the pending factor. On success
 * the factor is marked confirmed, the user's mfa_enabled flag is set, and a
 * fresh set of one-time recovery codes is generated and returned (shown once).
 */
export async function confirmTotpEnrollment(
  userId: string,
  factorId: string,
  code: string
): Promise<{ recovery_codes: string[] } | null> {
  const factor = await db
    .selectFrom('mfa_factors')
    .select(['id', 'secret_encrypted'])
    .where('id', '=', factorId)
    .where('user_id', '=', userId)
    .where('confirmed_at', 'is', null)
    .executeTakeFirst();
  if (!factor) return null;

  const secret = decryptSecret(factor.secret_encrypted);
  if (!verifyTotp(secret, code)) return null;

  await db.updateTable('mfa_factors').set({ confirmed_at: new Date() }).where('id', '=', factor.id).execute();
  await db.updateTable('users').set({ mfa_enabled: true, updated_at: new Date() }).where('id', '=', userId).execute();

  const codes = generateRecoveryCodes(10);
  await db.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
  await db.insertInto('mfa_recovery_codes').values(codes.map((c) => ({ user_id: userId, code_hash: c.hash }))).execute();
  return { recovery_codes: codes.map((c) => c.code) };
}

/**
 * Verify a login-time MFA response: first try a TOTP code against the confirmed
 * factor, then fall back to consuming a one-time recovery code.
 */
export async function verifyMfaForUser(userId: string, code: string): Promise<boolean> {
  const factor = await db
    .selectFrom('mfa_factors')
    .select(['id', 'secret_encrypted', 'last_used_step'])
    .where('user_id', '=', userId)
    .where('confirmed_at', 'is not', null)
    .executeTakeFirst();
  if (factor) {
    const step = verifyTotpStep(decryptSecret(factor.secret_encrypted), code);
    if (step !== null) {
      // Replay prevention (RFC 6238 §5.2): reject a code from a time-step we have
      // already accepted. Persist the new high-water mark atomically — the
      // conditional UPDATE both records the step and acts as a guard against two
      // concurrent logins replaying the same code (only one UPDATE will match).
      const res = await db
        .updateTable('mfa_factors')
        .set({ last_used_step: step })
        .where('id', '=', factor.id)
        .where((eb) => eb.or([
          eb('last_used_step', 'is', null),
          eb('last_used_step', '<', step),
        ]))
        .executeTakeFirst();
      if (Number(res.numUpdatedRows ?? 0) > 0) return true;
      // The code was valid but its step was already consumed (replay) — fall
      // through to the recovery-code path (which will also fail), returning false.
    }
  }

  // Recovery-code path: find an unused code that matches, then burn it.
  const unused = await db
    .selectFrom('mfa_recovery_codes')
    .select(['id', 'code_hash'])
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .execute();
  for (const rc of unused) {
    if (verifyRecoveryCode(code, rc.code_hash)) {
      await db.updateTable('mfa_recovery_codes').set({ used_at: new Date() }).where('id', '=', rc.id).execute();
      return true;
    }
  }
  return false;
}

export async function disableMfa(userId: string): Promise<void> {
  await db.deleteFrom('mfa_factors').where('user_id', '=', userId).execute();
  await db.deleteFrom('mfa_recovery_codes').where('user_id', '=', userId).execute();
  await db.updateTable('users').set({ mfa_enabled: false, updated_at: new Date() }).where('id', '=', userId).execute();
}

export async function countUnusedRecoveryCodes(userId: string): Promise<number> {
  const row = await db
    .selectFrom('mfa_recovery_codes')
    .select(db.fn.countAll<number>().as('c'))
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .executeTakeFirstOrThrow();
  return Number((row as any).c);
}
