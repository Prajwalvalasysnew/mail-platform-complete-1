// E2E: login rate-limiting.
//
// Verifies the per-route @fastify/rate-limit configs on both the customer
// login endpoint (max 10 / 15 min, keyed by email) and the admin login
// endpoint (max 5 / 15 min, keyed by email). Each test uses a fresh
// in-memory rate-limit store (new Fastify instance) so there is no bleed
// between runs.
//
// We use stub handlers that mirror the production rate-limit config from
// account.ts and admin.ts. This isolates the rate-limit policy from the
// DB-dependent authenticate() logic, which is covered by other tests.

import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';

// Exact rate-limit config mirrored from packages/api/src/routes/account.ts
const customerLoginRateLimitConfig = {
  hook: 'preHandler' as const,
  max: 10,
  timeWindow: '15 minutes',
  keyGenerator: (req: FastifyRequest) => {
    const body = req.body as Record<string, unknown> | null;
    const email = typeof body?.email === 'string' ? body.email.toLowerCase() : null;
    return `login:${email ?? req.ip}`;
  },
  errorResponseBuilder: (_req: FastifyRequest, ctx: { ttl: number }) => ({
    statusCode: 429,
    error: 'rate_limited',
    message: `Too many login attempts. Retry in ${Math.ceil(ctx.ttl / 1000)}s.`,
    retry_after: Math.ceil(ctx.ttl / 1000),
  }),
};

// Exact rate-limit config mirrored from packages/api/src/routes/admin.ts
const adminLoginRateLimitConfig = {
  hook: 'preHandler' as const,
  max: 5,
  timeWindow: '15 minutes',
  keyGenerator: (req: FastifyRequest) => {
    const body = req.body as Record<string, unknown> | null;
    const email = typeof body?.email === 'string' ? body.email.toLowerCase() : null;
    return `adminLogin:${email ?? req.ip}`;
  },
  errorResponseBuilder: (_req: FastifyRequest, ctx: { ttl: number }) => ({
    statusCode: 429,
    error: 'rate_limited',
    message: `Too many login attempts. Retry in ${Math.ceil(ctx.ttl / 1000)}s.`,
    retry_after: Math.ceil(ctx.ttl / 1000),
  }),
};

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

async function buildCustomerLoginApp(): Promise<FastifyInstance> {
  const instance = Fastify({ trustProxy: true, logger: false });
  await instance.register(sensible);
  // Register with global: false so only explicitly configured routes are limited.
  await instance.register(rateLimit, { global: false });
  // Stub handler: mirrors the account.ts route config exactly.
  instance.post('/v1/auth/login', {
    config: { rateLimit: customerLoginRateLimitConfig },
  }, async () => ({ error: 'invalid_credentials' }));
  await instance.ready();
  return instance;
}

async function buildAdminLoginApp(): Promise<FastifyInstance> {
  const instance = Fastify({ trustProxy: true, logger: false });
  await instance.register(sensible);
  await instance.register(rateLimit, { global: false });
  // Stub handler: mirrors the admin.ts route config exactly.
  instance.post('/admin/auth/login', {
    config: { rateLimit: adminLoginRateLimitConfig },
  }, async () => ({ error: 'invalid_credentials' }));
  await instance.ready();
  return instance;
}

// ---------------------------------------------------------------------------
// Customer login: max 10 per 15 minutes, keyed by email
// ---------------------------------------------------------------------------

describe('customer login rate limit (max 10 / 15 min per email)', () => {
  it('allows the first 10 attempts and blocks the 11th with 429', async () => {
    app = await buildCustomerLoginApp();

    const email = `rl-cust-${Date.now()}@example.com`;
    const payload = JSON.stringify({ email, password: 'wrong' });
    const headers = { 'content-type': 'application/json' };

    // Requests 1-10 must pass through (not rate-limited).
    for (let i = 1; i <= 10; i++) {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/login', headers, payload });
      expect(res.statusCode, `request ${i} should not be rate-limited`).not.toBe(429);
    }

    // Request 11 must be rate-limited.
    const limited = await app.inject({ method: 'POST', url: '/v1/auth/login', headers, payload });
    expect(limited.statusCode).toBe(429);
    const body = limited.json();
    expect(body.error).toBe('rate_limited');
    expect(body.retry_after).toBeGreaterThan(0);
  });

  it('rate-limits are keyed per email: a different email has its own counter', async () => {
    app = await buildCustomerLoginApp();

    const emailA = `rl-a-${Date.now()}@example.com`;
    const emailB = `rl-b-${Date.now()}@example.com`;
    const headers = { 'content-type': 'application/json' };

    // Exhaust emailA's limit.
    for (let i = 0; i < 10; i++) {
      await app.inject({ method: 'POST', url: '/v1/auth/login', headers, payload: JSON.stringify({ email: emailA, password: 'x' }) });
    }
    const limitedA = await app.inject({ method: 'POST', url: '/v1/auth/login', headers, payload: JSON.stringify({ email: emailA, password: 'x' }) });
    expect(limitedA.statusCode).toBe(429);

    // emailB's counter is independent — first request must not be blocked.
    const firstB = await app.inject({ method: 'POST', url: '/v1/auth/login', headers, payload: JSON.stringify({ email: emailB, password: 'x' }) });
    expect(firstB.statusCode).not.toBe(429);
  });

  it('the 429 response includes a retry_after field', async () => {
    app = await buildCustomerLoginApp();

    const email = `rl-retry-${Date.now()}@example.com`;
    const payload = JSON.stringify({ email, password: 'x' });
    const headers = { 'content-type': 'application/json' };

    for (let i = 0; i < 10; i++) {
      await app.inject({ method: 'POST', url: '/v1/auth/login', headers, payload });
    }
    const limited = await app.inject({ method: 'POST', url: '/v1/auth/login', headers, payload });
    expect(limited.statusCode).toBe(429);
    const body = limited.json();
    expect(typeof body.retry_after).toBe('number');
    expect(body.retry_after).toBeGreaterThan(0);
    expect(body.retry_after).toBeLessThanOrEqual(15 * 60);
  });
});

// ---------------------------------------------------------------------------
// Admin login: max 5 per 15 minutes, keyed by email
// ---------------------------------------------------------------------------

describe('admin login rate limit (max 5 / 15 min per email)', () => {
  it('allows the first 5 attempts and blocks the 6th with 429', async () => {
    app = await buildAdminLoginApp();

    const email = `rl-admin-${Date.now()}@example.com`;
    const payload = JSON.stringify({ email, password: 'wrong' });
    const headers = { 'content-type': 'application/json' };

    // Requests 1-5 must pass through.
    for (let i = 1; i <= 5; i++) {
      const res = await app.inject({ method: 'POST', url: '/admin/auth/login', headers, payload });
      expect(res.statusCode, `request ${i} should not be rate-limited`).not.toBe(429);
    }

    // Request 6 must be rate-limited.
    const limited = await app.inject({ method: 'POST', url: '/admin/auth/login', headers, payload });
    expect(limited.statusCode).toBe(429);
    const body = limited.json();
    expect(body.error).toBe('rate_limited');
    expect(body.retry_after).toBeGreaterThan(0);
  });

  it('rate-limits are keyed per email: a different email has its own counter', async () => {
    app = await buildAdminLoginApp();

    const emailA = `rl-adm-a-${Date.now()}@example.com`;
    const emailB = `rl-adm-b-${Date.now()}@example.com`;
    const headers = { 'content-type': 'application/json' };

    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/admin/auth/login', headers, payload: JSON.stringify({ email: emailA, password: 'x' }) });
    }
    const limitedA = await app.inject({ method: 'POST', url: '/admin/auth/login', headers, payload: JSON.stringify({ email: emailA, password: 'x' }) });
    expect(limitedA.statusCode).toBe(429);

    const firstB = await app.inject({ method: 'POST', url: '/admin/auth/login', headers, payload: JSON.stringify({ email: emailB, password: 'x' }) });
    expect(firstB.statusCode).not.toBe(429);
  });

  it('admin limit is stricter than customer limit (5 vs 10)', () => {
    // Document the policy difference: admin accounts get fewer attempts because
    // they have broader platform access.
    expect(adminLoginRateLimitConfig.max).toBe(5);
    expect(customerLoginRateLimitConfig.max).toBe(10);
    expect(adminLoginRateLimitConfig.max).toBeLessThan(customerLoginRateLimitConfig.max);
  });
});
