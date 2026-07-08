import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './harness.js';
import { createAdminUser, db, isEncrypted, totpCode } from '@platform/shared';

let app: FastifyInstance;

const EMAIL = `admin-mfa-${Date.now()}@admin.test`;
const PASSWORD = 'admin-mfa-password-123';

beforeAll(async () => {
  app = await buildTestApp();
  const created = await createAdminUser({ email: EMAIL, name: 'MFA Admin', role: 'operator', password: PASSWORD });
  if ('error' in created) throw new Error('failed to create admin');
});

afterAll(async () => {
  await app.close();
});

async function login(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/admin/auth/login', payload });
}

function adminReq(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as any,
    url,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  });
}

describe('admin MFA (TOTP)', () => {
  it('enrolls, confirms, enforces TOTP on login, and disables MFA', async () => {
    const firstLogin = await login({ email: EMAIL, password: PASSWORD });
    expect(firstLogin.statusCode).toBe(200);
    const token = firstLogin.json().token as string;

    const enroll = await adminReq(token, 'POST', '/admin/auth/mfa/enroll');
    expect(enroll.statusCode).toBe(200);
    const secret = enroll.json().secret as string;
    expect(secret).toBeTruthy();
    expect(enroll.json().otpauth_url).toContain('otpauth://totp/');

    const beforeConfirm = await db
      .selectFrom('admin_users')
      .select(['id', 'totp_secret', 'totp_enabled'])
      .where('email', '=', EMAIL)
      .executeTakeFirstOrThrow();
    expect(beforeConfirm.totp_enabled).toBe(false);
    expect(beforeConfirm.totp_secret).toBeTruthy();
    expect(isEncrypted(beforeConfirm.totp_secret!)).toBe(true);

    const code = totpCode(secret);
    const confirm = await adminReq(token, 'POST', '/admin/auth/mfa/confirm', { code });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toMatchObject({ ok: true, totp_enabled: true });

    const afterConfirm = await db
      .selectFrom('admin_users')
      .select(['totp_enabled'])
      .where('email', '=', EMAIL)
      .executeTakeFirstOrThrow();
    expect(afterConfirm.totp_enabled).toBe(true);

    const missing = await login({ email: EMAIL, password: PASSWORD });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().error).toBe('mfa_required');

    const wrong = await login({ email: EMAIL, password: PASSWORD, code: '000000' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe('mfa_invalid');

    const withCode = await login({ email: EMAIL, password: PASSWORD, code: totpCode(secret) });
    expect(withCode.statusCode).toBe(200);
    expect(withCode.json().token).toMatch(/^mpadm_/);

    const disable = await adminReq(withCode.json().token, 'POST', '/admin/auth/mfa/disable');
    expect(disable.statusCode).toBe(200);
    expect(disable.json()).toMatchObject({ ok: true, totp_enabled: false });

    const afterDisable = await login({ email: EMAIL, password: PASSWORD });
    expect(afterDisable.statusCode).toBe(200);
    expect(afterDisable.json().token).toMatch(/^mpadm_/);
  });
});
