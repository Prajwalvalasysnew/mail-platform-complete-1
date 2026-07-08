// E2E: authentication, scope enforcement, input validation, and the domain gate.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startHarness,
  seedCustomer,
  seedVerifiedDomain,
  seedUnverifiedDomain,
  type Harness,
} from './harness.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

function send(apiKey: string | null, payload: Record<string, unknown>) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return h.app.inject({ method: 'POST', url: '/v1/send', headers, payload });
}

describe('E2E auth & validation', () => {
  it('rejects missing bearer token with 401', async () => {
    const res = await send(null, { from: 'a@x.com', to: 'b@y.com', subject: 's', text: 't' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('missing_auth');
  });

  it('rejects malformed key format with 401', async () => {
    const res = await send('not-a-real-key', { from: 'a@x.com', to: 'b@y.com', subject: 's', text: 't' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_key');
  });

  it('rejects a well-formed but unknown key with 401', async () => {
    const res = await send('mp_test_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', {
      from: 'a@x.com', to: 'b@y.com', subject: 's', text: 't',
    });
    expect(res.statusCode).toBe(401);
  });

  it('enforces scopes: a key without send scope gets 403', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const res = await send(cust.apiKey, { from: `x@${domain}`, to: 'b@y.com', subject: 's', text: 't' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('insufficient_scope');
  });

  it('rejects sending from an unregistered domain with 403', async () => {
    const cust = await seedCustomer();
    const res = await send(cust.apiKey, {
      from: 'noreply@unregistered-domain.com', to: 'b@y.com', subject: 's', text: 't',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('domain_not_registered');
  });

  it('rejects sending from a registered-but-unverified domain with 403', async () => {
    const cust = await seedCustomer();
    await seedUnverifiedDomain(cust.customerId, 'pending.example.com');
    const res = await send(cust.apiKey, {
      from: 'x@pending.example.com', to: 'b@y.com', subject: 's', text: 't',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('domain_not_verified');
  });

  it('validates the request body (bad email) with 400', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const res = await send(cust.apiKey, { from: `x@${domain}`, to: 'not-an-email', subject: 's', text: 't' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('requires content (no html/text/template) with 400', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const res = await send(cust.apiKey, { from: `x@${domain}`, to: 'b@y.com', subject: 's' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('missing_content');
  });

  it('rejects an oversized html body (>1MB) with 400', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const huge = 'a'.repeat(1_048_577); // one byte over the 1MB cap
    const res = await send(cust.apiKey, { from: `x@${domain}`, to: 'b@y.com', subject: 's', html: huge });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('blocks a suspended account with 403', async () => {
    const cust = await seedCustomer({ status: 'suspended' });
    const domain = await seedVerifiedDomain(cust.customerId);
    const res = await send(cust.apiKey, { from: `x@${domain}`, to: 'b@y.com', subject: 's', text: 't' });
    // suspended is caught either at auth (account not active) or the send gate
    expect([403]).toContain(res.statusCode);
  });

  it('public signup issues a typed key that authenticates immediately', async () => {
    const email = `signup-${Date.now()}@example.com`;
    const signup = await h.app.inject({
      method: 'POST', url: '/v1/signup',
      headers: { 'content-type': 'application/json' },
      payload: { email, name: 'Signup Test' },
    });
    expect(signup.statusCode).toBe(201);
    const apiKey = signup.json().api_key as string;
    // v2 keys are typed; signup issues a live/secret key.
    expect(apiKey.startsWith('mp_live_')).toBe(true);

    // The freshly issued key must authenticate (reaches the domain gate, not 401).
    const probe = await send(apiKey, { from: 'x@unregistered.com', to: 'b@y.com', subject: 's', text: 't' });
    expect(probe.statusCode).not.toBe(401);
    expect(probe.statusCode).toBe(403);
    expect(probe.json().error).toBe('domain_not_registered');
  });
});
