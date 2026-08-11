// Real webhook worker -> local HTTP receiver coverage.
//
// Private webhook targets remain blocked everywhere else. This isolated test
// process opts into the documented local-only escape hatch before importing
// shared/worker modules, then verifies the actual BullMQ worker, HTTP bytes,
// HMAC headers, retry decisions, and durable delivery evidence.

import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.WEBHOOK_ALLOW_PRIVATE = '1';
process.env.WEBHOOK_TIMEOUT_MS = '100';

type Received = { body: string; headers: http.IncomingHttpHeaders };

let shared: typeof import('@platform/shared');
let startWebhookWorker: typeof import('@platform/worker/webhook-worker.js').startWebhookWorker;
let worker: ReturnType<typeof startWebhookWorker>;
let server: http.Server;
let endpoint: string;
let received: Received[] = [];
let statuses: number[] = [];
let responseDelayMs = 0;

const log: any = {
  child() { return this; },
  info() {},
  warn() {},
  error() {},
  debug() {},
};

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last!: T;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for webhook condition; last=${JSON.stringify(last)}`);
}

async function deliveryRows(webhookId: string) {
  return shared.db.selectFrom('webhook_delivery_log')
    .select(['attempt', 'status_code', 'outcome', 'error'])
    .where('webhook_id', '=', webhookId)
    .orderBy('id')
    .execute();
}

async function enqueue(webhookId: string, payload: Record<string, unknown>, attempts = 1) {
  return shared.webhooksQueue.add(
    'live-receiver',
    { webhook_id: webhookId, event_type: 'delivered', payload },
    { attempts, backoff: { type: 'fixed', delay: 25 } },
  );
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      received.push({ body: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
      const status = statuses.shift() ?? 204;
      setTimeout(() => {
        if (!res.destroyed) {
          res.writeHead(status, { 'content-type': 'text/plain' });
          res.end('receiver');
        }
      }, responseDelayMs);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local receiver did not bind a TCP port');
  endpoint = `http://127.0.0.1:${address.port}/webhook`;

  shared = await import('@platform/shared');
  ({ startWebhookWorker } = await import('@platform/worker/webhook-worker.js'));
  worker = startWebhookWorker(log);
});

beforeEach(async () => {
  received = [];
  statuses = [];
  responseDelayMs = 0;
  await shared.webhooksQueue.drain(true);
});

afterAll(async () => {
  await worker.close();
  await shared.webhooksQueue.drain(true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('live webhook worker delivery', () => {
  it('posts exact JSON with a verifiable HMAC and records success', async () => {
    const tenant = await shared.seedCustomer();
    const webhook = await shared.createWebhook({
      customerId: tenant.customerId,
      url: endpoint,
      events: ['delivered'],
    });
    const payload = { message_id: `live-${Date.now()}@example.com`, recipient: 'person@example.com' };
    await enqueue(webhook.id, payload);

    await waitFor(async () => received.length, (count) => count === 1);
    const request = received[0]!;
    expect(JSON.parse(request.body)).toEqual(payload);
    expect(request.headers['x-mp-event-type']).toBe('delivered');
    expect(request.headers['user-agent']).toBe('MailPlatform-Webhooks/1.0');

    const signatureHeader = String(request.headers['x-mp-signature']);
    const match = signatureHeader.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    expect(match).toBeTruthy();
    expect(match![2]).toBe(shared.signWebhook(webhook.secret, request.body, Number(match![1])));

    const rows = await waitFor(
      () => deliveryRows(webhook.id),
      (value) => value.some((row) => row.outcome === 'success'),
    );
    expect(rows).toEqual([
      expect.objectContaining({ attempt: 1, status_code: 204, outcome: 'success', error: null }),
    ]);
  });

  it('retries 429 and then records the successful second attempt', async () => {
    statuses = [429, 204];
    const tenant = await shared.seedCustomer();
    const webhook = await shared.createWebhook({
      customerId: tenant.customerId,
      url: endpoint,
      events: ['delivered'],
    });
    await enqueue(webhook.id, { message_id: `retry-${Date.now()}@example.com` }, 2);

    await waitFor(async () => received.length, (count) => count === 2);
    const rows = await waitFor(() => deliveryRows(webhook.id), (value) => value.length === 2);
    expect(rows).toEqual([
      expect.objectContaining({ attempt: 1, status_code: 429, outcome: 'failure' }),
      expect.objectContaining({ attempt: 2, status_code: 204, outcome: 'success' }),
    ]);
  });

  it('drops a permanent 400 without retrying', async () => {
    statuses = [400, 204, 204];
    const tenant = await shared.seedCustomer();
    const webhook = await shared.createWebhook({
      customerId: tenant.customerId,
      url: endpoint,
      events: ['delivered'],
    });
    const job = await enqueue(webhook.id, { message_id: `drop-${Date.now()}@example.com` }, 3);

    await waitFor(() => job.getState(), (state) => state === 'completed');
    expect(received).toHaveLength(1);
    expect(await deliveryRows(webhook.id)).toEqual([
      expect.objectContaining({ attempt: 1, status_code: 400, outcome: 'dropped', error: 'HTTP 400' }),
    ]);
  });

  it('records timeout evidence before BullMQ marks the attempt failed', async () => {
    // Undici/Node may clamp very small header timers internally; hold the
    // receiver long enough to cross that floor while remaining well inside the
    // test timeout.
    responseDelayMs = 2_000;
    const tenant = await shared.seedCustomer();
    const webhook = await shared.createWebhook({
      customerId: tenant.customerId,
      url: endpoint,
      events: ['delivered'],
    });
    const job = await enqueue(webhook.id, { message_id: `timeout-${Date.now()}@example.com` });

    await waitFor(() => job.getState(), (state) => state === 'failed');
    const rows = await waitFor(() => deliveryRows(webhook.id), (value) => value.length === 1);
    expect(rows[0]).toMatchObject({ attempt: 1, status_code: null, outcome: 'failure' });
    expect(rows[0]!.error).toMatch(/HEADERS_TIMEOUT|request_failed/);
  });
});
