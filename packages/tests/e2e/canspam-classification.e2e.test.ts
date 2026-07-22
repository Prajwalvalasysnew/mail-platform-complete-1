// E2E: CANSPAM-01 (compliance implementation plan) — authoritative message
// classification.
//
// Every message carries a legal message_class. Default is 'commercial' (the
// safe class: full CAN-SPAM treatment). Declaring 'transactional' or
// 'relationship' requires the 'classify' API-key scope, is rejected loudly
// otherwise, and accepted declarations leave an audit trail.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain } from './harness.js';
import { db } from '@platform/shared';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

const headers = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });

describe('CAN-SPAM message classification', () => {
  it('defaults every message to commercial', async () => {
    const cust = await seedCustomer({ scopes: ['send', 'messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = `default-class-${Date.now()}@example.com`;
    const res = await app.inject({
      method: 'POST', url: '/v1/send', headers: headers(cust.apiKey),
      payload: { from: `s@${domain}`, to, subject: 'newsletter', text: 'hello' },
    });
    expect(res.statusCode).toBe(202);
    const row = await db.selectFrom('messages').select('message_class')
      .where('customer_id', '=', cust.customerId).where('to_address', '=', to).executeTakeFirstOrThrow();
    expect(row.message_class).toBe('commercial');
  });

  it('rejects a transactional declaration without the classify scope', async () => {
    const cust = await seedCustomer({ scopes: ['send', 'messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const res = await app.inject({
      method: 'POST', url: '/v1/send', headers: headers(cust.apiKey),
      payload: { from: `s@${domain}`, to: 'x@example.com', subject: 'otp', text: '123456', message_class: 'transactional' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('classification_not_authorized');
  });

  it('accepts and audits a transactional declaration with the classify scope', async () => {
    const cust = await seedCustomer({ scopes: ['send', 'messages', 'classify'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = `txn-class-${Date.now()}@example.com`;
    const res = await app.inject({
      method: 'POST', url: '/v1/send', headers: headers(cust.apiKey),
      payload: { from: `s@${domain}`, to, subject: 'Your receipt', text: 'order 1', message_class: 'transactional' },
    });
    expect(res.statusCode).toBe(202);

    const row = await db.selectFrom('messages').select(['message_id', 'message_class'])
      .where('customer_id', '=', cust.customerId).where('to_address', '=', to).executeTakeFirstOrThrow();
    expect(row.message_class).toBe('transactional');

    // Audit trail: the classification decision is recorded with the key that made it.
    const audit = await db.selectFrom('audit_log').select(['action', 'resource', 'metadata'])
      .where('customer_id', '=', cust.customerId)
      .where('action', '=', 'message_class_declared')
      .orderBy('occurred_at', 'desc').executeTakeFirstOrThrow();
    expect(audit.resource).toBe('transactional');
    expect((audit.metadata as any).message_ids).toContain(row.message_id);
  });

  it('enforces classification per entry in batch sends', async () => {
    const cust = await seedCustomer({ scopes: ['send', 'messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const res = await app.inject({
      method: 'POST', url: '/v1/send/batch', headers: headers(cust.apiKey),
      payload: {
        messages: [
          { from: `s@${domain}`, to: `batch-ok-${Date.now()}@example.com`, subject: 'a', text: 'a' },
          { from: `s@${domain}`, to: `batch-bad-${Date.now()}@example.com`, subject: 'b', text: 'b', message_class: 'relationship' },
        ],
      },
    });
    expect([200, 202]).toContain(res.statusCode);
    const results = res.json().results;
    expect(results[0].accepted).toBe(true);
    expect(results[1].accepted).toBe(false);
    expect(results[1].error).toBe('classification_not_authorized');
  });

  it('exposes message_class on the message detail endpoint', async () => {
    const cust = await seedCustomer({ scopes: ['send', 'messages', 'classify'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = `detail-class-${Date.now()}@example.com`;
    const sent = await app.inject({
      method: 'POST', url: '/v1/send', headers: headers(cust.apiKey),
      payload: { from: `s@${domain}`, to, subject: 'r', text: 'r', message_class: 'relationship' },
    });
    expect(sent.statusCode).toBe(202);
    const messageId = sent.json().message_ids[0];
    const detail = await app.inject({
      method: 'GET', url: `/v1/messages/${encodeURIComponent(messageId)}`, headers: headers(cust.apiKey),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().message.message_class).toBe('relationship');
  });
});
