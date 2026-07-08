import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './harness.js';
import {
  deadLetter,
  getDeadLetter,
  purgeAllDeadLetters,
  seedAdminSession,
  sendQueue,
  eventsQueue,
  webhooksQueue,
} from '@platform/shared';

let app: FastifyInstance;
let operatorToken: string;
let supportToken: string;

beforeAll(async () => {
  app = await buildTestApp();
  operatorToken = (await seedAdminSession('operator')).token;
  supportToken = (await seedAdminSession('support')).token;
});

afterAll(async () => {
  await purgeAllDeadLetters();
  await app.close();
});

afterEach(async () => {
  await purgeAllDeadLetters();
  await sendQueue.drain(true);
  await eventsQueue.drain(true);
  await webhooksQueue.drain(true);
});

function adminReq(method: string, url: string, payload?: unknown, token = operatorToken) {
  return app.inject({
    method: method as any,
    url,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  });
}

async function seedDlq(sourceQueue = 'send', data: Record<string, unknown> = {}) {
  await deadLetter(
    sourceQueue,
    {
      id: `original-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      data: {
        message_id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        customer_id: '00000000-0000-0000-0000-000000000001',
        ...data,
      },
      attemptsMade: 5,
    },
    'exhausted retries',
  );
  const listed = await adminReq('GET', '/admin/dlq');
  expect(listed.statusCode).toBe(200);
  const job = listed.json().jobs[0];
  expect(job).toBeTruthy();
  return job as { id: string; source_queue: string; payload: any };
}

describe('admin dead-letter queue', () => {
  it('lists dead-letter jobs and returns full detail', async () => {
    const job = await seedDlq('send', { nested: { value: 'visible-in-detail' } });

    const list = await adminReq('GET', '/admin/dlq?limit=10&offset=0');
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBeGreaterThanOrEqual(1);
    expect(list.json().jobs[0]).toMatchObject({
      id: job.id,
      source_queue: 'send',
      failed_reason: 'exhausted retries',
      attempts_made: 5,
    });

    const detail = await adminReq('GET', `/admin/dlq/${job.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().job.payload.nested.value).toBe('visible-in-detail');
    expect(detail.json().job.state).toBeTruthy();
  });

  it('replays a dead-letter job to its original queue and removes it from DLQ', async () => {
    const job = await seedDlq('send', { priority: 7 });

    const replay = await adminReq('POST', `/admin/dlq/${job.id}/replay`);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toMatchObject({ replayed: true, source_queue: 'send' });
    expect(replay.json().new_job_id).toBeTruthy();

    expect(await getDeadLetter(job.id)).toBeNull();
    const replayed = await sendQueue.getJob(replay.json().new_job_id);
    expect(replayed?.data.message_id).toBe(job.payload.message_id);
    expect(replayed?.data.priority).toBe(7);
  });

  it('deletes a single DLQ entry and purges all remaining entries with confirmation', async () => {
    const one = await seedDlq('events', { event_type: 'delivered' });
    const del = await adminReq('DELETE', `/admin/dlq/${one.id}`);
    expect(del.statusCode).toBe(200);
    expect(await getDeadLetter(one.id)).toBeNull();

    await seedDlq('send');
    await seedDlq('webhooks', { webhook_id: 'wh_123', event_id: 1, event_type: 'delivered', payload: {} });

    const rejected = await adminReq('POST', '/admin/dlq/purge', { confirm: false });
    expect(rejected.statusCode).toBe(400);

    const purge = await adminReq('POST', '/admin/dlq/purge', { confirm: true });
    expect(purge.statusCode).toBe(200);
    expect(purge.json().purged).toBeGreaterThanOrEqual(2);

    const list = await adminReq('GET', '/admin/dlq');
    expect(list.json().total).toBe(0);
  });

  it('enforces admin operator authorization', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/admin/dlq' });
    expect(noAuth.statusCode).toBe(401);

    const support = await adminReq('GET', '/admin/dlq', undefined, supportToken);
    expect(support.statusCode).toBe(403);
    expect(support.json().error).toBe('insufficient_role');
  });
});
