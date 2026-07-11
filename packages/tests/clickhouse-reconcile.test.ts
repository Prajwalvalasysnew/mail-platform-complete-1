// DB integration test for ClickHouse analytics reconciliation (gap analysis
// Top-20 #13: "best-effort dual write can lose analytics events"). Uses a tiny
// in-process HTTP stub as the ClickHouse endpoint so the reconciler actually
// POSTs to it. Proves: events past the watermark are shipped and the watermark
// advances; a stub FAILURE does NOT advance the watermark (events are retried,
// never lost); and a subsequent run backfills them.
//
// EVENTS_CLICKHOUSE_URL must be set BEFORE @platform/shared is imported (the
// module reads it at load), so it's set at the top of this file.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Stub ClickHouse server: records inserted rows; can be toggled to fail.
let received: string[] = [];
let requestedUrls: string[] = [];
let failNext = false;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requestedUrls.push(req.url ?? '');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (failNext) { res.statusCode = 503; res.end('unavailable'); return; }
      for (const line of body.split('\n')) if (line.trim()) received.push(line);
      res.statusCode = 200; res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  process.env.EVENTS_CLICKHOUSE_URL = baseUrl;
});

afterAll(async () => {
  delete process.env.EVENTS_CLICKHOUSE_URL;
  await new Promise<void>((r) => server.close(() => r()));
});

// Import AFTER the env var is set at module top (see note). Vitest hoists
// imports, so we set the env in a separate module-scope statement first:
process.env.EVENTS_CLICKHOUSE_URL = process.env.EVENTS_CLICKHOUSE_URL ?? 'http://127.0.0.1:1';
const shared = await import('@platform/shared');
const { reconcileClickhouse, clickhouseSyncLag, deleteClickhouseMessageEvents, seedCustomer, db } = shared as any;

async function insertEvents(customerId: string, n: number, typePrefix = 'sent') {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const row = await db.insertInto('events').values({
      message_id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      customer_id: customerId,
      event_type: 'sent',
      payload: { i, kind: typePrefix },
    }).returning('id').executeTakeFirstOrThrow();
    ids.push(Number(row.id));
  }
  return ids;
}

async function resetWatermarkToMax() {
  // Set the watermark to the current max event id so tests start "caught up"
  // and only observe their own newly-inserted events.
  const maxRow = await db.selectFrom('events').select(({ fn }: any) => fn.max('id').as('m')).executeTakeFirst();
  await db.updateTable('clickhouse_sync_state').set({ last_synced_event_id: String(maxRow?.m ?? 0) }).where('id', '=', 1).execute();
}

describe('clickhouse reconciliation', () => {
  beforeEach(async () => { received = []; requestedUrls = []; failNext = false; await resetWatermarkToMax(); });

  it('performs a synchronous tenant-scoped mutation for privacy erasure', async () => {
    await deleteClickhouseMessageEvents('customer-privacy', 'message-privacy');
    expect(requestedUrls).toHaveLength(1);
    const url = new URL(requestedUrls[0], baseUrl);
    expect(url.searchParams.get('mutations_sync')).toBe('2');
    expect(url.searchParams.get('param_customer_id')).toBe('customer-privacy');
    expect(url.searchParams.get('param_message_id')).toBe('message-privacy');
    expect(url.searchParams.get('query')).toContain('ALTER TABLE events DELETE WHERE');
  });

  it('advances past tombstoned events without reinserting them', async () => {
    const c = await seedCustomer();
    const messageId = `erased-${Date.now()}`;
    const event = await db.insertInto('events').values({
      message_id: messageId, customer_id: c.customerId, event_type: 'sent', payload: {},
    }).returning('id').executeTakeFirstOrThrow();
    const request = await db.insertInto('deletion_requests').values({
      customer_id: c.customerId, recipient: 'erased@example.com', status: 'completed',
    }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('privacy_message_tombstones').values({
      customer_id: c.customerId, message_id: messageId, deletion_request_id: request.id,
    }).execute();

    const result = await reconcileClickhouse({ batchSize: 100 });
    expect(result.shipped).toBe(0);
    expect(BigInt(result.toEventId)).toBeGreaterThanOrEqual(BigInt(event.id));
    expect(received).toHaveLength(0);
  });

  it('ships events past the watermark and advances it', async () => {
    const c = await seedCustomer();
    const ids = await insertEvents(c.customerId, 5);

    const res = await reconcileClickhouse({ batchSize: 100 });
    expect(res.ran).toBe(true);
    expect(res.shipped).toBeGreaterThanOrEqual(5);
    expect(BigInt(res.toEventId)).toBeGreaterThanOrEqual(BigInt(Math.max(...ids)));
    // The stub received the rows.
    expect(received.length).toBeGreaterThanOrEqual(5);

    // Running again shifts nothing (already caught up).
    const again = await reconcileClickhouse({ batchSize: 100 });
    expect(again.shipped).toBe(0);
  });

  it('ships a stable event_id (the ClickHouse dedup key) equal to the Postgres id', async () => {
    const c = await seedCustomer();
    const ids = await insertEvents(c.customerId, 3);
    await reconcileClickhouse({ batchSize: 100 });
    const shippedIds = received.map((line) => JSON.parse(line).event_id);
    // Every shipped row carries an event_id, and our inserted ids are covered —
    // so a hot-path write of the same event (same id) collapses in ClickHouse.
    expect(shippedIds.every((id) => typeof id === 'number')).toBe(true);
    for (const id of ids) expect(shippedIds).toContain(id);
  });

  it('does NOT advance the watermark when the insert fails (events retried, not lost)', async () => {
    const c = await seedCustomer();
    const ids = await insertEvents(c.customerId, 4);

    // Watermark before.
    const before = await clickhouseSyncLag();

    // Make ClickHouse fail — reconcile must NOT advance the watermark.
    failNext = true;
    const failed = await reconcileClickhouse({ batchSize: 100 });
    expect(failed.failed).toBe(true);
    expect(failed.shipped).toBe(0);

    const afterFail = await clickhouseSyncLag();
    expect(afterFail.watermark).toBe(before.watermark); // unchanged
    expect(afterFail.lag).toBeGreaterThanOrEqual(4);    // events still pending

    // Recover: ClickHouse healthy again → the SAME events are backfilled.
    failNext = false;
    received = [];
    const recovered = await reconcileClickhouse({ batchSize: 100 });
    expect(recovered.shipped).toBeGreaterThanOrEqual(4);
    expect(received.length).toBeGreaterThanOrEqual(4);
    expect(BigInt(recovered.toEventId)).toBeGreaterThanOrEqual(BigInt(Math.max(...ids)));
  });

  it('processes in multiple batches when there are more events than the batch size', async () => {
    const c = await seedCustomer();
    await insertEvents(c.customerId, 7);

    const res = await reconcileClickhouse({ batchSize: 2 });
    expect(res.shipped).toBeGreaterThanOrEqual(7);
    expect(res.batches).toBeGreaterThanOrEqual(4); // ceil(7/2)
  });

  it('reports lag accurately', async () => {
    const c = await seedCustomer();
    await insertEvents(c.customerId, 3);
    const lag = await clickhouseSyncLag();
    expect(lag.lag).toBeGreaterThanOrEqual(3);
    await reconcileClickhouse({ batchSize: 100 });
    const after = await clickhouseSyncLag();
    expect(after.lag).toBe(0);
  });
});
