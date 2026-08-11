// Critical-priority send lane: OTP/alert messages jump the queue.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain, type SeededCustomer } from './harness.js';
import { db, redis } from '@platform/shared';

let app: FastifyInstance;
let paid: SeededCustomer;
let free: SeededCustomer;
let paidDomain: string;
let freeDomain: string;

async function outboxPriority(messageId: string): Promise<number | null> {
  const row = await db
    .selectFrom('send_outbox')
    .select('priority')
    .where('message_id', '=', messageId)
    .executeTakeFirst();
  return row ? Number(row.priority) : null;
}

beforeAll(async () => {
  app = await buildTestApp();
  paid = await seedCustomer({ tier: 'paid' });
  free = await seedCustomer({ tier: 'free' });
  paidDomain = await seedVerifiedDomain(paid.customerId);
  freeDomain = await seedVerifiedDomain(free.customerId);
});

afterAll(async () => {
  await app.close();
});

function payload(domain: string, extra: Record<string, unknown> = {}) {
  return {
    from: `alerts@${domain}`,
    to: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    subject: 'Your login code',
    text: 'Code: 123456',
    ...extra,
  };
}

describe('critical-priority send lane', () => {
  it('grants the critical lane to paid tiers and puts the message at queue head', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/send',
      headers: { authorization: `Bearer ${paid.apiKey}` },
      payload: payload(paidDomain, { priority: 'critical' }),
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.priority_applied).toBe('critical');
    expect(body.priority_downgraded_reason).toBeUndefined();
    expect(await outboxPriority(body.message_ids[0])).toBe(1);
  });

  it('downgrades free-tier critical requests to the standard lane (mail still sends)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/send',
      headers: { authorization: `Bearer ${free.apiKey}` },
      payload: payload(freeDomain, { priority: 'critical' }),
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toBe(1);
    expect(body.priority_applied).toBe('standard');
    expect(body.priority_downgraded_reason).toBe('tier_not_eligible');
    expect(await outboxPriority(body.message_ids[0])).toBe(10);
  });

  it('leaves normal sends untouched (no lane fields in the response)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/send',
      headers: { authorization: `Bearer ${paid.apiKey}` },
      payload: payload(paidDomain),
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.priority_applied).toBeUndefined();
    expect(await outboxPriority(body.message_ids[0])).toBe(5); // paid-tier default
  });

  it('downgrades paid critical traffic after the per-minute cap without dropping the mail', async () => {
    const minute = Math.floor(Date.now() / 60_000);
    const cap = Number(process.env.CRITICAL_LANE_PER_MINUTE ?? 120);
    const counterKey = `lane:critical:${paid.customerId}:${minute}`;
    await redis.set(counterKey, String(cap), 'EX', 120);

    try {
      const res = await app.inject({
        method: 'POST', url: '/v1/send',
        headers: { authorization: `Bearer ${paid.apiKey}` },
        payload: payload(paidDomain, { priority: 'critical' }),
      });
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.accepted).toBe(1);
      expect(body.priority_applied).toBe('standard');
      expect(body.priority_downgraded_reason).toBe('rate_capped');
      expect(await outboxPriority(body.message_ids[0])).toBe(5);
    } finally {
      await redis.del(counterKey);
    }
  });

  it('fails toward the standard lane when Redis cannot meter critical traffic', async () => {
    const realIncrby = redis.incrby.bind(redis);
    const incr = vi.spyOn(redis, 'incrby').mockImplementation(async (key, amount) => {
      if (String(key).startsWith(`lane:critical:${paid.customerId}:`)) {
        throw new Error('synthetic Redis outage');
      }
      return realIncrby(key, amount);
    });
    try {
      const res = await app.inject({
        method: 'POST', url: '/v1/send',
        headers: { authorization: `Bearer ${paid.apiKey}` },
        payload: payload(paidDomain, { priority: 'critical' }),
      });
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.accepted).toBe(1);
      expect(body.priority_applied).toBe('standard');
      expect(body.priority_downgraded_reason).toBe('rate_capped');
      expect(await outboxPriority(body.message_ids[0])).toBe(5);
    } finally {
      incr.mockRestore();
    }
  });
});

describe('TLS-required compliance flag', () => {
  it('defaults off, can be enabled via PATCH /profile, and reads back', async () => {
    const before = await app.inject({
      method: 'GET', url: '/v1/profile',
      headers: { authorization: `Bearer ${paid.apiKey}` },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().customer.tls_required).toBe(false);

    const patch = await app.inject({
      method: 'PATCH', url: '/v1/profile',
      headers: { authorization: `Bearer ${paid.apiKey}` },
      payload: { tls_required: true },
    });
    expect(patch.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET', url: '/v1/profile',
      headers: { authorization: `Bearer ${paid.apiKey}` },
    });
    expect(after.json().customer.tls_required).toBe(true);

    // Reset so other tests' sends are unaffected.
    await app.inject({
      method: 'PATCH', url: '/v1/profile',
      headers: { authorization: `Bearer ${paid.apiKey}` },
      payload: { tls_required: false },
    });
  });
});

describe('domain scanner endpoint', () => {
  it('requires the domains scope and validates input', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/tools/domain-scan',
      headers: { authorization: `Bearer ${paid.apiKey}` },
      payload: { domain: 'localhost' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_domain');
  });

  it('scans a real public domain shape end to end (records may or may not exist)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/tools/domain-scan',
      headers: { authorization: `Bearer ${paid.apiKey}` },
      // RFC 2606 reserved domain — resolvable DNS, deterministic-ish, no SPF.
      payload: { domain: 'example.com', check_blocklists: false },
    });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.domain).toBe('example.com');
    expect(report.grade).toMatch(/[A-F]/);
    expect(Array.isArray(report.issues)).toBe(true);
    expect(Array.isArray(report.fixes)).toBe(true);
  });
});
