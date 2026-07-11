import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSendWorker } from '@platform/worker/send-worker.js';
import { startEventWorker } from '@platform/worker/event-worker.js';
import { startWebhookWorker } from '@platform/worker/webhook-worker.js';
import { db, sendQueue, eventsQueue, webhooksQueue } from '@platform/shared';

const log: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } };
let sendWorker: ReturnType<typeof startSendWorker>;
let eventWorker: ReturnType<typeof startEventWorker>;
let webhookWorker: ReturnType<typeof startWebhookWorker>;

beforeAll(async () => {
  sendWorker = startSendWorker(log);
  eventWorker = startEventWorker(log);
  webhookWorker = startWebhookWorker(log);
  await Promise.all([sendWorker.waitUntilReady(), eventWorker.waitUntilReady(), webhookWorker.waitUntilReady()]);
});
afterAll(async () => { await Promise.all([sendWorker.close(), eventWorker.close(), webhookWorker.close()]); });

async function seedErasedMessage(suffix: string) {
  const customer = await db.insertInto('customers').values({
    email: `privacy-worker-${suffix}@example.com`, name: 'Privacy Worker',
  }).returning('id').executeTakeFirstOrThrow();
  const messageId = `privacy-worker-${suffix}@example.com`;
  await db.insertInto('messages').values({
    message_id: messageId, customer_id: customer.id, from_address: 'sender@example.com',
    to_address: 'erased@example.com', subject: 'must not process', status: 'queued',
    ip_pool: 'transactional', attempts: 0, body_storage: 'inline',
  } as any).execute();
  const request = await db.insertInto('deletion_requests').values({
    customer_id: customer.id, recipient: 'erased@example.com', status: 'completed',
  }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('privacy_message_tombstones').values({
    customer_id: customer.id, message_id: messageId, deletion_request_id: request.id,
  }).execute();
  return { customerId: customer.id, messageId };
}

async function waitForCompletion(queue: any, id: string) {
  const start = Date.now();
  while (Date.now() - start < 6000) {
    const job = await queue.getJob(id);
    if (!job || await job.getState() === 'completed') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job_not_completed:${id}`);
}

describe('privacy tombstone worker gates', () => {
  it('drops stale send jobs before claiming or transport delivery', async () => {
    const seeded = await seedErasedMessage(`send-${Date.now()}`);
    const jobId = `privacyGateSend${Date.now()}`;
    await sendQueue.add('send', { message_id: seeded.messageId, customer_id: seeded.customerId }, { jobId });
    await waitForCompletion(sendQueue, jobId);
    const message = await db.selectFrom('messages').select(['status', 'attempts']).where('message_id', '=', seeded.messageId).executeTakeFirstOrThrow();
    expect(message).toMatchObject({ status: 'queued', attempts: 0 });
    const events = await db.selectFrom('events').select('id').where('message_id', '=', seeded.messageId).execute();
    expect(events).toHaveLength(0);
  });

  it('drops stale event jobs before persistence, usage, or webhook fanout', async () => {
    const seeded = await seedErasedMessage(`event-${Date.now()}`);
    const jobId = `privacyGateEvent${Date.now()}`;
    await eventsQueue.add('event', { message_id: seeded.messageId, customer_id: seeded.customerId, event_type: 'delivered' }, { jobId });
    await waitForCompletion(eventsQueue, jobId);
    expect(await db.selectFrom('events').select('id').where('message_id', '=', seeded.messageId).execute()).toHaveLength(0);
    expect(await db.selectFrom('usage_daily').select('customer_id').where('customer_id', '=', seeded.customerId).execute()).toHaveLength(0);
  });

  it('drops stale webhook jobs before endpoint lookup or network delivery', async () => {
    const seeded = await seedErasedMessage(`webhook-${Date.now()}`);
    const webhook = await db.insertInto('webhooks').values({
      customer_id: seeded.customerId, url: 'http://127.0.0.1/private', secret: 'test-secret', events: ['delivered'], enabled: true,
    }).returning('id').executeTakeFirstOrThrow();
    const jobId = `privacyGateWebhook${Date.now()}`;
    await webhooksQueue.add('deliver', {
      webhook_id: webhook.id, event_id: '1', event_type: 'delivered', payload: { message_id: seeded.messageId },
    }, { jobId });
    await waitForCompletion(webhooksQueue, jobId);
    expect(await db.selectFrom('webhook_delivery_log').select('id').where('webhook_id', '=', webhook.id).execute()).toHaveLength(0);
  });
});
