import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './harness.js';
import { db, getBillingProviderFor, MockBillingProvider, registerBillingProvider, setBillingProvider } from '@platform/shared';

let app: FastifyInstance;
const originalStripeSecret = process.env.STRIPE_WEBHOOK_SECRET;
const originalPayPalSecret = process.env.PAYPAL_WEBHOOK_SECRET;
const originalCashfreeSecret = process.env.CASHFREE_WEBHOOK_SECRET;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  process.env.STRIPE_WEBHOOK_SECRET = originalStripeSecret;
  process.env.PAYPAL_WEBHOOK_SECRET = originalPayPalSecret;
  process.env.CASHFREE_WEBHOOK_SECRET = originalCashfreeSecret;
  setBillingProvider(null);
  await app.close();
});

afterEach(() => {
  process.env.STRIPE_WEBHOOK_SECRET = originalStripeSecret;
  process.env.PAYPAL_WEBHOOK_SECRET = originalPayPalSecret;
  process.env.CASHFREE_WEBHOOK_SECRET = originalCashfreeSecret;
  setBillingProvider(null);
});

async function register(email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: 'Owner', org_name: 'Org' },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token as string, customerId: body.customer_id as string };
}

function authReq(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as any,
    url,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  });
}

function stripeSignature(payload: string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

function cashfreeHeaders(payload: string, secret: string) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', secret).update(timestamp + payload).digest('base64');
  return { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': sig };
}

function paypalHeaders(payload: string, secret: string) {
  const transmissionId = `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const transmissionTime = new Date().toISOString();
  const sig = crypto.createHmac('sha256', secret).update(`${transmissionId}.${transmissionTime}.${payload}`).digest('base64');
  return {
    'paypal-transmission-id': transmissionId,
    'paypal-transmission-time': transmissionTime,
    'paypal-transmission-sig': sig,
  };
}

const URLS = { success_url: 'https://app.example.com/ok', cancel_url: 'https://app.example.com/cancel' };

describe('multi-provider billing', () => {
  it('routes checkout by the customer billing_provider', async () => {
    const stripe = new MockBillingProvider('stripe');
    const paypal = new MockBillingProvider('paypal');
    registerBillingProvider('stripe', () => stripe);
    registerBillingProvider('paypal', () => paypal);

    const stripeCustomer = await register(`bill-multi-stripe-${Date.now()}@example.com`);
    const paypalCustomer = await register(`bill-multi-paypal-${Date.now()}@example.com`);
    await db.updateTable('customers').set({ billing_provider: 'paypal' } as any).where('id', '=', paypalCustomer.customerId).execute();

    const s = await authReq(stripeCustomer.token, 'POST', '/v1/account/billing/checkout', { price_id: 'price_pro', ...URLS });
    const p = await authReq(paypalCustomer.token, 'POST', '/v1/account/billing/checkout', { price_id: 'price_pro', ...URLS });

    expect(s.statusCode).toBe(201);
    expect(p.statusCode).toBe(201);
    expect(s.json().url).toContain('/stripe/checkout/');
    expect(p.json().url).toContain('/paypal/checkout/');
    expect(stripe.calls.filter((c) => c.method === 'createCheckoutSession')).toHaveLength(1);
    expect(paypal.calls.filter((c) => c.method === 'createCheckoutSession')).toHaveLength(1);
  });

  it('caches distinct registry instances per provider and rejects unknown providers', async () => {
    let stripeCreates = 0;
    let paypalCreates = 0;
    registerBillingProvider('stripe', () => {
      stripeCreates += 1;
      return new MockBillingProvider('stripe');
    });
    registerBillingProvider('paypal', () => {
      paypalCreates += 1;
      return new MockBillingProvider('paypal');
    });

    const s1 = getBillingProviderFor('stripe');
    const s2 = getBillingProviderFor('stripe');
    const p1 = getBillingProviderFor('paypal');

    expect(s1).toBe(s2);
    expect(s1).not.toBe(p1);
    expect(stripeCreates).toBe(1);
    expect(paypalCreates).toBe(1);
    expect(() => getBillingProviderFor('does-not-exist')).toThrow(/unknown_billing_provider/);
  });

  it('accepts valid Stripe webhook signatures and rejects invalid signatures', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'stripe-webhook-secret';
    const c = await register(`bill-wh-stripe-${Date.now()}@example.com`);
    const providerCustomerId = `cus_webhook_${c.customerId}`;
    const providerSubscriptionId = `sub_stripe_${crypto.randomUUID()}`;
    await db.updateTable('customers').set({ billing_provider: 'stripe', stripe_customer_id: providerCustomerId } as any).where('id', '=', c.customerId).execute();

    const payload = JSON.stringify({
      id: `evt_stripe_${crypto.randomUUID()}`,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: providerSubscriptionId,
          customer: providerCustomerId,
          status: 'active',
          current_period_start: Math.floor(Date.now() / 1000),
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          items: { data: [{ id: 'si_metered_123', price: { id: 'price_pro', recurring: { usage_type: 'metered' } } }] },
        },
      },
    });

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignature(payload, process.env.STRIPE_WEBHOOK_SECRET) },
      payload,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().applied).toBe(true);

    const row = await db.selectFrom('customers').select(['tier', 'stripe_subscription_item_id']).where('id', '=', c.customerId).executeTakeFirstOrThrow();
    expect(row.tier).toBe('paid');
    expect(row.stripe_subscription_item_id).toBe('si_metered_123');

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' },
      payload,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_signature');
  });

  it('accepts valid PayPal webhook signatures and rejects invalid signatures', async () => {
    process.env.PAYPAL_WEBHOOK_SECRET = 'paypal-webhook-secret';
    const c = await register(`bill-wh-paypal-${Date.now()}@example.com`);
    const providerCustomerId = `payer_webhook_${c.customerId}`;
    const providerSubscriptionId = `sub_paypal_${crypto.randomUUID()}`;
    await db.updateTable('customers').set({ billing_provider: 'paypal', stripe_customer_id: providerCustomerId } as any).where('id', '=', c.customerId).execute();

    const payload = JSON.stringify({
      id: `evt_paypal_${crypto.randomUUID()}`,
      event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resource: {
        id: providerSubscriptionId,
        plan_id: 'price_pro',
        status: 'ACTIVE',
        start_time: new Date().toISOString(),
        subscriber: { payer_id: providerCustomerId },
      },
    });

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook/paypal',
      headers: { 'content-type': 'application/json', ...paypalHeaders(payload, process.env.PAYPAL_WEBHOOK_SECRET) },
      payload,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().applied).toBe(true);

    const row = await db.selectFrom('customers').select(['tier', 'billing_provider']).where('id', '=', c.customerId).executeTakeFirstOrThrow();
    expect(row.tier).toBe('paid');
    expect(row.billing_provider).toBe('paypal');

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook/paypal',
      headers: { 'content-type': 'application/json', 'paypal-transmission-id': 'bad', 'paypal-transmission-time': new Date().toISOString(), 'paypal-transmission-sig': 'bad' },
      payload,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_signature');
  });

  it('accepts valid Cashfree webhook signatures and rejects invalid signatures', async () => {
    process.env.CASHFREE_WEBHOOK_SECRET = 'cashfree-webhook-secret';
    const c = await register(`bill-wh-cashfree-${Date.now()}@example.com`);
    const providerCustomerId = `cf_cus_webhook_${c.customerId}`;
    const providerSubscriptionId = `sub_cf_${crypto.randomUUID()}`;
    await db.updateTable('customers').set({ billing_provider: 'cashfree' as any, stripe_customer_id: providerCustomerId } as any).where('id', '=', c.customerId).execute();

    const eventTime = new Date().toISOString();
    const payload = JSON.stringify({
      event_type: 'SUBSCRIPTION_ACTIVATED',
      event_time: eventTime,
      data: {
        subscription: {
          subscription_id: providerSubscriptionId,
          plan_id: 'price_pro',
          subscription_status: 'ACTIVE',
          customer_details: { customer_id: providerCustomerId },
          subscription_first_charge_time: new Date().toISOString(),
          subscription_expiry_time: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
        },
      },
    });

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook/cashfree',
      headers: { 'content-type': 'application/json', ...cashfreeHeaders(payload, process.env.CASHFREE_WEBHOOK_SECRET) },
      payload,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().applied).toBe(true);

    const row = await db.selectFrom('customers').select(['tier', 'billing_provider']).where('id', '=', c.customerId).executeTakeFirstOrThrow();
    expect(row.tier).toBe('paid');
    expect(row.billing_provider).toBe('cashfree');

    const bad = await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook/cashfree',
      headers: { 'content-type': 'application/json', 'x-webhook-timestamp': '1', 'x-webhook-signature': 'badsig' },
      payload,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_signature');
  });

  it('falls back to internal_customer_id when PayPal payer_id differs from stored id', async () => {
    process.env.PAYPAL_WEBHOOK_SECRET = 'paypal-webhook-secret-fallback';
    const c = await register(`bill-wh-paypal-fallback-${Date.now()}@example.com`);
    // Simulate production: stripe_customer_id stores our synthetic hash, not the real payer_id
    await db.updateTable('customers').set({ billing_provider: 'paypal' as any, stripe_customer_id: `paypal_payer_synth_${c.customerId}` } as any).where('id', '=', c.customerId).execute();

    const realPayPalPayerId = `REAL_PAYPAL_${crypto.randomUUID().replace(/-/g, '').slice(0, 13)}`;
    const providerSubscriptionId = `sub_paypal_fallback_${crypto.randomUUID()}`;

    const payload = JSON.stringify({
      id: `evt_paypal_fallback_${crypto.randomUUID()}`,
      event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      resource: {
        id: providerSubscriptionId,
        plan_id: 'price_starter',
        status: 'ACTIVE',
        start_time: new Date().toISOString(),
        // real PayPal payer_id — does NOT match stripe_customer_id
        subscriber: { payer_id: realPayPalPayerId },
        // custom_id is the internal UUID we passed at checkout creation
        custom_id: c.customerId,
      },
    });

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook/paypal',
      headers: { 'content-type': 'application/json', ...paypalHeaders(payload, process.env.PAYPAL_WEBHOOK_SECRET) },
      payload,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().applied).toBe(true);

    const row = await db.selectFrom('customers').select('tier').where('id', '=', c.customerId).executeTakeFirstOrThrow();
    expect(row.tier).toBe('paid');
  });
});
