// Phase 4.1 (docs/DATABASE_10_10_PLAN.md): analytics served from ClickHouse.
//
// Uses an in-process HTTP stub as the ClickHouse endpoint (same pattern as
// clickhouse-reconcile.test.ts). Proves: 7d/30d summary + daily timeseries
// are answered from the rollup query (uniqExactMerge over events_daily);
// tenant retention windows clamp the rollup's day floor; and a ClickHouse
// failure falls back to the Postgres path with correct counts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

let server: http.Server;
let baseUrl: string;
let lastQueries: URL[] = [];
let lastHeaders: http.IncomingHttpHeaders[] = [];
let failNext = false;
// Rows the stub returns for the next SELECT (ClickHouse JSON wire format).
let nextData: unknown[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    lastQueries.push(url);
    lastHeaders.push(req.headers);
    req.resume();
    req.on('end', () => {
      if (failNext) { failNext = false; res.statusCode = 503; res.end('unavailable'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: nextData }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.EVENTS_CLICKHOUSE_URL = baseUrl;
  process.env.EVENTS_CLICKHOUSE_USER = 'analytics-e2e';
  process.env.EVENTS_CLICKHOUSE_PASSWORD = 'analytics-e2e-key';
});

afterAll(async () => {
  delete process.env.EVENTS_CLICKHOUSE_URL;
  delete process.env.EVENTS_CLICKHOUSE_USER;
  delete process.env.EVENTS_CLICKHOUSE_PASSWORD;
  await new Promise<void>((r) => server.close(() => r()));
  await app.close();
});

beforeEach(() => {
  lastQueries = [];
  lastHeaders = [];
  nextData = [];
  failNext = false;
});

process.env.EVENTS_CLICKHOUSE_URL = process.env.EVENTS_CLICKHOUSE_URL ?? 'http://127.0.0.1:1';
const { buildTestApp, seedCustomer } = await import('./harness.js');
const shared = await import('@platform/shared');
const { seedOldEvent, seedOldMessage, clearRetentionPolicyCache, db } = shared as any;

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildTestApp();
});

function get(url: string, apiKey: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${apiKey}` } });
}

describe('analytics served from the ClickHouse rollup', () => {
  it('7d summary uses uniqExactMerge over the daily rollup', async () => {
    const { customerId, apiKey } = await seedCustomer();
    nextData = [
      { event_type: 'queued', count: '120' },
      { event_type: 'delivered', count: '100' },
      { event_type: 'opened', count: '40' },
    ];

    const res = await get('/v1/analytics/summary?period=7d', apiKey);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sent).toBe(120);
    expect(body.delivered).toBe(100);
    expect(body.opened).toBe(40);
    expect(body.open_rate).toBe(0.4);

    const q = lastQueries.at(-1)!;
    expect(q.searchParams.get('query')).toContain('uniqExactMerge(event_uniq)');
    expect(q.searchParams.get('query')).toContain('events_daily');
    expect(q.searchParams.get('param_customer_id')).toBe(customerId);
    expect(lastHeaders.at(-1)?.['x-clickhouse-user']).toBe('analytics-e2e');
    expect(lastHeaders.at(-1)?.['x-clickhouse-key']).toBe('analytics-e2e-key');
  });

  it('daily timeseries is served from the rollup, hourly stays on Postgres', async () => {
    const { apiKey } = await seedCustomer();
    nextData = [
      { day: '2026-07-14', event_type: 'delivered', count: '10' },
      { day: '2026-07-15', event_type: 'delivered', count: '12' },
    ];

    const daily = await get('/v1/analytics/timeseries?period=7d&granularity=day', apiKey);
    expect(daily.statusCode).toBe(200);
    expect(daily.json().series).toEqual([
      { date: '2026-07-14', sent: 0, delivered: 10, bounced: 0, opened: 0, clicked: 0 },
      { date: '2026-07-15', sent: 0, delivered: 12, bounced: 0, opened: 0, clicked: 0 },
    ]);
    const chQueryCount = lastQueries.length;

    // Hourly must not touch the stub.
    const hourly = await get('/v1/analytics/timeseries?period=7d&granularity=hour', apiKey);
    expect(hourly.statusCode).toBe(200);
    expect(lastQueries.length).toBe(chQueryCount);
  });

  it('the tenant retention window clamps the rollup day floor', async () => {
    const { customerId, apiKey } = await seedCustomer();
    await db.updateTable('customers').set({ events_retention_days: 3 }).where('id', '=', customerId).execute();
    clearRetentionPolicyCache();

    await get('/v1/analytics/summary?period=30d', apiKey);
    const q = lastQueries.at(-1)!;
    const since = q.searchParams.get('param_since')!;
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    expect(since).toBe(threeDaysAgo); // 30d request, 3d plan window → 3d floor
  });

  it('a ClickHouse failure falls back to Postgres with correct counts', async () => {
    const { customerId, apiKey } = await seedCustomer();
    const msgId = await seedOldMessage(customerId, { daysAgo: 2, status: 'delivered' });
    await seedOldEvent(customerId, msgId, 'delivered', 2);
    failNext = true;

    const res = await get('/v1/analytics/summary?period=7d', apiKey);
    expect(res.statusCode).toBe(200);
    expect(res.json().delivered).toBe(1); // came from Postgres, not the stub
  });
});
