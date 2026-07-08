// E2E: review-queue webhook notifications via eventsQueue.
//
// When an operator approves or rejects a held message, an eventsQueue job is
// enqueued so webhooks and activity feeds can notify the customer. Verifies
// the correct event_type ('queued' for approve, 'failed' for reject).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedAdminSession } from './harness.js';
import { db, eventsQueue } from '@platform/shared';

let app: FastifyInstance;
let operatorToken: string;

beforeAll(async () => {
  app = await buildTestApp();
  operatorToken = (await seedAdminSession('operator')).token;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  // Drain the events queue so each test starts with a clean slate.
  await eventsQueue.drain(true);
});

async function insertHeldMessage(customerId: string): Promise<string> {
  const messageId = `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await db.insertInto('messages').values({
    message_id: messageId,
    customer_id: customerId,
    from_address: 'sender@test.example.com',
    to_address: 'rcpt@example.com',
    subject: 'Held message',
    status: 'held',
    ip_pool: 'transactional',
    attempts: 0,
    body_storage: 'inline',
    metadata: {} as any,
  } as any).execute();
  return messageId;
}

async function insertReviewQueueEntry(customerId: string, messageId: string): Promise<string> {
  const row = await db
    .insertInto('review_queue')
    .values({
      message_id: messageId,
      customer_id: customerId,
      risk_score: 80,
      reasons: ['high_risk_domain'],
    } as any)
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return row.id;
}

describe('review queue notifications', () => {
  it('approve enqueues an eventsQueue job with event_type "queued"', async () => {
    const { customerId } = await seedCustomer();
    const messageId = await insertHeldMessage(customerId);
    const reviewId = await insertReviewQueueEntry(customerId, messageId);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/review-queue/${reviewId}/approve`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().approved).toBe(messageId);

    // Verify a job was added to eventsQueue with the correct data.
    const waiting = await eventsQueue.getWaiting();
    const job = waiting.find((j) => j.data.message_id === messageId);
    expect(job).toBeTruthy();
    expect(job!.data.event_type).toBe('queued');
    expect(job!.data.customer_id).toBe(customerId);
  });

  it('approve updates the message status to "queued" in the DB', async () => {
    const { customerId } = await seedCustomer();
    const messageId = await insertHeldMessage(customerId);
    const reviewId = await insertReviewQueueEntry(customerId, messageId);

    await app.inject({
      method: 'POST',
      url: `/admin/review-queue/${reviewId}/approve`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    const msg = await db.selectFrom('messages').select('status').where('message_id', '=', messageId).executeTakeFirst();
    expect(msg?.status).toBe('queued');

    const entry = await db.selectFrom('review_queue').select('status').where('id', '=', reviewId).executeTakeFirst();
    expect(entry?.status).toBe('approved');
  });

  it('reject enqueues an eventsQueue job with event_type "failed"', async () => {
    const { customerId } = await seedCustomer();
    const messageId = await insertHeldMessage(customerId);
    const reviewId = await insertReviewQueueEntry(customerId, messageId);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/review-queue/${reviewId}/reject`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rejected).toBe(messageId);

    const waiting = await eventsQueue.getWaiting();
    const job = waiting.find((j) => j.data.message_id === messageId);
    expect(job).toBeTruthy();
    expect(job!.data.event_type).toBe('failed');
    expect(job!.data.customer_id).toBe(customerId);
  });

  it('reject updates the message status to "failed" in the DB', async () => {
    const { customerId } = await seedCustomer();
    const messageId = await insertHeldMessage(customerId);
    const reviewId = await insertReviewQueueEntry(customerId, messageId);

    await app.inject({
      method: 'POST',
      url: `/admin/review-queue/${reviewId}/reject`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    const msg = await db.selectFrom('messages').select(['status', 'failure_reason']).where('message_id', '=', messageId).executeTakeFirst();
    expect(msg?.status).toBe('failed');
    expect(msg?.failure_reason).toBe('rejected_in_review');

    const entry = await db.selectFrom('review_queue').select('status').where('id', '=', reviewId).executeTakeFirst();
    expect(entry?.status).toBe('rejected');
  });

  it('approve returns 404 for an already-reviewed item', async () => {
    const { customerId } = await seedCustomer();
    const messageId = await insertHeldMessage(customerId);
    const reviewId = await insertReviewQueueEntry(customerId, messageId);

    // First approve succeeds.
    await app.inject({
      method: 'POST',
      url: `/admin/review-queue/${reviewId}/approve`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    // Second attempt on the same item: status is no longer 'pending'.
    const res = await app.inject({
      method: 'POST',
      url: `/admin/review-queue/${reviewId}/approve`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('requires operator role: support cannot approve', async () => {
    const supportToken = (await seedAdminSession('support')).token;
    const { customerId } = await seedCustomer();
    const messageId = await insertHeldMessage(customerId);
    const reviewId = await insertReviewQueueEntry(customerId, messageId);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/review-queue/${reviewId}/approve`,
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
