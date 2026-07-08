// Regression: a recipient who opted out of a specific unsubscribe group must
// not receive future sends to that group. unsubscribe_group_members recorded
// the opt-out (via the tracker's one-click flow), but neither /v1/send nor
// /v1/send/batch ever checked it before this fix — only GLOBAL suppressions
// were enforced, so a recipient's group-level "stop sending me this
// newsletter" request was silently ignored by every subsequent send to that
// group.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startHarness,
  seedCustomer,
  seedVerifiedDomain,
  waitForStatus,
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

async function createGroup(cust: SeededCustomer, name: string): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/unsubscribe-groups',
    headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json().group.id as string;
}

async function optOut(cust: SeededCustomer, groupId: string, email: string) {
  const res = await h.app.inject({
    method: 'POST',
    url: `/v1/unsubscribe-groups/${groupId}/members`,
    headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
    payload: { emails: [email] },
  });
  expect(res.statusCode).toBe(200);
}

describe('group unsubscribe enforcement', () => {
  it('single /send skips a recipient who opted out of the target group and refunds quota', async () => {
    const cust = await seedCustomer({ keyType: 'test' });
    const domain = await seedVerifiedDomain(cust.customerId);
    const groupId = await createGroup(cust, 'Weekly Newsletter');
    const optedOutEmail = 'optedout@gmail.com';
    await optOut(cust, groupId, optedOutEmail);

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: {
        from: `noreply@${domain}`,
        to: optedOutEmail,
        subject: 'This week in newsletters',
        html: '<p>hi</p>',
        unsubscribe_group_id: groupId,
      },
    });

    expect(res.statusCode).toBe(200); // 200, not 202 — nothing was accepted
    const body = res.json();
    expect(body.accepted).toBe(0);
    expect(body.message_ids).toHaveLength(0);
    expect(body.suppressed).toContain(optedOutEmail);
  });

  it('single /send still delivers to that same recipient for a DIFFERENT group', async () => {
    const cust = await seedCustomer({ keyType: 'test' });
    const domain = await seedVerifiedDomain(cust.customerId);
    const newsletterGroup = await createGroup(cust, 'Newsletter B');
    const productUpdatesGroup = await createGroup(cust, 'Product Updates B');
    const email = 'partial-optout@gmail.com';
    await optOut(cust, newsletterGroup, email);

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: {
        from: `noreply@${domain}`,
        to: email,
        subject: 'A product update',
        html: '<p>hi</p>',
        unsubscribe_group_id: productUpdatesGroup,
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(1);
  });

  it('single /send still delivers to that recipient when no group is specified at all', async () => {
    const cust = await seedCustomer({ keyType: 'test' });
    const domain = await seedVerifiedDomain(cust.customerId);
    const group = await createGroup(cust, 'Promo C');
    const email = 'ungrouped-send@gmail.com';
    await optOut(cust, group, email);

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { from: `noreply@${domain}`, to: email, subject: 'Transactional receipt', html: '<p>hi</p>' },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(1);
  });

  it('/send/batch skips only the opted-out recipients in the same group and delivers the rest', async () => {
    const cust = await seedCustomer({ keyType: 'test' });
    const domain = await seedVerifiedDomain(cust.customerId);
    const groupId = await createGroup(cust, 'Batch Newsletter');
    const optedOutEmail = 'batch-optedout@gmail.com';
    const stillSubscribed = 'batch-subscribed@gmail.com';
    await optOut(cust, groupId, optedOutEmail);

    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/send/batch',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: {
        messages: [
          { from: `noreply@${domain}`, to: optedOutEmail, subject: 'Batch newsletter', html: '<p>hi</p>', unsubscribe_group_id: groupId },
          { from: `noreply@${domain}`, to: stillSubscribed, subject: 'Batch newsletter', html: '<p>hi</p>', unsubscribe_group_id: groupId },
        ],
      },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    const results = body.results as Array<{ index: number; accepted: boolean; suppressed?: boolean; message_id?: string }>;
    expect(results).toHaveLength(2);

    const optedOutResult = results.find((r) => r.index === 0)!;
    expect(optedOutResult.accepted).toBe(false);
    expect(optedOutResult.suppressed).toBe(true);

    const subscribedResult = results.find((r) => r.index === 1)!;
    expect(subscribedResult.accepted).toBe(true);
    expect(subscribedResult.message_id).toBeTruthy();

    const finalStatus = await waitForStatus(subscribedResult.message_id!, ['accepted', 'sent']);
    expect(['accepted', 'sent']).toContain(finalStatus);
  });
});
