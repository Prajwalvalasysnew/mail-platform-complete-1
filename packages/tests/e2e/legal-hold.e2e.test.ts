// E2E (gap analysis #19): a legal hold must BLOCK the erasure endpoint. Proves
// the full HTTP round-trip — POST /v1/privacy/delete-recipient returns 409
// legal_hold_active while a hold is active, and succeeds once released. This is
// the report's acceptance criterion end-to-end, not just at the service layer.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain } from './harness.js';
import { db } from '@platform/shared';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

async function sendTo(apiKey: string, from: string, to: string) {
  const res = await app.inject({
    method: 'POST', url: '/v1/send',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    payload: { from, to, subject: 'hi', html: '<p>body</p>', text: 'body' },
  });
  expect(res.statusCode).toBe(202);
}

describe('legal hold blocks erasure (e2e)', () => {
  it('returns 409 while held, then succeeds after the hold is released', async () => {
    const cust = await seedCustomer({ scopes: ['send', 'messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const victim = `held-${Date.now()}@example.com`;
    await sendTo(cust.apiKey, `s@${domain}`, victim);

    // Place a recipient-scoped legal hold via the API.
    const place = await app.inject({
      method: 'POST', url: '/v1/privacy/legal-holds',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { scope: victim, reason: 'pending litigation' },
    });
    expect(place.statusCode).toBe(201);
    const holdId = place.json().hold.id as string;

    // Erasure must be BLOCKED.
    const blocked = await app.inject({
      method: 'POST', url: '/v1/privacy/delete-recipient',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { recipient: victim },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('legal_hold_active');
    expect(blocked.json().holds[0].reason).toBe('pending litigation');

    // The message row must still exist (nothing was destroyed).
    const still = await db.selectFrom('messages').select(['message_id'])
      .where('customer_id', '=', cust.customerId).where('to_address', '=', victim).executeTakeFirst();
    expect(still).toBeTruthy();

    // Release the hold, then erasure succeeds.
    const release = await app.inject({
      method: 'POST', url: `/v1/privacy/legal-holds/${holdId}/release`,
      headers: { authorization: `Bearer ${cust.apiKey}` },
    });
    expect(release.statusCode).toBe(200);

    const ok = await app.inject({
      method: 'POST', url: '/v1/privacy/delete-recipient',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { recipient: victim },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('completed');
    expect(ok.json().messages_deleted).toBeGreaterThanOrEqual(1);
  });

  it('a tenant-wide hold blocks erasure for any recipient', async () => {
    const cust = await seedCustomer({ scopes: ['send', 'messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const r = `anyone-${Date.now()}@example.com`;
    await sendTo(cust.apiKey, `s@${domain}`, r);

    await app.inject({
      method: 'POST', url: '/v1/privacy/legal-holds',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { scope: 'customer', reason: 'org-wide freeze' },
    });

    const blocked = await app.inject({
      method: 'POST', url: '/v1/privacy/delete-recipient',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { recipient: r },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('legal_hold_active');
  });
});
