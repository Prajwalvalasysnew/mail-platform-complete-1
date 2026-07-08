import { beforeEach, describe, expect, it } from 'vitest';
import {
  createSendOutboxRows,
  drainSendOutbox,
  sendQueue,
  seedCustomer,
  seedQueuedMessage,
  getSendOutboxRow,
  countSendOutboxRows,
  sendOutboxJobId,
} from '@platform/shared';

describe('send outbox', () => {
  beforeEach(async () => {
    await sendQueue.drain(true);
  });

  it('persists pending rows and drains them into BullMQ', async () => {
    const c = await seedCustomer();
    const messageId = await seedQueuedMessage(c.customerId);

    await createSendOutboxRows([{ message_id: messageId, customer_id: c.customerId, priority: 5 }]);
    expect((await getSendOutboxRow(messageId))?.status).toBe('pending');

    const drained = await drainSendOutbox({ messageIds: [messageId] });
    expect(drained).toBe(1);

    const row = await getSendOutboxRow(messageId);
    expect(row?.status).toBe('enqueued');
    expect(Number(row?.attempts)).toBe(1);
    expect(row?.enqueued_at).toBeTruthy();

    const job = await sendQueue.getJob(sendOutboxJobId(messageId));
    expect(job?.data.message_id).toBe(messageId);
  });

  it('does not drain rows scheduled for the future', async () => {
    const c = await seedCustomer();
    const future = new Date(Date.now() + 3600_000);
    const messageId = await seedQueuedMessage(c.customerId, { sendAt: future });

    await createSendOutboxRows([{ message_id: messageId, customer_id: c.customerId, priority: 5, run_at: future }]);
    const drained = await drainSendOutbox({ messageIds: [messageId] });

    expect(drained).toBe(0);
    expect((await getSendOutboxRow(messageId))?.status).toBe('pending');
  });

  it('can be drained concurrently without double-enqueueing rows', async () => {
    const c = await seedCustomer();
    const messageIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      messageIds.push(await seedQueuedMessage(c.customerId));
    }

    await createSendOutboxRows(messageIds.map((message_id) => ({ message_id, customer_id: c.customerId, priority: 5 })));

    const results = await Promise.all([
      drainSendOutbox({ messageIds, limit: 3 }),
      drainSendOutbox({ messageIds, limit: 3 }),
    ]);

    expect(results.reduce((a, b) => a + b, 0)).toBe(6);
    expect(await countSendOutboxRows(messageIds, 'enqueued')).toBe(6);

    const jobs = await Promise.all(messageIds.map((id) => sendQueue.getJob(sendOutboxJobId(id))));
    expect(jobs.map((j) => j?.data.message_id).sort()).toEqual([...messageIds].sort());
  });
});
