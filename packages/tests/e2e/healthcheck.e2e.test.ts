import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './harness.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('T5 readiness checks', () => {
  it('GET /live returns 200 immediately (no dep checks)', async () => {
    const res = await app.inject({ method: 'GET', url: '/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('GET /health returns 200 with per-dependency results when all healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.postgres.ok).toBe(true);
    expect(body.checks.redis.ok).toBe(true);
    expect(body.checks.queue.ok).toBe(true);
    expect(body.ts).toBeTruthy();
  });

  it('GET /ready returns 200 with ready status when all healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.checks.postgres.ok).toBe(true);
    expect(body.checks.redis.ok).toBe(true);
    expect(body.checks.queue.ok).toBe(true);
  });

  it('GET /health returns structured check map with ok boolean per dependency', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const { checks } = res.json();
    for (const [name, check] of Object.entries(checks as Record<string, any>)) {
      expect(typeof check.ok).toBe('boolean', `${name}.ok should be boolean`);
    }
  });

  it('GET /metrics returns prometheus text format', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });
});
