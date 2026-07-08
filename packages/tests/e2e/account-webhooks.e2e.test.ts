// E2E: dashboard (human-session) webhook management.
// Full lifecycle, the settings:manage capability gate, SSRF rejection,
// per-org 404 isolation, and the auth guard.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './harness.js';
import {
  createUser,
  addMembership,
  createUserSession,
  seedCustomer,
  createWebhook,
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

const PUB = 'https://93.184.216.34/hook';
const uniqueEmail = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
const authNoBody = (t: string) => ({ authorization: `Bearer ${t}` });

async function ownerSession(): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email: uniqueEmail('whowner'), password: 'a-good-long-password', org_name: 'WH Org' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().token as string;
}

describe('E2E dashboard webhooks', () => {
  it('creates, lists, updates, rotates the secret, and deletes a webhook', async () => {
    const token = await ownerSession();

    const create = await app.inject({
      method: 'POST', url: '/v1/account/webhooks', headers: auth(token),
      payload: { url: PUB, events: ['delivered', 'hard_bounce'] },
    });
    expect(create.statusCode).toBe(201);
    const wh = create.json();
    expect(wh.secret).toMatch(/^[0-9a-f]{64}$/);

    const list = await app.inject({ method: 'GET', url: '/v1/account/webhooks', headers: authNoBody(token) });
    expect(list.statusCode).toBe(200);
    expect(list.json().webhooks.some((w: any) => w.id === wh.id)).toBe(true);

    const patch = await app.inject({
      method: 'PATCH', url: `/v1/account/webhooks/${wh.id}`, headers: auth(token),
      payload: { enabled: false, events: ['opened'] },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().enabled).toBe(false);
    expect(patch.json().events).toEqual(['opened']);

    const rotate = await app.inject({ method: 'POST', url: `/v1/account/webhooks/${wh.id}/rotate-secret`, headers: authNoBody(token) });
    expect(rotate.statusCode).toBe(201);
    expect(rotate.json().secret).not.toBe(wh.secret);

    const del = await app.inject({ method: 'DELETE', url: `/v1/account/webhooks/${wh.id}`, headers: authNoBody(token) });
    expect(del.statusCode).toBe(200);
    expect(del.json().ok).toBe(true);
  });

  it('rejects an SSRF / private-address webhook URL', async () => {
    const token = await ownerSession();
    const res = await app.inject({
      method: 'POST', url: '/v1/account/webhooks', headers: auth(token),
      payload: { url: 'http://127.0.0.1/hook', events: ['delivered'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_webhook_url');
  });

  it('requires authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/account/webhooks' })).statusCode).toBe(401);
  });

  it('enforces settings:manage (a developer is denied)', async () => {
    const org = await seedCustomer();
    const user = await createUser({ email: uniqueEmail('dev'), password: 'developer-pw-123' });
    await addMembership(user.id, org.customerId, 'developer');
    const session = await createUserSession(user.id, { currentCustomerId: org.customerId, mfaSatisfied: true });

    const res = await app.inject({ method: 'GET', url: '/v1/account/webhooks', headers: authNoBody(session.token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('insufficient_role');
  });

  it('returns 404 for a webhook in another org', async () => {
    const token = await ownerSession();
    const other = await seedCustomer();
    const foreign = await createWebhook({ customerId: other.customerId, url: PUB, events: ['delivered'] });

    const patch = await app.inject({ method: 'PATCH', url: `/v1/account/webhooks/${foreign.id}`, headers: auth(token), payload: { enabled: false } });
    expect(patch.statusCode).toBe(404);
    const rotate = await app.inject({ method: 'POST', url: `/v1/account/webhooks/${foreign.id}/rotate-secret`, headers: authNoBody(token) });
    expect(rotate.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/v1/account/webhooks/${foreign.id}`, headers: authNoBody(token) });
    expect(del.statusCode).toBe(404);
  });
});
