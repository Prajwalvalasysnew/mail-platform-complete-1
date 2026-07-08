// Exercises the published SDK against the real API. The SDK is transport-
// agnostic (accepts a custom `fetch`), so we route its requests through the
// Fastify app's inject() — proving the client builds correct requests, sends
// the Bearer key, parses JSON, and maps errors, end-to-end with no network.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp } from './harness.js';
import { seedCustomer, db } from '@platform/shared';
import { MailPlatformClient, MailPlatformError } from '@platform/sdk';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});
afterAll(async () => {
  await app.close();
});

const BASE = 'http://test.local/v1';

// Adapt the SDK's fetch calls to Fastify inject().
function injectFetch(): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const res = await app.inject({
      method: (init.method ?? 'GET') as any,
      url: u.pathname + u.search,
      headers: init.headers,
      ...(init.body ? { payload: init.body } : {}),
    });
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      text: async () => res.body,
    } as Response;
  }) as unknown as typeof fetch;
}

describe('SDK against the live API', () => {
  it('performs suppression CRUD', async () => {
    const cust = await seedCustomer({ scopes: ['suppressions'] });
    const mp = new MailPlatformClient({ apiKey: cust.apiKey, baseUrl: BASE, fetch: injectFetch() });

    const email = `sdk-${Date.now()}@example.com`;
    await mp.suppressions.add(email, 'manual');
    const list = (await mp.suppressions.list()) as { suppressions: Array<{ email: string }> };
    expect(list.suppressions.some((s) => s.email === email)).toBe(true);
    await mp.suppressions.remove(email);
  });

  it('creates and fetches a template', async () => {
    const cust = await seedCustomer({ scopes: ['templates'] });
    const mp = new MailPlatformClient({ apiKey: cust.apiKey, baseUrl: BASE, fetch: injectFetch() });

    const created = await mp.templates.create({ name: `welcome-${Date.now()}`, subject: 'Hi {{name}}', html_body: '<p>Hello {{name}}</p>' });
    expect(created.id).toBeTruthy();
    const fetched = await mp.templates.get(created.id);
    expect(fetched.id).toBe(created.id);
  });

  it('sends an email and returns accepted + message_ids', async () => {
    const cust = await seedCustomer({ scopes: ['send'] });
    // Seed a verified sending domain so the API accepts the from address.
    const domain = `mail-${Date.now()}.test.example`;
    await db.insertInto('sending_domains').values({
      customer_id: cust.customerId, domain,
      dkim_public_key: 'test-pub', dkim_private_key: 'test-priv',
      verified_at: new Date(), dkim_verified: true, spf_verified: true,
    } as any).execute();

    const mp = new MailPlatformClient({ apiKey: cust.apiKey, baseUrl: BASE, fetch: injectFetch() });
    const res = await mp.messages.send({ from: `hello@${domain}`, to: 'rcpt@example.com', subject: 'Hi', text: 'Hello there' });
    expect(res.accepted).toBe(1);
    expect(Array.isArray(res.message_ids)).toBe(true);
    expect(res.message_ids.length).toBe(1);
  });

  it('maps an auth failure to MailPlatformError with status 401', async () => {
    const mp = new MailPlatformClient({ apiKey: 'mpk_not_a_real_key', baseUrl: BASE, fetch: injectFetch() });
    await expect(mp.suppressions.list()).rejects.toBeInstanceOf(MailPlatformError);
    try {
      await mp.suppressions.list();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MailPlatformError);
      expect((err as MailPlatformError).status).toBe(401);
    }
  });

  it('enforces scope: a key without the suppressions scope is rejected', async () => {
    const cust = await seedCustomer({ scopes: ['templates'] }); // no 'suppressions'
    const mp = new MailPlatformClient({ apiKey: cust.apiKey, baseUrl: BASE, fetch: injectFetch() });
    await expect(mp.suppressions.list()).rejects.toMatchObject({ status: 403 });
  });
});
