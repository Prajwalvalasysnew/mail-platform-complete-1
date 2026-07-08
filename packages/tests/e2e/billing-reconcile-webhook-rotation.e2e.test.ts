// E2E: T7 billing reconciliation admin endpoint + T8 API-key webhook secret rotation.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedAdminSession } from './harness.js';
import { createWebhook } from '@platform/shared';

let app: FastifyInstance;
let operatorToken: string;
let supportToken: string;

beforeAll(async () => {
  app = await buildTestApp();
  operatorToken = (await seedAdminSession('operator')).token;
  supportToken = (await seedAdminSession('support')).token;
});

afterAll(async () => {
  await app.close();
});

function adminReq(method: string, url: string, payload?: unknown, token = operatorToken) {
  return app.inject({
    method: method as any,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { payload } : {}),
  });
}

function apiReq(apiKey: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as any,
    url,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { payload } : {}),
  });
}

// ─── T7: Billing reconciliation alerting ─────────────────────────────────────

describe('T7 billing reconciliation admin endpoint', () => {
  it('POST /admin/billing/reconcile returns drift report for operator', async () => {
    const res = await adminReq('POST', '/admin/billing/reconcile');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.total_drift).toBe('number');
    expect(Array.isArray(body.by_customer)).toBe(true);
    expect(['clean', 'drift_detected']).toContain(body.alert);
  });

  it('result shape is consistent across calls', async () => {
    const r1 = await adminReq('POST', '/admin/billing/reconcile');
    const r2 = await adminReq('POST', '/admin/billing/reconcile');
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    // total_drift is deterministic for a given DB state — both calls agree.
    expect(r1.json().total_drift).toBe(r2.json().total_drift);
    expect(r1.json().alert).toBe(r2.json().alert);
  });

  it('enforces operator RBAC', async () => {
    const noAuth = await app.inject({ method: 'POST', url: '/admin/billing/reconcile' });
    expect(noAuth.statusCode).toBe(401);

    const support = await adminReq('POST', '/admin/billing/reconcile', undefined, supportToken);
    expect(support.statusCode).toBe(403);
    expect(support.json().error).toBe('insufficient_role');
  });
});

// ─── T8: API-key webhook secret rotation ──────────────────────────────────────

describe('T8 API-key webhook secret rotation', () => {
  it('POST /v1/webhooks/:id/rotate-secret returns new secret', async () => {
    const { customerId, apiKey } = await seedCustomer();
    const wh = await createWebhook({
      customerId,
      url: 'https://93.184.216.34/hook',
      events: ['delivered'],
    });
    const oldSecret = wh.secret;

    const res = await apiReq(apiKey, 'POST', `/v1/webhooks/${wh.id}/rotate-secret`);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe(wh.id);
    expect(body.secret).toBeTruthy();
    expect(body.secret).not.toBe(oldSecret);
    expect(typeof body.note).toBe('string');
  });

  it('calling rotate-secret twice produces different secrets each time', async () => {
    const { customerId, apiKey } = await seedCustomer();
    const wh = await createWebhook({
      customerId,
      url: 'https://93.184.216.34/hook2',
      events: ['hard_bounce'],
    });

    const first = await apiReq(apiKey, 'POST', `/v1/webhooks/${wh.id}/rotate-secret`);
    const second = await apiReq(apiKey, 'POST', `/v1/webhooks/${wh.id}/rotate-secret`);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().secret).not.toBe(second.json().secret);
  });

  it('returns 404 for a webhook in a different org', async () => {
    const { apiKey: keyA } = await seedCustomer();
    const { customerId: custB } = await seedCustomer();
    const whB = await createWebhook({
      customerId: custB,
      url: 'https://93.184.216.34/hook3',
      events: ['delivered'],
    });

    const res = await apiReq(keyA, 'POST', `/v1/webhooks/${whB.id}/rotate-secret`);
    expect(res.statusCode).toBe(404);
  });

  it('requires webhooks scope', async () => {
    const { customerId, apiKey } = await seedCustomer({ scopes: ['send'] });
    const wh = await createWebhook({
      customerId,
      url: 'https://93.184.216.34/hook4',
      events: ['delivered'],
    });
    const res = await apiReq(apiKey, 'POST', `/v1/webhooks/${wh.id}/rotate-secret`);
    expect(res.statusCode).toBe(403);
  });
});
