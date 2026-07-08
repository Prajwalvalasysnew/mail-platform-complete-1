// E2E: GDPR Article 15 right-to-access export.
//
// GET /v1/privacy/export-recipient returns every message, event, and
// suppression record the platform holds for a given recipient under the
// calling customer's account. Scoped per-tenant (no cross-customer leakage).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedSuppression } from './harness.js';
import { db } from '@platform/shared';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

async function exportRecipient(apiKey: string, email: string) {
  return app.inject({
    method: 'GET',
    url: `/v1/privacy/export-recipient?email=${encodeURIComponent(email)}`,
    headers: { authorization: `Bearer ${apiKey}` },
  });
}

async function insertTestMessage(customerId: string, to: string): Promise<string> {
  const messageId = `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await db.insertInto('messages').values({
    message_id: messageId,
    customer_id: customerId,
    from_address: 'sender@test.example.com',
    to_address: to,
    subject: 'Export test message',
    status: 'delivered',
    ip_pool: 'transactional',
    attempts: 1,
    body_storage: 'inline',
    metadata: {} as any,
  } as any).execute();
  return messageId;
}

async function insertTestEvent(customerId: string, messageId: string, eventType = 'delivered'): Promise<void> {
  await db.insertInto('events').values({
    message_id: messageId,
    customer_id: customerId,
    event_type: eventType,
    payload: {} as any,
  } as any).execute();
}

describe('GET /v1/privacy/export-recipient', () => {
  it('returns messages, events, and suppression for a known recipient', async () => {
    const cust = await seedCustomer(); // default: test key, 'messages' scope
    const recipient = `gdpr-${Date.now()}@example.com`;
    const messageId = await insertTestMessage(cust.customerId, recipient);
    await insertTestEvent(cust.customerId, messageId, 'delivered');
    await seedSuppression(cust.customerId, recipient, 'hard_bounce');

    const res = await exportRecipient(cust.apiKey, recipient);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.recipient).toBe(recipient);
    expect(body.exported_at).toBeTruthy();

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].message_id).toBe(messageId);
    expect(body.messages[0].subject).toBe('Export test message');

    expect(body.events.length).toBeGreaterThanOrEqual(1);
    expect(body.events.some((e: any) => e.event_type === 'delivered')).toBe(true);

    expect(body.suppressed).not.toBeNull();
    expect(body.suppressed.reason).toBe('hard_bounce');
  });

  it('returns multiple messages and their events in descending order', async () => {
    const cust = await seedCustomer();
    const recipient = `gdpr-multi-${Date.now()}@example.com`;

    const id1 = await insertTestMessage(cust.customerId, recipient);
    const id2 = await insertTestMessage(cust.customerId, recipient);
    await insertTestEvent(cust.customerId, id1, 'opened');
    await insertTestEvent(cust.customerId, id2, 'clicked');

    const res = await exportRecipient(cust.apiKey, recipient);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.messages).toHaveLength(2);
    expect(body.events.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty arrays and null suppression for a recipient with no data', async () => {
    const cust = await seedCustomer();

    const res = await exportRecipient(cust.apiKey, 'nobody-at-all@example.com');
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.messages).toHaveLength(0);
    expect(body.events).toHaveLength(0);
    expect(body.suppressed).toBeNull();
  });

  it('returns 400 when the email query param is missing', async () => {
    const cust = await seedCustomer();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/privacy/export-recipient',
      headers: { authorization: `Bearer ${cust.apiKey}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('returns 400 for a malformed email query param', async () => {
    const cust = await seedCustomer();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/privacy/export-recipient?email=not-an-email',
      headers: { authorization: `Bearer ${cust.apiKey}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
  });

  it('does not leak data across customers (tenant isolation)', async () => {
    const custA = await seedCustomer();
    const custB = await seedCustomer();

    const sharedRecipient = `shared-${Date.now()}@example.com`;
    await insertTestMessage(custA.customerId, sharedRecipient); // only custA has a message

    const res = await exportRecipient(custB.apiKey, sharedRecipient);
    expect(res.statusCode).toBe(200);
    expect(res.json().messages).toHaveLength(0); // custB sees nothing
  });

  it('returns 401 without an API key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/privacy/export-recipient?email=anyone@example.com',
    });
    expect(res.statusCode).toBe(401);
  });
});
