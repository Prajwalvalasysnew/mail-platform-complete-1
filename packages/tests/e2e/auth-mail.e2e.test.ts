// E2E: the human-auth flows actually send platform email over HTTP.
//
// register -> verification email; password/forgot -> reset email;
// team/invites -> invite email. We swap in a capturing mailer and assert the
// recipient and that the token-bearing link is present.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './harness.js';
import { CapturingPlatformMailer, setPlatformMailer } from '@platform/shared';

let app: FastifyInstance;
let mail: CapturingPlatformMailer;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  setPlatformMailer(null);
});

beforeEach(() => {
  mail = new CapturingPlatformMailer();
  setPlatformMailer(mail);
});

function uniqueEmail(p: string): string {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function register(email: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'a-good-long-password', name: 'Owner', org_name: 'Owner Org' },
  });
}

describe('E2E auth email delivery', () => {
  it('register sends a verification email to the new user', async () => {
    const email = uniqueEmail('verify');
    const res = await register(email);
    expect(res.statusCode).toBe(201);

    const sent = mail.to(email);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/verify/i);
    expect(sent[0].html).toContain('/verify-email?token=');
  });

  it('password/forgot sends a reset email for a known account', async () => {
    const email = uniqueEmail('forgot');
    await register(email);
    mail.reset();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/forgot',
      headers: { 'content-type': 'application/json' },
      payload: { email },
    });
    expect(res.statusCode).toBe(200);

    const sent = mail.to(email);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/reset/i);
    expect(sent[0].html).toContain('/reset-password?token=');
  });

  it('password/forgot for an unknown account sends nothing but still returns ok', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/password/forgot',
      headers: { 'content-type': 'application/json' },
      payload: { email: uniqueEmail('nobody') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(mail.sent).toHaveLength(0); // no enumeration signal, no email
  });

  it('inviting a teammate sends an invite email with the org name', async () => {
    const ownerEmail = uniqueEmail('inviter');
    const reg = await register(ownerEmail);
    const token = reg.json().token as string;
    mail.reset();

    const inviteeEmail = uniqueEmail('invitee');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/team/invites',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { email: inviteeEmail, role: 'developer' },
    });
    expect(res.statusCode).toBe(201);

    const sent = mail.to(inviteeEmail);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain('Owner Org');
    expect(sent[0].html).toContain('/accept-invite?token=');
  });

  it('a mailer failure does not break registration (best-effort send)', async () => {
    setPlatformMailer({
      name: 'boom',
      async send() {
        throw new Error('smtp exploded');
      },
    });
    const res = await register(uniqueEmail('resilient'));
    expect(res.statusCode).toBe(201); // request still succeeds
  });
});
