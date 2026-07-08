// Outbound billing: checkout, portal, overview, and metered usage reporting.
// Runs against an injected MockBillingProvider so we can both drive the HTTP
// flows and assert exactly which provider calls were made — no Stripe, no network.

import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { buildTestApp } from './harness.js';
import { db, setBillingProvider, MockBillingProvider, reportMeteredUsage } from '@platform/shared';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let mock: MockBillingProvider;

beforeAll(async () => {
  app = await buildTestApp();
});
afterAll(async () => {
  setBillingProvider(null); // restore default for other suites
  await app.close();
});
afterEach(() => {
  setBillingProvider(null);
});

async function register(email: string) {
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/register', headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: 'Owner', org_name: 'Org' },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token as string, customerId: body.customer_id as string };
}

function req(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { payload } : {}) });
}

const URLS = { success_url: 'https://app.example.com/ok', cancel_url: 'https://app.example.com/cancel' };

describe('outbound billing', () => {
  it('reports billing overview', async () => {
    setBillingProvider(new MockBillingProvider());
    const c = await register(`bill-ov-${Date.now()}@example.com`);
    const res = await req(c.token, 'GET', '/v1/account/billing');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tier).toBe('free');
    expect(body.has_billing_account).toBe(false);
  });

  it('starts checkout, provisioning and persisting a provider customer exactly once', async () => {
    mock = new MockBillingProvider();
    setBillingProvider(mock);
    const c = await register(`bill-co-${Date.now()}@example.com`);

    const res = await req(c.token, 'POST', '/v1/account/billing/checkout', { price_id: 'price_pro', ...URLS });
    expect(res.statusCode).toBe(201);
    expect(res.json().url).toContain('checkout');

    // stripe_customer_id persisted
    const row = await db.selectFrom('customers').select('stripe_customer_id').where('id', '=', c.customerId).executeTakeFirstOrThrow();
    expect(row.stripe_customer_id).toBeTruthy();

    // Second checkout reuses the same provider customer (no duplicate createCustomer)
    const res2 = await req(c.token, 'POST', '/v1/account/billing/checkout', { price_id: 'price_pro', ...URLS });
    expect(res2.statusCode).toBe(201);

    const createCustomerCalls = mock.calls.filter((x) => x.method === 'createCustomer');
    const checkoutCalls = mock.calls.filter((x) => x.method === 'createCheckoutSession');
    expect(createCustomerCalls.length).toBe(1);
    expect(checkoutCalls.length).toBe(2);
  });

  it('opens a billing portal session', async () => {
    setBillingProvider(new MockBillingProvider());
    const c = await register(`bill-portal-${Date.now()}@example.com`);
    const res = await req(c.token, 'POST', '/v1/account/billing/portal', { return_url: 'https://app.example.com/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toContain('portal');
  });

  it('validates request bodies', async () => {
    setBillingProvider(new MockBillingProvider());
    const c = await register(`bill-val-${Date.now()}@example.com`);
    const res = await req(c.token, 'POST', '/v1/account/billing/checkout', { price_id: 'price_pro', success_url: 'not-a-url', cancel_url: 'also-bad' });
    expect(res.statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/account/billing' });
    expect(res.statusCode).toBe(401);
  });

  it('reports metered usage (delivered count) to the provider', async () => {
    mock = new MockBillingProvider();
    setBillingProvider(mock);
    const c = await register(`bill-meter-${Date.now()}@example.com`);

    // Customer has a metered subscription item (normally set via webhook) and a day of usage.
    await db.updateTable('customers').set({ stripe_subscription_item_id: 'si_test_123' } as any).where('id', '=', c.customerId).execute();
    const day = '2026-01-15';
    await db.insertInto('usage_daily').values({ customer_id: c.customerId, usage_date: day, sent: 120, delivered: 117 } as any).execute();

    const qty = await reportMeteredUsage({ customerId: c.customerId, usageDate: day });
    expect(qty).toBe(117);
    const usageCalls = mock.calls.filter((x) => x.method === 'reportUsage');
    expect(usageCalls.length).toBe(1);
    expect((usageCalls[0].input as any).subscriptionItemId).toBe('si_test_123');
    expect((usageCalls[0].input as any).quantity).toBe(117);
  });

  it('skips metered reporting when no subscription item is known', async () => {
    mock = new MockBillingProvider();
    setBillingProvider(mock);
    const c = await register(`bill-nometer-${Date.now()}@example.com`);
    const qty = await reportMeteredUsage({ customerId: c.customerId, usageDate: '2026-01-15' });
    expect(qty).toBeNull();
    expect(mock.calls.filter((x) => x.method === 'reportUsage').length).toBe(0);
  });
});
