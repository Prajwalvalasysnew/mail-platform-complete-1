// Regression: a send job that fails must never strand the message at
// 'sending'. Two failure modes are exercised against the real worker:
//   1. transport failure (tx.send throws)
//   2. preparation failure (buildReturnPath throws because VERP_SECRET is unset)
// Both must end at a terminal 'failed' status — never stuck at 'sending' (the
// original bug: prep ran outside the try, so a prep error threw with the row
// already pinned to 'sending', and every retry then hit the "not queued" guard).
//
// Jobs are enqueued with attempts:1 so retry exhaustion is immediate (the
// default 5-attempt exponential backoff would take ~15 minutes).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { db, getSandboxTransport, sendQueue } from '@platform/shared';

let h: Harness;
let customerId: string;

beforeAll(async () => {
  h = await startHarness();
  const c = await db
    .insertInto('customers')
    .values({ email: `strand-${Date.now()}@example.com`, name: 'Strand Co' })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  customerId = c.id;
});

afterAll(async () => {
  await h.close();
});

async function insertQueuedTestMessage(): Promise<string> {
  const messageId = `strand-${Date.now()}-${Math.random().toString(36).slice(2, 9)}@example.com`;
  await db.insertInto('messages').values({
    message_id: messageId,
    customer_id: customerId,
    from_address: 'sender@strand.example.com',
    to_address: 'rcpt@example.com',
    subject: 'strand test',
    status: 'queued',
    ip_pool: 'transactional',
    attempts: 0,
    body_storage: 'inline',
    html_body: '<p>hi</p>',
    metadata: { _test_mode: true } as any,
  } as any).execute();
  return messageId;
}

async function waitForTerminal(messageId: string, timeoutMs = 8000): Promise<string> {
  const start = Date.now();
  let last = 'unknown';
  while (Date.now() - start < timeoutMs) {
    const row = await db.selectFrom('messages').select(['status']).where('message_id', '=', messageId).executeTakeFirst();
    last = row?.status ?? 'missing';
    if (last === 'failed' || last === 'accepted') return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

describe('send worker stranding regression', () => {
  it('marks a message failed (not stuck at sending) when the transport throws', async () => {
    const sandbox = getSandboxTransport();
    const original = sandbox.send.bind(sandbox);
    (sandbox as any).send = async () => {
      throw new Error('simulated transient transport failure');
    };
    try {
      const messageId = await insertQueuedTestMessage();
      await sendQueue.add('send', { message_id: messageId, customer_id: customerId }, { attempts: 1 });
      const status = await waitForTerminal(messageId);
      expect(status).toBe('failed'); // terminal — never left at 'sending'
      const row = await db.selectFrom('messages').select(['status', 'failure_reason']).where('message_id', '=', messageId).executeTakeFirstOrThrow();
      expect(row.status).toBe('failed');
      expect(row.failure_reason).toBeTruthy();
    } finally {
      (sandbox as any).send = original;
    }
  });

  it('records a failed event on exhaustion', async () => {
    const sandbox = getSandboxTransport();
    const original = sandbox.send.bind(sandbox);
    (sandbox as any).send = async () => { throw new Error('boom'); };
    try {
      const messageId = await insertQueuedTestMessage();
      await sendQueue.add('send', { message_id: messageId, customer_id: customerId }, { attempts: 1 });
      await waitForTerminal(messageId);
      const events = await db.selectFrom('events').select(['event_type']).where('message_id', '=', messageId).execute();
      expect(events.some((e) => e.event_type === 'failed')).toBe(true);
    } finally {
      (sandbox as any).send = original;
    }
  });

  it('does not strand at sending when message preparation throws', async () => {
    // Force buildReturnPath to throw by removing VERP_SECRET. This happens
    // during preparation, before tx.send — exactly the path that used to leave
    // the row pinned at 'sending'.
    const messageId = await insertQueuedTestMessage();
    const savedSecret = process.env.VERP_SECRET;
    delete process.env.VERP_SECRET;
    try {
      await sendQueue.add('send', { message_id: messageId, customer_id: customerId }, { attempts: 1 });
      const status = await waitForTerminal(messageId);
      expect(status).toBe('failed');
      expect(status).not.toBe('sending');
    } finally {
      if (savedSecret !== undefined) process.env.VERP_SECRET = savedSecret;
    }
  });
});
