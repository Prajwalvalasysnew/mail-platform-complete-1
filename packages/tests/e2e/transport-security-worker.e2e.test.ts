// E2E: BASE-08 enforcement in the real send worker.
//
// transport-security.e2e.test.ts covers the verdict logic; this covers the
// thing that actually matters — that the send worker REFUSES to deliver when
// the verdict says the recipient domain accepts mail in the clear, and that a
// tenant without tls_required is unaffected.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startSendWorker } from '@platform/worker/send-worker.js';
import {
  db,
  sendQueue,
  recordDeliveryTlsOutcome,
  recipientDomain,
  generateMessageId,
} from '@platform/shared';

const log: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return log; } };
let sendWorker: ReturnType<typeof startSendWorker>;
const domains: string[] = [];

beforeAll(async () => {
  sendWorker = startSendWorker(log);
  await sendWorker.waitUntilReady();
});
afterAll(async () => {
  await sendWorker.close();
  if (domains.length) {
    await db.deleteFrom('recipient_domain_tls').where('domain', 'in', domains).execute();
  }
});

async function waitForCompletion(queue: any, id: string) {
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const job = await queue.getJob(id);
    if (!job) return;
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job_not_settled:${id}`);
}

/** A live-mode message from a TLS-required (or not) tenant to `to`. */
async function seedMessage(opts: { tlsRequired: boolean; to: string }) {
  const customer = await db.insertInto('customers').values({
    email: `tlsworker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    name: 'TLS Worker Test',
    physical_address: '1 Test St, Springfield, ZZ 00000',
    tls_required: opts.tlsRequired,
  } as any).returning('id').executeTakeFirstOrThrow();

  const messageId = generateMessageId('sender.example.com');
  await db.insertInto('messages').values({
    message_id: messageId,
    customer_id: customer.id,
    from_address: 'sender@sender.example.com',
    to_address: opts.to,
    subject: 'Sensitive',
    status: 'queued',
    ip_pool: 'transactional',
    attempts: 0,
    body_storage: 'inline',
    text_body: 'sensitive content',
  } as any).execute();

  return { customerId: customer.id, messageId };
}

function unsafeAddress(label: string) {
  const domain = `tlsw-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.example.com`;
  domains.push(domain);
  return `recipient@${domain}`;
}

describe('BASE-08: send worker refuses unencrypted delivery for TLS-required tenants', () => {
  it('does not deliver to a domain observed accepting mail without TLS', async () => {
    const to = unsafeAddress('blocked');
    await recordDeliveryTlsOutcome(to, false); // prior plaintext delivery observed

    const seeded = await seedMessage({ tlsRequired: true, to });
    const jobId = `tlsGate${Date.now()}`;
    await sendQueue.add('send', { message_id: seeded.messageId, customer_id: seeded.customerId }, { jobId });
    await waitForCompletion(sendQueue, jobId);

    const message = await db.selectFrom('messages').select(['status', 'failure_reason'])
      .where('message_id', '=', seeded.messageId).executeTakeFirstOrThrow();

    // Never delivered, and the reason is recorded for the operator.
    expect(message.status).not.toBe('delivered');
    expect(message.status).not.toBe('sent');
    expect(message.failure_reason ?? '').toContain('tls_required_domain_unsafe');
  });

  it('delivers normally for a tenant that has not required TLS', async () => {
    const to = unsafeAddress('optout');
    await recordDeliveryTlsOutcome(to, false); // same unsafe domain

    const seeded = await seedMessage({ tlsRequired: false, to });
    const jobId = `tlsNoGate${Date.now()}`;
    await sendQueue.add('send', { message_id: seeded.messageId, customer_id: seeded.customerId }, { jobId });
    await waitForCompletion(sendQueue, jobId);

    const message = await db.selectFrom('messages').select(['status', 'failure_reason'])
      .where('message_id', '=', seeded.messageId).executeTakeFirstOrThrow();

    // The gate is opt-in: a tenant that never asked for TLS is not blocked.
    expect(message.failure_reason ?? '').not.toContain('tls_required_domain_unsafe');
  });

  it('delivers for a TLS-required tenant when the domain has no plaintext history', async () => {
    const to = unsafeAddress('clean');
    await recordDeliveryTlsOutcome(to, true);

    const seeded = await seedMessage({ tlsRequired: true, to });
    const jobId = `tlsClean${Date.now()}`;
    await sendQueue.add('send', { message_id: seeded.messageId, customer_id: seeded.customerId }, { jobId });
    await waitForCompletion(sendQueue, jobId);

    const message = await db.selectFrom('messages').select(['status', 'failure_reason'])
      .where('message_id', '=', seeded.messageId).executeTakeFirstOrThrow();
    expect(message.failure_reason ?? '').not.toContain('tls_required_domain_unsafe');
  });

  it('records the plaintext observation against the domain, not the address', async () => {
    // Two recipients at the same domain: blocking is domain-wide, because TLS
    // is negotiated per connection to the domain's MX, not per mailbox.
    const to = unsafeAddress('shared');
    await recordDeliveryTlsOutcome(to, false);
    const domain = recipientDomain(to)!;

    const other = `someone-else@${domain}`;
    const seeded = await seedMessage({ tlsRequired: true, to: other });
    const jobId = `tlsShared${Date.now()}`;
    await sendQueue.add('send', { message_id: seeded.messageId, customer_id: seeded.customerId }, { jobId });
    await waitForCompletion(sendQueue, jobId);

    const message = await db.selectFrom('messages').select('failure_reason')
      .where('message_id', '=', seeded.messageId).executeTakeFirstOrThrow();
    expect(message.failure_reason ?? '').toContain('tls_required_domain_unsafe');
  });
});
