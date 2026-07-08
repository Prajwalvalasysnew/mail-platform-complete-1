// Regressions for the webhook fixes found while auditing SendGrid-class
// parity:
//
// 1. retry-failures payload bug: the endpoint used to re-queue failed
//    deliveries with a hardcoded `payload: {}` instead of the original event
//    data — a "retry" delivered a useless empty JSON body to the customer's
//    endpoint. It now reconstructs the exact payload from the source `events`
//    row.
// 2. Dual-secret rotation: rotating a webhook secret used to be an instant
//    cutover (old secret discarded immediately), so any delivery in flight —
//    or any customer who hadn't redeployed their verifier yet — would fail
//    signature verification. It now keeps the old secret valid as
//    `previous_secret` for a grace window.
// 3. Backoff/retry window: webhook deliveries now retry for ~20 hours
//    (capped exponential backoff, 12 attempts) instead of ~31 minutes.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './harness.js';
import {
  db,
  seedCustomer,
  createWebhook,
  webhooksQueue,
  webhookBackoffStrategy,
  rotateWebhookSecret,
  clearExpiredWebhookRotationSecrets,
  type SeededCustomer,
} from '@platform/shared';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  await webhooksQueue.drain(true);
});

function apiReq(apiKey: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as any,
    url,
    headers: { authorization: `Bearer ${apiKey}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  });
}

async function seedFailedDelivery(cust: SeededCustomer, webhookId: string, eventPayload: Record<string, unknown>) {
  const event = await db
    .insertInto('events')
    .values({
      message_id: `retry-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      customer_id: cust.customerId,
      event_type: 'delivered',
      payload: eventPayload,
    } as any)
    .returning(['id'])
    .executeTakeFirstOrThrow();

  await db.insertInto('webhook_delivery_log').values({
    webhook_id: webhookId,
    event_id: event.id,
    event_type: 'delivered',
    attempt: 1,
    status_code: 500,
    outcome: 'failure',
    duration_ms: 42,
    error: 'HTTP 500',
  } as any).execute();

  return event.id;
}

describe('webhook retry-failures payload reconstruction', () => {
  it('re-queues the ORIGINAL event payload, not an empty object', async () => {
    const cust = await seedCustomer({ keyType: 'test' });
    const wh = await createWebhook({ customerId: cust.customerId, url: 'https://93.184.216.34/hook', events: ['delivered'] });

    const eventId = await seedFailedDelivery(cust, wh.id, { to: 'recipient@example.com', src_ip: '10.0.0.5' });

    const res = await apiReq(cust.apiKey, 'POST', `/v1/webhooks/${wh.id}/retry-failures`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().retried).toBe(1);
    expect(res.json().skipped_missing_event).toBe(0);

    const jobs = await webhooksQueue.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => j.data.webhook_id === wh.id);
    expect(job).toBeTruthy();
    // THE FIX: payload must contain the real event data, not {}.
    expect(job!.data.payload).toMatchObject({
      event_type: 'delivered',
      to: 'recipient@example.com',
      src_ip: '10.0.0.5',
    });
    expect(job!.data.payload.message_id).toBeTruthy();
    expect(job!.data.event_id).toBe(eventId);
  });

  it('skips (does not fabricate a payload for) a delivery whose source event no longer exists', async () => {
    const cust = await seedCustomer({ keyType: 'test' });
    const wh = await createWebhook({ customerId: cust.customerId, url: 'https://93.184.216.34/hook', events: ['delivered'] });

    // Simulate retention purging the source event: webhook_delivery_log.event_id
    // has ON DELETE SET NULL, so a purged event leaves the delivery row with a
    // NULL event_id rather than a dangling reference.
    const eventId = await seedFailedDelivery(cust, wh.id, { to: 'purged@example.com' });
    await db.deleteFrom('events').where('id', '=', eventId).execute();

    const res = await apiReq(cust.apiKey, 'POST', `/v1/webhooks/${wh.id}/retry-failures`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().retried).toBe(0);
    expect(res.json().skipped_missing_event).toBe(1);
  });

  it('only retries failures belonging to the caller\'s own webhook (tenant isolation)', async () => {
    const cust = await seedCustomer({ keyType: 'test' });
    const other = await seedCustomer({ keyType: 'test' });
    const foreignWh = await createWebhook({ customerId: other.customerId, url: 'https://93.184.216.34/hook', events: ['delivered'] });

    const res = await apiReq(cust.apiKey, 'POST', `/v1/webhooks/${foreignWh.id}/retry-failures`, {});
    expect(res.statusCode).toBe(404);
  });
});

describe('webhook dual-secret rotation grace window', () => {
  it('keeps the old secret valid as previous_secret after rotation', async () => {
    const cust = await seedCustomer({ keyType: 'test' });
    const wh = await createWebhook({ customerId: cust.customerId, url: 'https://93.184.216.34/hook', events: ['delivered'] });
    const originalSecret = wh.secret;

    const rotated = await rotateWebhookSecret(cust.customerId, wh.id);
    expect(rotated).toBeTruthy();
    expect(rotated!.secret).not.toBe(originalSecret);
    // THE FIX: old secret is preserved, not discarded.
    expect(rotated!.previous_secret).toBe(originalSecret);
    expect(rotated!.previous_secret_expires_at).toBeTruthy();
    expect(new Date(rotated!.previous_secret_expires_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it('rotating twice replaces previous_secret with the most recently retired secret', async () => {
    const cust = await seedCustomer({ keyType: 'test' });
    const wh = await createWebhook({ customerId: cust.customerId, url: 'https://93.184.216.34/hook', events: ['delivered'] });
    const secretA = wh.secret;

    const afterFirst = await rotateWebhookSecret(cust.customerId, wh.id);
    const secretB = afterFirst!.secret;
    expect(afterFirst!.previous_secret).toBe(secretA);

    const afterSecond = await rotateWebhookSecret(cust.customerId, wh.id);
    expect(afterSecond!.secret).not.toBe(secretB);
    expect(afterSecond!.previous_secret).toBe(secretB); // secretA has fully aged out
  });

  it('clearExpiredWebhookRotationSecrets nulls out only expired grace windows', async () => {
    const cust = await seedCustomer({ keyType: 'test' });
    const wh = await createWebhook({ customerId: cust.customerId, url: 'https://93.184.216.34/hook', events: ['delivered'] });
    await rotateWebhookSecret(cust.customerId, wh.id);

    // Force the grace window into the past to simulate expiry.
    await db.updateTable('webhooks')
      .set({ previous_secret_expires_at: new Date(Date.now() - 60_000) })
      .where('id', '=', wh.id)
      .execute();

    const cleared = await clearExpiredWebhookRotationSecrets();
    expect(cleared).toBeGreaterThanOrEqual(1);

    const row = await db.selectFrom('webhooks').select(['previous_secret', 'previous_secret_expires_at']).where('id', '=', wh.id).executeTakeFirstOrThrow();
    expect(row.previous_secret).toBeNull();
    expect(row.previous_secret_expires_at).toBeNull();
  });
});

describe('webhook retry backoff window', () => {
  it('uses capped exponential backoff reaching hours, not minutes, of total retry coverage', () => {
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 12; attempt++) {
      delays.push(webhookBackoffStrategy(attempt) as number);
    }
    const totalMs = delays.reduce((a, b) => a + b, 0);
    // Old behavior: 5 attempts, ~31 minutes total. New behavior should be
    // roughly a day of retry coverage (SendGrid-class endurance).
    expect(totalMs).toBeGreaterThan(18 * 3600_000); // > 18 hours
    // And it must actually be capped, not unbounded exponential growth.
    expect(Math.max(...delays)).toBeLessThanOrEqual(4 * 3600_000);
  });
});
