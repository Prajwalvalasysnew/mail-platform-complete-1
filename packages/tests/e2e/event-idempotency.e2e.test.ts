// Regression: the event worker must be idempotent under job retry. The BullMQ
// job id is used as the event's idempotency key, so re-processing the same job
// (a retry after a partial failure) must NOT insert a duplicate event row or
// double-count usage_daily. Distinct jobs must still record distinctly.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startEventWorker } from '@platform/worker/event-worker.js';
import { db, eventsQueue } from '@platform/shared';

const log: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } };

let worker: ReturnType<typeof startEventWorker>;
let customerId: string;
let messageId: string;

beforeAll(async () => {
  worker = startEventWorker(log);
  await worker.waitUntilReady();
  const c = await db.insertInto('customers').values({ email: `evt-idem-${Date.now()}@example.com`, name: 'Evt Idem' }).returning(['id']).executeTakeFirstOrThrow();
  customerId = c.id;
  messageId = `evt-idem-${Date.now()}@example.com`;
  await db.insertInto('messages').values({
    message_id: messageId, customer_id: customerId,
    from_address: 's@evt.example.com', to_address: 'r@example.com', subject: 's',
    status: 'accepted', ip_pool: 'transactional', attempts: 1, body_storage: 'inline',
  } as any).execute();
});

afterAll(async () => {
  await worker.close();
});

// Enqueue a delivered event carrying an explicit idempotency key. Each enqueue
// gets a UNIQUE BullMQ job id so BullMQ actually processes both jobs — the
// dedup we're testing is the worker's ON CONFLICT on event_key, not BullMQ's
// own job-id dedup.
async function enqueueDelivered(eventKey: string): Promise<void> {
  await eventsQueue.add(
    'delivered',
    { message_id: messageId, customer_id: customerId, event_type: 'delivered', event_key: eventKey },
    { jobId: `bull-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }
  );
}

async function waitForDelivered(target: number, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await deliveredCount()) >= target) return;
    await new Promise((r) => setTimeout(r, 80));
  }
}

async function deliveredCount(): Promise<number> {
  const row = await db.selectFrom('events').select((eb) => eb.fn.countAll<number>().as('c')).where('message_id', '=', messageId).where('event_type', '=', 'delivered').executeTakeFirstOrThrow();
  return Number(row.c);
}

async function usageDelivered(): Promise<number> {
  const row = await db.selectFrom('usage_daily').select(['delivered']).where('customer_id', '=', customerId).executeTakeFirst();
  return Number(row?.delivered ?? 0);
}

describe('event worker idempotency', () => {
  it('processing the same event_key twice records the event and usage exactly once', async () => {
    const key = `idem-${Date.now()}`;
    await enqueueDelivered(key);
    await waitForDelivered(1);
    expect(await deliveredCount()).toBe(1);
    expect(await usageDelivered()).toBe(1);

    // Re-enqueue with the SAME event_key (a distinct BullMQ job) — simulating a
    // retry / duplicate producer emit. The ON CONFLICT (event_key) dedupes it.
    await enqueueDelivered(key);
    await new Promise((r) => setTimeout(r, 1500)); // settle
    expect(await deliveredCount()).toBe(1); // still one event row
    expect(await usageDelivered()).toBe(1); // usage NOT double-counted
  });

  it('distinct event_keys record distinct events and increment usage', async () => {
    const before = await usageDelivered();
    const beforeCount = await deliveredCount();
    await enqueueDelivered(`distinct-a-${Date.now()}`);
    await enqueueDelivered(`distinct-b-${Date.now()}`);
    await waitForDelivered(beforeCount + 2);
    expect(await deliveredCount()).toBe(beforeCount + 2);
    expect(await usageDelivered()).toBe(before + 2);
  });
});
