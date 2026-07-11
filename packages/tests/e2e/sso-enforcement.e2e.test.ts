// E2E: customer SSO enforcement. When an org enables SSO enforcement, its
// members can no longer log in with a password (they must use the IdP), but an
// existing dashboard session can still toggle the policy back off.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './harness.js';

let app: FastifyInstance;

beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

function uniqueEmail(p: string): string {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}
const PW = 'a-good-long-password';
const bearer = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

async function register(email: string) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/register',
    headers: { 'content-type': 'application/json' }, payload: { email, password: PW, org_name: 'SSO Org' } });
  expect(res.statusCode).toBe(201);
  return res.json().token as string;
}
function login(email: string) {
  return app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: { email, password: PW } });
}

describe('customer SSO enforcement', () => {
  it('blocks password login once the org enforces SSO, and reports the policy', async () => {
    const email = uniqueEmail('sso-owner');
    const token = await register(email);

    // Default: not enforced, password login works.
    expect((await app.inject({ method: 'GET', url: '/v1/account/settings/sso', headers: bearer(token) })).json())
      .toMatchObject({ sso_enforced: false });
    expect((await login(email)).statusCode).toBe(200);

    // Enable enforcement.
    const enable = await app.inject({ method: 'PATCH', url: '/v1/account/settings/sso', headers: bearer(token), payload: { enforced: true } });
    expect(enable.statusCode).toBe(200);
    expect(enable.json()).toMatchObject({ sso_enforced: true });

    // Password login is now refused even with correct credentials.
    const blocked = await login(email);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: 'password_login_disabled' });

    // An existing dashboard session can turn it back off (not password-gated).
    const disable = await app.inject({ method: 'PATCH', url: '/v1/account/settings/sso', headers: bearer(token), payload: { enforced: false } });
    expect(disable.statusCode).toBe(200);
    expect((await login(email)).statusCode).toBe(200);
  });

  it('validates the body and requires authentication', async () => {
    const token = await register(uniqueEmail('sso-validate'));
    expect((await app.inject({ method: 'PATCH', url: '/v1/account/settings/sso', headers: bearer(token), payload: { enforced: 'yes' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/account/settings/sso' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PATCH', url: '/v1/account/settings/sso', headers: { 'content-type': 'application/json' }, payload: { enforced: true } })).statusCode).toBe(401);
  });
});
