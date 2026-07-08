// E2E: the full send pipeline, end to end, over real HTTP against live PG+Redis.
//
// Test-mode key -> /v1/send -> quota reserve -> abuse scan -> DB insert -> BullMQ
// -> send worker -> sandbox transport -> status=accepted -> usage_daily bumped
// -> events row written. No real SMTP.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startHarness,
  seedCustomer,
  seedVerifiedDomain,
  waitForStatus,
  getUsageSent,
  getEventTypes,
  getTrackedLinkUrls,
  resetPoolWarmup,
  type Harness,
  type SeededCustomer,
} from './harness.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
  await resetPoolWarmup('transactional');
});

afterAll(async () => {
  await h.close();
});

async function sender(cust: SeededCustomer, domain: string, body: Record<string, unknown>) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/send',
    headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
    payload: { from: `noreply@${domain}`, ...body },
  });
}

describe('E2E send pipeline', () => {
  it('accepts a message and drives it to accepted via the worker', async () => {
    const cust = await seedCustomer({ keyType: 'test' });
    const domain = await seedVerifiedDomain(cust.customerId);

    const res = await sender(cust, domain, {
      to: 'recipient@gmail.com',
      subject: 'Hello from E2E',
      html: '<p>Welcome aboard!</p>',
    });

    expect(res.statusCode).toBe(202);
    const json = res.json();
    expect(json.accepted).toBe(1);
    expect(json.message_ids).toHaveLength(1);

    const messageId = json.message_ids[0];
    const finalStatus = await waitForStatus(messageId, ['accepted', 'sent']);
    expect(['accepted', 'sent']).toContain(finalStatus);

    expect(await getUsageSent(cust.customerId)).toBeGreaterThanOrEqual(1);

    const types = await getEventTypes(messageId);
    expect(types).toContain('queued');
    expect(types).toContain('sent');
  });

  it('fans out to multiple recipients, one message per recipient', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);

    const res = await sender(cust, domain, {
      to: ['a@gmail.com', 'b@gmail.com', 'c@gmail.com'],
      subject: 'Batch',
      text: 'hi',
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(3);
    expect(res.json().message_ids).toHaveLength(3);

    for (const id of res.json().message_ids) {
      await waitForStatus(id, ['accepted', 'sent']);
    }
  });

  it('rewrites click links and injects the open pixel for HTML mail', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);

    const res = await sender(cust, domain, {
      to: 'track@gmail.com',
      subject: 'Tracked',
      html: '<p><a href="https://example.org/page">click</a></p>',
      tracking: { opens: true, clicks: true },
    });
    const id = res.json().message_ids[0];
    await waitForStatus(id, ['accepted', 'sent']);

    const urls = await getTrackedLinkUrls(id);
    expect(urls).toContain('https://example.org/page');
  });
});
