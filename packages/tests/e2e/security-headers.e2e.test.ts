// E2E: HTTP security headers.
//
// Verifies that the onSend hook registered in both server.ts and buildTestApp()
// attaches the required defensive headers to every response.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './harness.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('security headers', () => {
  it('sets X-Content-Type-Options: nosniff on all responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/live' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options: DENY on all responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/live' });
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sets X-XSS-Protection: 0 on all responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/live' });
    expect(res.headers['x-xss-protection']).toBe('0');
  });

  it('sets Referrer-Policy on all responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/live' });
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('sets a locked-down Content-Security-Policy on all responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/live' });
    expect(res.headers['content-security-policy']).toBe("default-src 'none'");
  });

  it('does NOT set HSTS outside production (test env is not production)', async () => {
    // HSTS is only added when NODE_ENV === 'production' to avoid confusing local HTTPS setups.
    const res = await app.inject({ method: 'GET', url: '/live' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('attaches security headers on API routes (not just the health check)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-xss-protection']).toBe('0');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('attaches security headers on 4xx error responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/privacy/export-recipient' }); // missing auth
    expect(res.statusCode).toBe(401);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});
