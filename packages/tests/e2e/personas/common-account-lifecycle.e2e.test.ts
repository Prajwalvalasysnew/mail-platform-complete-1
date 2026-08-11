// Common account lifecycle exercised independently for every current plan.
// Plan does not gate identity features; Free, Paid, and Enterprise must all
// receive the same authentication and session-security guarantees.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CapturingPlatformMailer, db, setPlatformMailer, totpCode } from '@platform/shared';
import { buildTestApp } from '../harness.js';
import {
  PERSONA_PLAN,
  PERSONA_TIERS,
  passwordLogin,
  registerVerifiedHumanPersona,
  sessionHeaders,
  type PersonaTier,
} from './persona-helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
  setPlatformMailer(new CapturingPlatformMailer());
});

afterAll(async () => {
  setPlatformMailer(null);
  await app.close();
});

describe.each(PERSONA_TIERS)('common account lifecycle: %s', (tier: PersonaTier) => {
  it('enrolls, challenges, and disables TOTP without a plan-specific bypass', async () => {
    const persona = await registerVerifiedHumanPersona(app, tier, 'totp');
    const enroll = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enroll',
      headers: sessionHeaders(persona.sessionToken),
    });
    expect(enroll.statusCode).toBe(200);

    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/confirm',
      headers: { ...sessionHeaders(persona.sessionToken), 'content-type': 'application/json' },
      payload: {
        factor_id: enroll.json().factor_id,
        code: totpCode(enroll.json().secret),
      },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().recovery_codes).toHaveLength(10);

    const login = await passwordLogin(app, persona.email, persona.password, `${tier}-mfa-browser`);
    expect(login.statusCode).toBe(200);
    expect(login.json().mfa_required).toBe(true);
    expect((await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: sessionHeaders(login.json().token),
    })).statusCode).toBe(403);

    const challenge = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa',
      headers: { ...sessionHeaders(login.json().token), 'content-type': 'application/json' },
      payload: { code: totpCode(enroll.json().secret) },
    });
    expect(challenge.statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: sessionHeaders(login.json().token),
    })).statusCode).toBe(200);

    const disable = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/disable',
      headers: sessionHeaders(login.json().token),
    });
    expect(disable.statusCode).toBe(200);
    const stored = await db.selectFrom('users').select('mfa_enabled')
      .where('id', '=', persona.userId).executeTakeFirstOrThrow();
    expect(stored.mfa_enabled).toBe(false);
  });

  it('registers, verifies, logs in, and resolves the correct organization plan', async () => {
    const persona = await registerVerifiedHumanPersona(app, tier, 'identity');
    const login = await passwordLogin(app, persona.email, persona.password, `${tier}-primary-browser`);
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ mfa_required: false, user: { email: persona.email } });

    const me = await app.inject({
      method: 'GET', url: '/v1/auth/me', headers: sessionHeaders(login.json().token),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      current_customer_id: persona.customerId,
      current_role: 'owner',
      user: { id: persona.userId, email: persona.email, mfa_enabled: false },
    });
    expect(me.json().memberships).toEqual(expect.arrayContaining([
      expect.objectContaining({ customer_id: persona.customerId, role: 'owner' }),
    ]));

    const plan = PERSONA_PLAN[tier];
    const stored = await db.selectFrom('customers')
      .select(['tier', 'daily_quota', 'monthly_quota', 'email_verified_at'])
      .where('id', '=', persona.customerId).executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ tier, daily_quota: plan.daily, monthly_quota: plan.monthly });
    expect(stored.email_verified_at).toBeTruthy();

    const resend = await app.inject({
      method: 'POST', url: '/v1/auth/resend-verification', headers: sessionHeaders(login.json().token),
    });
    expect(resend.statusCode).toBe(200);
    expect(resend.json()).toMatchObject({ ok: true, already_verified: true });
  });

  it('lists devices, revokes one session, and logs out everywhere else safely', async () => {
    const persona = await registerVerifiedHumanPersona(app, tier, 'sessions');
    const browserB = await passwordLogin(app, persona.email, persona.password, `${tier}-browser-b`);
    const browserC = await passwordLogin(app, persona.email, persona.password, `${tier}-browser-c`);
    expect(browserB.statusCode).toBe(200);
    expect(browserC.statusCode).toBe(200);

    const listed = await app.inject({
      method: 'GET', url: '/v1/auth/sessions', headers: sessionHeaders(persona.sessionToken),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().sessions.length).toBeGreaterThanOrEqual(3);
    expect(listed.json().sessions.filter((session: { current: boolean }) => session.current)).toHaveLength(1);
    for (const session of listed.json().sessions) {
      expect(session.token).toBeUndefined();
      expect(session.token_hash).toBeUndefined();
    }

    const sessionB = listed.json().sessions.find(
      (session: { user_agent: string | null }) => session.user_agent === `${tier}-browser-b`,
    );
    expect(sessionB).toBeTruthy();
    const revokeB = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${sessionB.id}`,
      headers: sessionHeaders(persona.sessionToken),
    });
    expect(revokeB.statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET', url: '/v1/auth/me', headers: sessionHeaders(browserB.json().token),
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'GET', url: '/v1/auth/me', headers: sessionHeaders(browserC.json().token),
    })).statusCode).toBe(200);

    const revokeOthers = await app.inject({
      method: 'POST',
      url: '/v1/auth/sessions/revoke-others',
      headers: sessionHeaders(persona.sessionToken),
    });
    expect(revokeOthers.statusCode).toBe(200);
    expect(revokeOthers.json().revoked).toBeGreaterThanOrEqual(1);
    expect((await app.inject({
      method: 'GET', url: '/v1/auth/me', headers: sessionHeaders(browserC.json().token),
    })).statusCode).toBe(401);
    const remaining = await app.inject({
      method: 'GET', url: '/v1/auth/sessions', headers: sessionHeaders(persona.sessionToken),
    });
    expect(remaining.statusCode).toBe(200);
    expect(remaining.json().sessions).toHaveLength(1);
  });

  it('resets the password, revokes every old session, and supports explicit logout', async () => {
    const persona = await registerVerifiedHumanPersona(app, tier, 'password-reset');
    const second = await passwordLogin(app, persona.email, persona.password, `${tier}-reset-browser`);
    expect(second.statusCode).toBe(200);

    const forgot = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/forgot',
      headers: { 'content-type': 'application/json' },
      payload: { email: persona.email },
    });
    expect(forgot.statusCode).toBe(200);
    expect(forgot.json()._dev_password_reset_token).toBeTruthy();

    const nextPassword = 'Persona-Replaced-Password-456!';
    const reset = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/reset',
      headers: { 'content-type': 'application/json' },
      payload: { token: forgot.json()._dev_password_reset_token, password: nextPassword },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().ok).toBe(true);

    for (const oldToken of [persona.sessionToken, second.json().token]) {
      expect((await app.inject({
        method: 'GET', url: '/v1/auth/me', headers: sessionHeaders(oldToken),
      })).statusCode).toBe(401);
    }
    expect((await passwordLogin(app, persona.email, persona.password)).statusCode).toBe(401);

    const replacement = await passwordLogin(app, persona.email, nextPassword, `${tier}-replacement-browser`);
    expect(replacement.statusCode).toBe(200);
    const replacementToken = replacement.json().token as string;
    const logout = await app.inject({
      method: 'POST', url: '/v1/auth/logout', headers: sessionHeaders(replacementToken),
    });
    expect(logout.statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET', url: '/v1/auth/me', headers: sessionHeaders(replacementToken),
    })).statusCode).toBe(401);

    const finalCustomer = await db.selectFrom('customers').select('tier')
      .where('id', '=', persona.customerId).executeTakeFirstOrThrow();
    expect(finalCustomer.tier).toBe(tier);
  });
});
