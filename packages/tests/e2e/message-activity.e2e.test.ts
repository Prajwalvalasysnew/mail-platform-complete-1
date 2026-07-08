import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  seedCustomer,
  seedQueuedMessage,
  seedMessageEvent,
  type Harness,
  type SeededCustomer,
} from './harness.js';

let h: Pick<Harness, 'app' | 'close'>;

beforeAll(async () => {
  const app = await buildTestApp();
  h = { app, close: () => app.close() };
});

afterAll(async () => {
  await h.close();
});

function req(cust: SeededCustomer, url: string) {
  return h.app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${cust.apiKey}` },
  });
}

describe('E2E message activity', () => {
  it('lists newest-first events scoped to the authenticated customer', async () => {
    const cust = await seedCustomer();
    const other = await seedCustomer();
    const msg = await seedQueuedMessage(cust.customerId, {
      from: 'news@brand.test',
      to: 'reader@example.com',
      subject: 'Activity',
      status: 'delivered',
      tags: ['campaign-a'],
    });
    const otherMsg = await seedQueuedMessage(other.customerId, { to: 'reader@example.com' });

    await seedMessageEvent(cust.customerId, msg, 'queued', { source: 'test' });
    const deliveredId = await seedMessageEvent(cust.customerId, msg, 'delivered', { mx: 'gmail' });
    await seedMessageEvent(other.customerId, otherMsg, 'delivered');

    const res = await req(cust, '/v1/messages/activity?limit=10');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events.map((e: any) => e.event_id)).toContain(deliveredId);
    expect(body.events.every((e: any) => e.message_id !== otherMsg)).toBe(true);
    expect(body.events[0].event_id).toBeGreaterThan(body.events[body.events.length - 1].event_id);
  });

  it('filters by event type, recipient, sender, tag, status, and message id', async () => {
    const cust = await seedCustomer();
    const wanted = await seedQueuedMessage(cust.customerId, {
      from: 'Alerts@Brand.Test',
      to: 'Target@Example.com',
      subject: 'Wanted',
      status: 'delivered',
      tags: ['security'],
    });
    const ignored = await seedQueuedMessage(cust.customerId, {
      from: 'alerts@brand.test',
      to: 'other@example.com',
      status: 'delivered',
      tags: ['security'],
    });

    const wantedEvent = await seedMessageEvent(cust.customerId, wanted, 'delivered');
    await seedMessageEvent(cust.customerId, ignored, 'delivered');
    await seedMessageEvent(cust.customerId, wanted, 'opened');

    const qs = [
      'event_type=delivered',
      'to=target@example.com',
      'from=alerts@brand.test',
      'tag=security',
      'status=delivered',
      `message_id=${encodeURIComponent(wanted)}`,
    ].join('&');
    const res = await req(cust, `/v1/messages/activity?${qs}`);

    expect(res.statusCode).toBe(200);
    expect(res.json().events.map((e: any) => e.event_id)).toEqual([wantedEvent]);
  });

  it('uses id cursors for pagination', async () => {
    const cust = await seedCustomer();
    const msg = await seedQueuedMessage(cust.customerId);
    const ids = [
      await seedMessageEvent(cust.customerId, msg, 'queued'),
      await seedMessageEvent(cust.customerId, msg, 'sent'),
      await seedMessageEvent(cust.customerId, msg, 'delivered'),
    ];

    const first = await req(cust, '/v1/messages/activity?limit=2');
    expect(first.statusCode).toBe(200);
    expect(first.json().events.map((e: any) => e.event_id)).toEqual([ids[2], ids[1]]);
    expect(first.json().next_cursor).toBe(ids[1]);

    const second = await req(cust, `/v1/messages/activity?limit=2&before=${first.json().next_cursor}`);
    expect(second.statusCode).toBe(200);
    expect(second.json().events.map((e: any) => e.event_id)).toEqual([ids[0]]);
    expect(second.json().next_cursor).toBeNull();
  });
});
