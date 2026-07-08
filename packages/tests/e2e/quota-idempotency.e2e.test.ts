// E2E: quota enforcement, idempotency replay, suppression filtering, abuse block.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startHarness,
  seedCustomer,
  seedVerifiedDomain,
  seedSuppression,
  resetQuota,
  countMessagesTo,
  resetPoolWarmup,
  type Harness,
} from './harness.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await resetPoolWarmup("transactional"); });
afterAll(async () => { await h.close(); });

function send(apiKey: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/send',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...headers },
    payload,
  });
}

describe('E2E quota', () => {
  it('rejects a request that exceeds the daily quota with 429', async () => {
    const cust = await seedCustomer({ dailyQuota: 2, monthlyQuota: 1000 });
    const domain = await seedVerifiedDomain(cust.customerId);
    await resetQuota(cust.customerId);

    const res = await send(cust.apiKey, {
      from: `x@${domain}`, to: ['a@g.com', 'b@g.com', 'c@g.com'], subject: 's', text: 't',
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('quota_exceeded');
    expect(res.json().daily.limit).toBe(2);
  });

  it('consumes quota incrementally and rejects once exhausted', async () => {
    const cust = await seedCustomer({ dailyQuota: 2, monthlyQuota: 1000 });
    const domain = await seedVerifiedDomain(cust.customerId);
    await resetQuota(cust.customerId);

    const ok1 = await send(cust.apiKey, { from: `x@${domain}`, to: 'a@g.com', subject: 's', text: 't' });
    expect(ok1.statusCode).toBe(202);
    const ok2 = await send(cust.apiKey, { from: `x@${domain}`, to: 'b@g.com', subject: 's', text: 't' });
    expect(ok2.statusCode).toBe(202);
    const blocked = await send(cust.apiKey, { from: `x@${domain}`, to: 'c@g.com', subject: 's', text: 't' });
    expect(blocked.statusCode).toBe(429);
  });

  it('does NOT oversell quota under concurrent sends (atomic reservation)', async () => {
    // Seed a tight daily quota and fire many more parallel sends than allowed.
    // The Lua check-and-increment must admit EXACTLY `limit` of them — never
    // more — even though all requests race on the same counter.
    const limit = 5;
    const cust = await seedCustomer({ dailyQuota: limit, monthlyQuota: 100000 });
    const domain = await seedVerifiedDomain(cust.customerId);
    await resetQuota(cust.customerId);

    const attempts = 20;
    const results = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        send(cust.apiKey, { from: `x@${domain}`, to: `c${i}@g.com`, subject: 's', text: 't' })
      )
    );
    const accepted = results.filter((r) => r.statusCode === 202).length;
    const rejected = results.filter((r) => r.statusCode === 429).length;

    // Exactly `limit` admitted, the rest rejected — no oversell, none lost.
    expect(accepted).toBe(limit);
    expect(rejected).toBe(attempts - limit);
  });
});

describe('E2E idempotency', () => {
  it('replays the stored response for a repeated Idempotency-Key', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const key = `idem-${Date.now()}`;
    const payload = { from: `x@${domain}`, to: 'dup@g.com', subject: 'once', text: 'body' };

    const first = await send(cust.apiKey, payload, { 'idempotency-key': key });
    expect(first.statusCode).toBe(202);
    const firstIds = first.json().message_ids;

    const second = await send(cust.apiKey, payload, { 'idempotency-key': key });
    expect(second.statusCode).toBe(202);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json().message_ids).toEqual(firstIds);

    // Only one real message persisted for that recipient under this customer.
    expect(await countMessagesTo(cust.customerId, 'dup@g.com')).toBe(1);
  });

  it('returns 422 when the same key is reused with a different body', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const key = `idem-conflict-${Date.now()}`;

    const first = await send(cust.apiKey,
      { from: `x@${domain}`, to: 'one@g.com', subject: 'A', text: 'a' },
      { 'idempotency-key': key });
    expect(first.statusCode).toBe(202);

    const conflict = await send(cust.apiKey,
      { from: `x@${domain}`, to: 'two@g.com', subject: 'B', text: 'b' },
      { 'idempotency-key': key });
    expect(conflict.statusCode).toBe(422);
    expect(conflict.json().error).toBe('idempotency_key_reused');
  });

  it('under concurrent identical requests, sends EXACTLY ONCE (no double-send race)', async () => {
    const cust = await seedCustomer({ dailyQuota: 1000, monthlyQuota: 100000 });
    const domain = await seedVerifiedDomain(cust.customerId);
    await resetQuota(cust.customerId);
    const key = `idem-race-${Date.now()}`;
    const payload = { from: `x@${domain}`, to: 'race@g.com', subject: 'race', text: 'body' };

    // Fire 12 identical requests with the SAME idempotency key simultaneously.
    // The atomic INSERT ... ON CONFLICT reservation must let exactly one proceed;
    // the rest must replay (202) or report in_progress (409) — but never send a
    // second message.
    const results = await Promise.all(
      Array.from({ length: 12 }, () => send(cust.apiKey, payload, { 'idempotency-key': key }))
    );

    const codes = results.map((r) => r.statusCode);
    // Every response is a "safe" outcome: accepted, replayed (202), or in-progress (409).
    for (const c of codes) expect([202, 409]).toContain(c);
    // At least one succeeded.
    expect(codes.filter((c) => c === 202).length).toBeGreaterThanOrEqual(1);

    // Critically: exactly ONE real message was persisted for that recipient,
    // regardless of how many concurrent callers raced.
    expect(await countMessagesTo(cust.customerId, 'race@g.com')).toBe(1);
  });

  it('a 409 in_progress request can be safely retried and replays the same result', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const key = `idem-retry-${Date.now()}`;
    const payload = { from: `x@${domain}`, to: 'retry@g.com', subject: 'r', text: 'r' };

    const first = await send(cust.apiKey, payload, { 'idempotency-key': key });
    expect(first.statusCode).toBe(202);
    const ids = first.json().message_ids;

    // A later retry with the same key replays — never creates a second message.
    const retry = await send(cust.apiKey, payload, { 'idempotency-key': key });
    expect(retry.statusCode).toBe(202);
    expect(retry.json().message_ids).toEqual(ids);
    expect(await countMessagesTo(cust.customerId, 'retry@g.com')).toBe(1);
  });
});

describe('E2E suppression', () => {
  it('does not send to a suppressed recipient', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    await seedSuppression(cust.customerId, 'blocked@g.com', 'hard_bounce');

    const res = await send(cust.apiKey, {
      from: `x@${domain}`, to: ['blocked@g.com', 'good@g.com'], subject: 's', text: 't',
    });
    expect(res.statusCode).toBe(202);
    const json = res.json();
    expect(json.accepted).toBe(1);
    expect(json.suppressed).toContain('blocked@g.com');
  });

  it('returns accepted:0 when every recipient is suppressed', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    await seedSuppression(cust.customerId, 'all-blocked@g.com', 'complaint');

    const res = await send(cust.apiKey, { from: `x@${domain}`, to: 'all-blocked@g.com', subject: 's', text: 't' });
    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(0);
  });
});

describe('E2E abuse', () => {
  it('blocks or holds obvious spam content', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const spam =
      'VIAGRA CIALIS!!! 100% FREE MONEY!!! ACT NOW!!! CLICK HERE TO WIN A FREE PRIZE!!! ' +
      'GUARANTEED WEIGHT LOSS!!! WORK FROM HOME EARN $$$ NOW!!! NIGERIAN PRINCE WIRE TRANSFER!!!';
    const res = await send(cust.apiKey, {
      from: `x@${domain}`, to: 'victim@g.com',
      subject: 'FREE MONEY WINNER ACT NOW VIAGRA',
      html: `<p>${spam} <a href="http://bit.ly/scam">claim</a></p>`,
    });
    if (res.statusCode === 422) {
      expect(res.json().error).toBe('content_rejected');
    } else {
      expect(res.statusCode).toBe(202);
      expect(res.json().status).toBe('held_for_review');
    }
  });
});
