// E2E: self-service API key management over HTTP via a human session.
// Proves the route wiring, the apikeys:manage capability gate, org scoping,
// and that a key created through the dashboard actually authenticates.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './harness.js';
import {
  createUser,
  addMembership,
  createUserSession,
  seedCustomer,
  CapturingPlatformMailer,
  setPlatformMailer,
} from '@platform/shared';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
  setPlatformMailer(new CapturingPlatformMailer()); // swallow registration emails
});
afterAll(async () => {
  await app.close();
  setPlatformMailer(null);
});

function uniqueEmail(p: string): string {
  return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function ownerSession(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email: uniqueEmail('keyowner'), password: 'a-good-long-password', org_name: 'Keys Org' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().token as string;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

// For bodyless POST/DELETE (rotate, revoke): no JSON content-type, so Fastify
// doesn't expect a body. This is how a real client issues these calls.
function authNoBody(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('E2E self-service API keys', () => {
  it('creates, lists, rotates, and revokes a key', async () => {
    const token = await ownerSession();

    const create = await app.inject({
      method: 'POST', url: '/v1/account/api-keys', headers: auth(token),
      payload: { name: 'production', scopes: ['send', 'messages'] },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json();
    expect(created.api_key).toMatch(/^mp_live_/);
    expect(created.scopes).toEqual(['send', 'messages']);

    const list = await app.inject({ method: 'GET', url: '/v1/account/api-keys', headers: auth(token) });
    expect(list.statusCode).toBe(200);
    const keys = list.json().keys;
    const row = keys.find((k: any) => k.id === created.id);
    expect(row).toBeTruthy();
    expect(row.key_hash).toBeUndefined(); // metadata only
    expect(row.api_key).toBeUndefined();

    const rotate = await app.inject({ method: 'POST', url: `/v1/account/api-keys/${created.id}/rotate`, headers: authNoBody(token) });
    expect(rotate.statusCode).toBe(201);
    expect(rotate.json().rotated_from_id).toBe(created.id);
    expect(rotate.json().api_key).toMatch(/^mp_live_/);

    const del = await app.inject({ method: 'DELETE', url: `/v1/account/api-keys/${created.id}`, headers: authNoBody(token) });
    expect(del.statusCode).toBe(200);
    expect(del.json().ok).toBe(true);
  });

  it('a key created through the dashboard authenticates against the API', async () => {
    const token = await ownerSession();
    const create = await app.inject({
      method: 'POST', url: '/v1/account/api-keys', headers: auth(token),
      payload: { name: 'usable', scopes: ['messages'] },
    });
    const apiKey = create.json().api_key as string;

    // The new key should pass authentication on a scoped endpoint (200, not 401).
    const used = await app.inject({
      method: 'GET', url: '/v1/messages?limit=1',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(used.statusCode).not.toBe(401);
  });

  it('rejects a publishable key carrying the send scope', async () => {
    const token = await ownerSession();
    const res = await app.inject({
      method: 'POST', url: '/v1/account/api-keys', headers: auth(token),
      payload: { name: 'bad', key_type: 'publishable', scopes: ['send'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('publishable_cannot_send');
  });

  it('requires a session — anonymous requests get 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/account/api-keys' });
    expect(res.statusCode).toBe(401);
  });

  it('enforces the apikeys:manage capability (analyst is denied)', async () => {
    const org = await seedCustomer();
    const user = await createUser({ email: uniqueEmail('analyst'), password: 'analyst-password-123' });
    await addMembership(user.id, org.customerId, 'analyst');
    const session = await createUserSession(user.id, { currentCustomerId: org.customerId, mfaSatisfied: true });

    const res = await app.inject({ method: 'GET', url: '/v1/account/api-keys', headers: auth(session.token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('insufficient_role');

    const create = await app.inject({
      method: 'POST', url: '/v1/account/api-keys', headers: auth(session.token),
      payload: { name: 'nope' },
    });
    expect(create.statusCode).toBe(403);
  });

  it('returns 404 rotating/revoking a key that is not in the active org', async () => {
    const token = await ownerSession();
    const other = await seedCustomer();
    // create a key in a different org directly
    const { createCustomerApiKey } = await import('@platform/shared');
    const foreign = await createCustomerApiKey({ customerId: other.customerId, name: 'foreign' });

    const rot = await app.inject({ method: 'POST', url: `/v1/account/api-keys/${foreign.id}/rotate`, headers: authNoBody(token) });
    expect(rot.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/v1/account/api-keys/${foreign.id}`, headers: authNoBody(token) });
    expect(del.statusCode).toBe(404);
  });
});
