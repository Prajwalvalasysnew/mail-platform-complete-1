// E2E: dashboard (human-session) sending-domain management.
// Lifecycle (add -> detail -> verify -> delete), duplicate 409, the
// domains:manage capability gate, per-org 404, validation, and auth guard.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './harness.js';
import {
  createUser,
  addMembership,
  createUserSession,
  seedCustomer,
  addDomain,
  CapturingPlatformMailer,
  setPlatformMailer,
} from '@platform/shared';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
  setPlatformMailer(new CapturingPlatformMailer());
});
afterAll(async () => {
  await app.close();
  setPlatformMailer(null);
});

const uniqueEmail = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const rndDomain = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.example.com`;
const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
const authNoBody = (t: string) => ({ authorization: `Bearer ${t}` });

async function ownerSession(): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email: uniqueEmail('domowner'), password: 'a-good-long-password', org_name: 'Domain Org' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().token as string;
}

describe('E2E dashboard domains', () => {
  it('adds, fetches detail, verifies, and deletes a domain', async () => {
    const token = await ownerSession();
    const d = rndDomain('flow');

    const add = await app.inject({ method: 'POST', url: '/v1/account/domains', headers: auth(token), payload: { domain: d } });
    expect(add.statusCode).toBe(201);
    const created = add.json();
    expect(created.dns_records).toHaveLength(5);
    expect(created.verification_token).toBeTruthy();

    const detail = await app.inject({ method: 'GET', url: `/v1/account/domains/${created.id}`, headers: authNoBody(token) });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().dns_records).toHaveLength(5);

    const list = await app.inject({ method: 'GET', url: '/v1/account/domains', headers: authNoBody(token) });
    expect(list.json().domains.some((x: any) => x.id === created.id)).toBe(true);

    // No real DNS published -> not verified, but the endpoint works.
    const verify = await app.inject({ method: 'POST', url: `/v1/account/domains/${created.id}/verify`, headers: authNoBody(token) });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().verified).toBe(false);
    expect(verify.json().results).toHaveProperty('dkim');

    const del = await app.inject({ method: 'DELETE', url: `/v1/account/domains/${created.id}`, headers: authNoBody(token) });
    expect(del.statusCode).toBe(200);
    expect(del.json().ok).toBe(true);
  });

  it('returns 409 with the existing id on a duplicate domain', async () => {
    const token = await ownerSession();
    const d = rndDomain('dup');
    const first = await app.inject({ method: 'POST', url: '/v1/account/domains', headers: auth(token), payload: { domain: d } });
    const dup = await app.inject({ method: 'POST', url: '/v1/account/domains', headers: auth(token), payload: { domain: d } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('domain_exists');
    expect(dup.json().domain_id).toBe(first.json().id);
  });

  it('rejects an invalid domain', async () => {
    const token = await ownerSession();
    const res = await app.inject({ method: 'POST', url: '/v1/account/domains', headers: auth(token), payload: { domain: 'not a domain' } });
    expect(res.statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/account/domains' })).statusCode).toBe(401);
  });

  it('enforces domains:manage (an analyst is denied)', async () => {
    const org = await seedCustomer();
    const user = await createUser({ email: uniqueEmail('analyst'), password: 'analyst-pw-1234' });
    await addMembership(user.id, org.customerId, 'analyst');
    const session = await createUserSession(user.id, { currentCustomerId: org.customerId, mfaSatisfied: true });
    const res = await app.inject({ method: 'GET', url: '/v1/account/domains', headers: authNoBody(session.token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('insufficient_role');
  });

  it('returns 404 for a domain in another org', async () => {
    const token = await ownerSession();
    const other = await seedCustomer();
    const foreign = await addDomain({ customerId: other.customerId, domain: rndDomain('foreign') });

    expect((await app.inject({ method: 'GET', url: `/v1/account/domains/${foreign.id}`, headers: authNoBody(token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/account/domains/${foreign.id}/verify`, headers: authNoBody(token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/v1/account/domains/${foreign.id}`, headers: authNoBody(token) })).statusCode).toBe(404);
  });
});
