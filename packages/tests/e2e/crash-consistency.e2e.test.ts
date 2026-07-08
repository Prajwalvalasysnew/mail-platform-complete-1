// Regressions for the two crash-consistency fixes in this pass:
//
// 1. Atomic send-worker claim: the worker used to SELECT a message, check its
//    status in application code, THEN UPDATE it to 'sending'. Two concurrent
//    workers processing a duplicate job (DLQ replay, admin re-enqueue, a
//    stale-recovery re-add) could both pass the check and both call
//    tx.send() — a double delivery. The fix flips 'queued' -> 'sending' with
//    a single conditional UPDATE ... RETURNING so only one caller can ever
//    win the row.
//
// 2. Outbox stale-reclaim: send_outbox rows are marked 'enqueued' *inside* the
//    DB transaction that claims them, before the BullMQ addBulk() call that
//    actually creates the job. A crash in that window strands the row:
//    it's no longer 'pending' (so drainSendOutbox ignores it) and no job
//    exists to process it. reclaimStaleSendOutbox() finds outbox rows stuck
//    'enqueued' past a staleness window whose message never left 'queued',
//    and resets them back to 'pending' so the next drain re-adds them.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, createSendOutboxRows, reclaimStaleSendOutbox, drainSendOutbox } from '@platform/shared';

let customerId: string;

beforeAll(async () => {
  const c = await db
    .insertInto('customers')
    .values({ email: `claim-${Date.now()}@example.com`, name: 'Claim Co' })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  customerId = c.id;
});

async function insertQueuedTestMessage(): Promise<string> {
  const messageId = `claim-${Date.now()}-${Math.random().toString(36).slice(2, 9)}@example.com`;
  await db.insertInto('messages').values({
    message_id: messageId,
    customer_id: customerId,
    from_address: 'sender@claim.example.com',
    to_address: 'rcpt@example.com',
    subject: 'claim test',
    status: 'queued',
    ip_pool: 'transactional',
    attempts: 0,
    body_storage: 'inline',
    html_body: '<p>hi</p>',
    metadata: { _test_mode: true } as any,
  } as any).execute();
  return messageId;
}

describe('send worker atomic claim', () => {
  it('only one of two concurrent claim attempts on the same message wins', async () => {
    const messageId = await insertQueuedTestMessage();

    // Simulate the worker's exact claim statement, fired twice concurrently —
    // this is precisely the race a duplicate BullMQ job would hit.
    const claim = () =>
      db.updateTable('messages')
        .set((eb) => ({ status: 'sending', attempts: eb('attempts', '+', 1), sending_at: new Date() }))
        .where('message_id', '=', messageId)
        .where('status', '=', 'queued')
        .returningAll()
        .executeTakeFirst();

    const [a, b] = await Promise.all([claim(), claim()]);
    const winners = [a, b].filter(Boolean);
    expect(winners.length).toBe(1); // exactly one caller claimed the row

    const row = await db.selectFrom('messages').select(['status', 'attempts']).where('message_id', '=', messageId).executeTakeFirstOrThrow();
    expect(row.status).toBe('sending');
    expect(row.attempts).toBe(1); // not double-incremented
  });

  it('a message already past queued cannot be re-claimed', async () => {
    const messageId = await insertQueuedTestMessage();
    await db.updateTable('messages').set({ status: 'accepted' }).where('message_id', '=', messageId).execute();

    const claimed = await db.updateTable('messages')
      .set((eb) => ({ status: 'sending', attempts: eb('attempts', '+', 1), sending_at: new Date() }))
      .where('message_id', '=', messageId)
      .where('status', '=', 'queued')
      .returningAll()
      .executeTakeFirst();

    expect(claimed).toBeUndefined();
    const row = await db.selectFrom('messages').select(['status']).where('message_id', '=', messageId).executeTakeFirstOrThrow();
    expect(row.status).toBe('accepted'); // untouched
  });
});

describe('send outbox stale reclaim', () => {
  it('resets a stranded enqueued row (crash before Redis add) back to pending', async () => {
    const messageId = await insertQueuedTestMessage(); // status stays 'queued' — never picked up

    await createSendOutboxRows([{ message_id: messageId, customer_id: customerId, priority: 5 }]);
    // Simulate the crash window: DB claim committed as 'enqueued', but the
    // BullMQ addBulk() that should follow never happened, and enough time
    // has passed to be considered stale.
    await db.updateTable('send_outbox')
      .set({ status: 'enqueued', enqueued_at: new Date(Date.now() - 20 * 60_000) })
      .where('message_id', '=', messageId)
      .execute();

    const reclaimed = await reclaimStaleSendOutbox(10);
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    const row = await db.selectFrom('send_outbox').select(['status']).where('message_id', '=', messageId).executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');

    // And it's drainable again afterward.
    const drained = await drainSendOutbox({ messageIds: [messageId] });
    expect(drained).toBeGreaterThanOrEqual(1);
  });

  it('does NOT reclaim an enqueued row whose message already left queued (legitimately in flight)', async () => {
    const messageId = await insertQueuedTestMessage();
    await createSendOutboxRows([{ message_id: messageId, customer_id: customerId, priority: 5 }]);
    await db.updateTable('send_outbox')
      .set({ status: 'enqueued', enqueued_at: new Date(Date.now() - 20 * 60_000) })
      .where('message_id', '=', messageId)
      .execute();
    // The worker picked it up for real — no crash, just in progress.
    await db.updateTable('messages').set({ status: 'sending' }).where('message_id', '=', messageId).execute();

    await reclaimStaleSendOutbox(10);

    const row = await db.selectFrom('send_outbox').select(['status']).where('message_id', '=', messageId).executeTakeFirstOrThrow();
    expect(row.status).toBe('enqueued'); // left alone — it's legitimately in flight
  });

  it('does NOT reclaim a recently enqueued row (within the staleness window)', async () => {
    const messageId = await insertQueuedTestMessage();
    await createSendOutboxRows([{ message_id: messageId, customer_id: customerId, priority: 5 }]);
    // enqueued_at defaults to "now" via createSendOutboxRows + the drainer;
    // simulate that directly since we're not calling the real drainer here.
    await db.updateTable('send_outbox')
      .set({ status: 'enqueued', enqueued_at: new Date() })
      .where('message_id', '=', messageId)
      .execute();

    await reclaimStaleSendOutbox(10);

    const row = await db.selectFrom('send_outbox').select(['status']).where('message_id', '=', messageId).executeTakeFirstOrThrow();
    expect(row.status).toBe('enqueued'); // too recent to reclaim
  });
});
