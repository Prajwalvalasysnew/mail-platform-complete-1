// Regression: the event worker must not let an out-of-order / duplicate provider
// event DOWNGRADE a message's status. Provider webhooks can arrive late or
// reordered (a delayed `delivered` after a `hard_bounce`, a stray `accepted`
// after `delivered`). Status must only ever advance — otherwise reporting and
// suppression are corrupted. Timestamps are still recorded regardless of order.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startEventWorker } from '@platform/worker/event-worker.js';
import { db, eventsQueue } from '@platform/shared';

const log: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } };

let worker: ReturnType<typeof startEventWorker>;
let customerId: string;

beforeAll(async () => {
  worker = startEventWorker(log);
  await worker.waitUntilReady();
  const c = await db
    .insertInto('customers')
    .values({ email: `evt-prec-${Date.now()}@example.com`, name: 'Evt Prec' })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  customerId = c.id;
});

afterAll(async () => {
  await worker.close();
});

async function seedMessage(status: string): Promise<string> {
  const messageId = `prec-${status}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  await db.insertInto('messages').values({
    message_id: messageId, customer_id: customerId,
    from_address: 's@evt.example.com', to_address: 'r@example.com', subject: 's',
    status, ip_pool: 'transactional', attempts: 1, body_storage: 'inline',
  } as any).execute();
  return messageId;
}

async function enqueue(messageId: string, eventType: string): Promise<void> {
  await eventsQueue.add(
    eventType,
    { message_id: messageId, customer_id: customerId, event_type: eventType, event_key: `prec-${eventType}-${messageId}` },
    { jobId: `bull-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
  );
}

async function statusOf(messageId: string): Promise<string | undefined> {
  const row = await db.selectFrom('messages').select('status').where('message_id', '=', messageId).executeTakeFirst();
  return row?.status as string | undefined;
}

async function waitForStatus(messageId: string, predicate: (s: string | undefined) => boolean, timeoutMs = 6000): Promise<string | undefined> {
  const start = Date.now();
  let last: string | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await statusOf(messageId);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 80));
  }
  return last;
}

describe('event worker status precedence', () => {
  it('a late "delivered" does NOT overwrite a hard_bounced status', async () => {
    const messageId = await seedMessage('accepted');

    // Hard bounce first → status becomes hard_bounced.
    await enqueue(messageId, 'hard_bounce');
    const bounced = await waitForStatus(messageId, (s) => s === 'hard_bounced');
    expect(bounced).toBe('hard_bounced');

    // A delayed delivery webhook arrives afterwards. It must NOT downgrade.
    await enqueue(messageId, 'delivered');
    await new Promise((r) => setTimeout(r, 1500)); // give the worker time to (not) change it
    expect(await statusOf(messageId)).toBe('hard_bounced');
  });

  it('a normal forward transition still advances (queued → delivered)', async () => {
    const messageId = await seedMessage('queued');
    await enqueue(messageId, 'delivered');
    const s = await waitForStatus(messageId, (x) => x === 'delivered');
    expect(s).toBe('delivered');
  });

  it('a duplicate lower-precedence event after delivered is ignored for status', async () => {
    const messageId = await seedMessage('delivered');
    // soft_bounce ranks below delivered — must not pull the status back.
    await enqueue(messageId, 'soft_bounce');
    await new Promise((r) => setTimeout(r, 1500));
    expect(await statusOf(messageId)).toBe('delivered');
  });

  it('records the delivered_at timestamp even when status is held by a higher state', async () => {
    const messageId = await seedMessage('accepted');
    await enqueue(messageId, 'hard_bounce');
    await waitForStatus(messageId, (s) => s === 'hard_bounced');
    await enqueue(messageId, 'delivered');
    await new Promise((r) => setTimeout(r, 1500));
    // Status stays terminal, but the delivered_at timestamp is still recorded
    // (timestamps are order-independent; only `status` is precedence-guarded).
    const row = await db
      .selectFrom('messages')
      .select(['status', 'delivered_at'])
      .where('message_id', '=', messageId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('hard_bounced');
    expect(row.delivered_at).not.toBeNull();
  });
});
