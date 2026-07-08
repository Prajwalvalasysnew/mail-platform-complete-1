// Regression: accepting a team invite must NEVER hand out a full,
// MFA-satisfied session to a user who already has MFA enrolled. Before this
// fix, /v1/team/invites/accept always created the session with
// mfaSatisfied: true regardless of the invited user's MFA state — so anyone
// who could send an existing MFA-enabled user an invite link (or who
// compromised the invite token) got a fully authenticated session while
// completely bypassing that user's second factor.
//
// Brand-new users (no account existed before the invite) are unaffected:
// they have no MFA to bypass, so their session is still immediately usable.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './harness.js';
import { CapturingPlatformMailer, setPlatformMailer, db, totpCode } from '@platform/shared';

let app: FastifyInstance;
let mail: CapturingPlatformMailer;

beforeAll(async () => {
  app = await buildTestApp();
  mail = new CapturingPlatformMailer();
  setPlatformMailer(mail);
});

afterAll(async () => {
  await app.close();
  setPlatformMailer(null);
});

function uniqueEmail(p: string): string {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function register(email: string, password = 'a-good-long-password') {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email, password, name: 'Owner', org_name: `Org ${email}` },
  });
}

async function inviteAndExtractToken(ownerToken: string, inviteeEmail: string): Promise<string> {
  mail.reset();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/team/invites',
    headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
    payload: { email: inviteeEmail, role: 'developer' },
  });
  expect(res.statusCode).toBe(201);
  const sent = mail.to(inviteeEmail);
  const match = sent[0].html.match(/accept-invite\?token=([^"&\s]+)/);
  if (!match) throw new Error('invite token not found in email body');
  return decodeURIComponent(match[1]);
}

async function acceptInvite(token: string, extra?: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/team/invites/accept',
    headers: { 'content-type': 'application/json' },
    payload: { token, ...extra },
  });
}

describe('invite acceptance MFA safety', () => {
  it('a brand-new invitee gets an immediately usable (MFA-satisfied) session', async () => {
    const ownerEmail = uniqueEmail('owner-new');
    const ownerReg = await register(ownerEmail);
    const ownerToken = ownerReg.json().token as string;

    const inviteeEmail = uniqueEmail('brandnew');
    const token = await inviteAndExtractToken(ownerToken, inviteeEmail);

    const accept = await acceptInvite(token, { name: 'New Person', password: 'another-long-password' });
    expect(accept.statusCode).toBe(201);
    const body = accept.json();
    expect(body.mfa_required).toBe(false);

    // The returned session should work immediately for a capability-gated route.
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${body.token}` } });
    expect(me.statusCode).toBe(200);
  });

  it('an existing MFA-enabled user accepting an invite does NOT get an MFA-satisfied session', async () => {
    // 1. Create the invitee as a standalone, independent account and enroll MFA.
    const inviteeEmail = uniqueEmail('mfauser');
    const invReg = await register(inviteeEmail);
    const inviteeOwnToken = invReg.json().token as string;

    const enroll = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enroll',
      headers: { authorization: `Bearer ${inviteeOwnToken}` },
    });
    expect(enroll.statusCode).toBe(200);
    const secret = enroll.json().secret as string;
    const factorId = enroll.json().factor_id as string;
    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/confirm',
      headers: { authorization: `Bearer ${inviteeOwnToken}`, 'content-type': 'application/json' },
      payload: { factor_id: factorId, code: totpCode(secret) },
    });
    expect(confirm.statusCode).toBe(200);

    const userRow = await db.selectFrom('users').select(['mfa_enabled']).where('email', '=', inviteeEmail).executeTakeFirstOrThrow();
    expect(userRow.mfa_enabled).toBe(true);

    // 2. A second org owner invites that SAME email address to join their org.
    const ownerEmail = uniqueEmail('owner-existing');
    const ownerReg = await register(ownerEmail);
    const ownerToken = ownerReg.json().token as string;
    const token = await inviteAndExtractToken(ownerToken, inviteeEmail);

    // 3. Accept the invite (no password needed — the user already exists).
    const accept = await acceptInvite(token);
    expect(accept.statusCode).toBe(201);
    const body = accept.json();

    // THE FIX: the response must say MFA is still required, and the session
    // token must NOT be treated as MFA-satisfied server-side.
    expect(body.mfa_required).toBe(true);

    // Robust check: a route that requires a FULL (MFA-satisfied) session must
    // reject this token even though it's a validly-signed, unexpired session.
    // requireFullUser returns 403 mfa_required (not 401) for this case.
    const sensitive = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/disable',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(sensitive.statusCode).toBe(403);
    expect(sensitive.json().error).toBe('mfa_required');

    // But the MFA challenge endpoint (which only needs a non-full session)
    // should still work, since the point is to let them complete MFA, not to
    // lock them out entirely.
    const challenge = await app.inject({
      method: 'POST',
      url: '/v1/auth/mfa',
      headers: { authorization: `Bearer ${body.token}`, 'content-type': 'application/json' },
      payload: { code: totpCode(secret) },
    });
    expect(challenge.statusCode).toBe(200);

    // After completing the challenge, the session IS usable for sensitive routes.
    const afterChallenge = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(afterChallenge.statusCode).toBe(200);
  });
});
