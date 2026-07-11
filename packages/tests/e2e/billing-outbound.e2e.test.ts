// Outbound billing: checkout, portal, overview, and metered usage reporting.
// Runs against an injected MockBillingProvider so we can both drive the HTTP
// flows and assert exactly which provider calls were made — no Stripe, no network.

import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { buildTestApp } from './harness.js';
import { applySubscriptionState, db, reconcileSubmittedPlanChanges, applyScheduledDowngrades, setBillingProvider, MockBillingProvider, reportMeteredUsage } from '@platform/shared';
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

  it('rejects a caller-supplied price that is not in the server catalog', async () => {
    mock = new MockBillingProvider();
    setBillingProvider(mock);
    const c = await register(`bill-unknown-price-${Date.now()}@example.com`);
    const res = await req(c.token, 'POST', '/v1/account/billing/checkout', {
      price_id: 'price_attacker_controlled',
      ...URLS,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('unknown_price');
    expect(mock.calls).toHaveLength(0);
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/account/billing' });
    expect(res.statusCode).toBe(401);
  });

  it('lists invoice summaries and returns tenant-scoped line-item detail', async () => {
    const owner = await register(`bill-invoices-${Date.now()}@example.com`);
    const other = await register(`bill-invoices-other-${Date.now()}@example.com`);
    const invoice = await db.insertInto('invoices').values({
      customer_id: owner.customerId, provider_invoice_id: `in_api_${Date.now()}`,
      period_start: '2026-06-01', period_end: '2026-06-30', amount_cents: 12500,
      currency: 'usd', status: 'open', billed_quantity: 125,
    }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('invoice_line_items').values({
      invoice_id: invoice.id, provider_line_item_id: 'line_api', description: 'Email usage',
      quantity: 125, amount_cents: 12500, currency: 'usd',
    }).execute();

    const list = await req(owner.token, 'GET', '/v1/account/billing/invoices');
    expect(list.statusCode).toBe(200);
    expect(list.json().invoices.some((row: any) => row.id === invoice.id)).toBe(true);
    const detail = await req(owner.token, 'GET', `/v1/account/billing/invoices/${invoice.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: invoice.id, amount_cents: 12500 });
    expect(detail.json().lines).toHaveLength(1);
    expect((await req(other.token, 'GET', `/v1/account/billing/invoices/${invoice.id}`)).statusCode).toBe(404);
  });

  it('lists provider-issued credit notes scoped to the tenant', async () => {
    const owner = await register(`bill-cn-${Date.now()}@example.com`);
    const other = await register(`bill-cn-other-${Date.now()}@example.com`);
    await db.insertInto('credit_notes').values({
      customer_id: owner.customerId, provider: 'stripe', provider_credit_note_id: `cn_api_${Date.now()}`,
      amount_cents: 900, currency: 'usd', reason: 'duplicate', status: 'issued',
    }).execute();
    const list = await req(owner.token, 'GET', '/v1/account/billing/credit-notes');
    expect(list.statusCode).toBe(200);
    expect(list.json().credit_notes).toHaveLength(1);
    expect(list.json().credit_notes[0]).toMatchObject({ amount_cents: 900, reason: 'duplicate', status: 'issued' });
    // Another tenant sees none of it.
    expect((await req(other.token, 'GET', '/v1/account/billing/credit-notes')).json().credit_notes).toHaveLength(0);
  });

  it('creates a governed plan-change preview without mutating the subscription', async () => {
    const c = await register(`bill-plan-preview-${Date.now()}@example.com`);
    const preview = await req(c.token, 'POST', '/v1/account/billing/plan-change/preview', { price_id: 'price_pro' });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ current_plan: 'free', target_plan: 'pro', direction: 'upgrade', proration: { available: false, reason: 'provider_preview_required' } });
    expect(preview.json().quota_delta.monthly).toBeGreaterThan(0);
    const stored = await db.selectFrom('billing_plan_change_requests').select(['status', 'target_plan']).where('id', '=', preview.json().request_id).executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ status: 'previewed', target_plan: 'pro' });
    expect(await db.selectFrom('subscriptions').select('id').where('customer_id', '=', c.customerId).execute()).toHaveLength(0);
    expect((await req(c.token, 'POST', '/v1/account/billing/plan-change/preview', { price_id: 'price_unknown' })).statusCode).toBe(422);
  });

  it('submits a provider-prorated change and waits for webhook confirmation', async () => {
    mock = new MockBillingProvider('stripe');
    setBillingProvider(mock);
    const c = await register(`bill-plan-confirm-${Date.now()}@example.com`);
    await db.insertInto('subscriptions').values({ customer_id: c.customerId, provider: 'stripe',
      provider_subscription_id: `sub_confirm_${Date.now()}`, provider_plan_item_id: 'si_base_plan',
      plan: 'free', status: 'active', price_id: 'price_free' }).execute();
    const preview = await req(c.token, 'POST', '/v1/account/billing/plan-change/preview', { price_id: 'price_pro' });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().proration).toMatchObject({ available: true, amount_cents: 0, currency: 'usd' });
    const confirm = await req(c.token, 'POST', `/v1/account/billing/plan-change/${preview.json().request_id}/confirm`);
    expect(confirm.statusCode).toBe(202);
    expect(confirm.json().status).toBe('pending_provider_confirmation');
    expect(mock.calls.filter((call) => call.method === 'previewSubscriptionChange')).toHaveLength(1);
    expect(mock.calls.filter((call) => call.method === 'updateSubscription')).toHaveLength(1);
    expect(await db.selectFrom('customers').select('tier').where('id', '=', c.customerId).executeTakeFirstOrThrow()).toMatchObject({ tier: 'free' });
    expect(await db.selectFrom('billing_plan_change_requests').select('status').where('id', '=', preview.json().request_id).executeTakeFirstOrThrow()).toMatchObject({ status: 'checkout_started' });
    await applySubscriptionState({ provider: 'stripe', provider_event_id: `evt_plan_applied_${Date.now()}`,
      type: 'customer.subscription.updated', internal_customer_id: c.customerId,
      provider_subscription_id: (await db.selectFrom('subscriptions').select('provider_subscription_id').where('customer_id', '=', c.customerId).executeTakeFirstOrThrow()).provider_subscription_id!,
      plan_item_id: 'si_base_plan', price_id: 'price_pro', status: 'active' });
    expect(await db.selectFrom('billing_plan_change_requests').select('status').where('id', '=', preview.json().request_id).executeTakeFirstOrThrow()).toMatchObject({ status: 'applied' });
    expect(await db.selectFrom('customers').select('tier').where('id', '=', c.customerId).executeTakeFirstOrThrow()).toMatchObject({ tier: 'paid' });
  });

  it('cancels only an unsubmitted tenant-owned plan preview', async () => {
    const c = await register(`bill-plan-cancel-${Date.now()}@example.com`);
    const preview = await req(c.token, 'POST', '/v1/account/billing/plan-change/preview', { price_id: 'price_pro' });
    expect(preview.statusCode).toBe(200);
    expect((await req(c.token, 'DELETE', `/v1/account/billing/plan-change/${preview.json().request_id}`)).statusCode).toBe(204);
    expect(await db.selectFrom('billing_plan_change_requests').select('status').where('id', '=', preview.json().request_id).executeTakeFirstOrThrow()).toMatchObject({ status: 'canceled' });
    expect((await req(c.token, 'POST', `/v1/account/billing/plan-change/${preview.json().request_id}/confirm`)).statusCode).toBe(409);
  });

  it('reconciles a submitted change from authenticated provider state when webhook is missing', async () => {
    mock = new MockBillingProvider('stripe');
    setBillingProvider(mock);
    const c = await register(`bill-plan-reconcile-${Date.now()}@example.com`);
    await db.insertInto('subscriptions').values({ customer_id: c.customerId, provider: 'stripe',
      provider_subscription_id: `sub_reconcile_${Date.now()}`, provider_plan_item_id: 'si_reconcile',
      plan: 'free', status: 'active', price_id: 'price_free' }).execute();
    const preview = await req(c.token, 'POST', '/v1/account/billing/plan-change/preview', { price_id: 'price_pro' });
    expect((await req(c.token, 'POST', `/v1/account/billing/plan-change/${preview.json().request_id}/confirm`)).statusCode).toBe(202);
    const reconciled = await reconcileSubmittedPlanChanges({ staleMinutes: 0 });
    expect(reconciled.applied).toBeGreaterThanOrEqual(1);
    expect(mock.calls.some((call) => call.method === 'getSubscription')).toBe(true);
    expect(await db.selectFrom('billing_plan_change_requests').select('status').where('id', '=', preview.json().request_id).executeTakeFirstOrThrow()).toMatchObject({ status: 'applied' });
    expect(await db.selectFrom('customers').select('tier').where('id', '=', c.customerId).executeTakeFirstOrThrow()).toMatchObject({ tier: 'paid' });
  });

  // Set up a customer already on a higher (paid) plan with an active provider
  // subscription, so a change to price_free is a genuine downgrade.
  async function seedPaidCustomer(email: string, periodEnd: Date) {
    const c = await register(email);
    await db.updateTable('customers').set({ tier: 'paid', daily_quota: 100_000, monthly_quota: 1_000_000 } as any)
      .where('id', '=', c.customerId).execute();
    await db.insertInto('subscriptions').values({ customer_id: c.customerId, provider: 'stripe',
      provider_subscription_id: `sub_down_${email}`, provider_plan_item_id: 'si_down_plan',
      plan: 'paid', status: 'active', price_id: 'price_pro', current_period_end: periodEnd }).execute();
    return c;
  }

  it('schedules a downgrade at period end instead of applying it immediately', async () => {
    mock = new MockBillingProvider('stripe');
    setBillingProvider(mock);
    const periodEnd = new Date(Date.now() + 20 * 86_400_000);
    const c = await seedPaidCustomer(`bill-down-schedule-${Date.now()}@example.com`, periodEnd);
    const preview = await req(c.token, 'POST', '/v1/account/billing/plan-change/preview', { price_id: 'price_free' });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().direction).toBe('downgrade');
    const confirm = await req(c.token, 'POST', `/v1/account/billing/plan-change/${preview.json().request_id}/confirm`);
    expect(confirm.statusCode).toBe(202);
    expect(confirm.json().status).toBe('scheduled');
    expect(new Date(confirm.json().effective_at).getTime()).toBe(periodEnd.getTime());
    // The provider is NOT called to change the subscription yet, and the
    // customer keeps their paid capacity until the boundary.
    expect(mock.calls.some((call) => call.method === 'updateSubscription')).toBe(false);
    expect(await db.selectFrom('customers').select('tier').where('id', '=', c.customerId).executeTakeFirstOrThrow()).toMatchObject({ tier: 'paid' });
    expect(await db.selectFrom('billing_plan_change_requests').select('status').where('id', '=', preview.json().request_id).executeTakeFirstOrThrow()).toMatchObject({ status: 'scheduled' });
  });

  it('rolls back a scheduled downgrade before its effective date', async () => {
    mock = new MockBillingProvider('stripe');
    setBillingProvider(mock);
    const periodEnd = new Date(Date.now() + 20 * 86_400_000);
    const c = await seedPaidCustomer(`bill-down-rollback-${Date.now()}@example.com`, periodEnd);
    const preview = await req(c.token, 'POST', '/v1/account/billing/plan-change/preview', { price_id: 'price_free' });
    const requestId = preview.json().request_id;
    expect((await req(c.token, 'POST', `/v1/account/billing/plan-change/${requestId}/confirm`)).json().status).toBe('scheduled');
    // Rollback via the same cancel endpoint.
    expect((await req(c.token, 'DELETE', `/v1/account/billing/plan-change/${requestId}`)).statusCode).toBe(204);
    expect(await db.selectFrom('billing_plan_change_requests').select('status').where('id', '=', requestId).executeTakeFirstOrThrow()).toMatchObject({ status: 'canceled' });
    // A rolled-back downgrade must never be applied by the scheduler.
    await applyScheduledDowngrades(new Date(periodEnd.getTime() + 1000));
    expect(await db.selectFrom('customers').select('tier').where('id', '=', c.customerId).executeTakeFirstOrThrow()).toMatchObject({ tier: 'paid' });
  });

  it('applies a scheduled downgrade once its effective date passes', async () => {
    mock = new MockBillingProvider('stripe');
    setBillingProvider(mock);
    const periodEnd = new Date(Date.now() + 20 * 86_400_000);
    const c = await seedPaidCustomer(`bill-down-apply-${Date.now()}@example.com`, periodEnd);
    const preview = await req(c.token, 'POST', '/v1/account/billing/plan-change/preview', { price_id: 'price_free' });
    const requestId = preview.json().request_id;
    expect((await req(c.token, 'POST', `/v1/account/billing/plan-change/${requestId}/confirm`)).json().status).toBe('scheduled');
    // Before the boundary, nothing applies.
    expect((await applyScheduledDowngrades(new Date())).applied).toBe(0);
    expect(await db.selectFrom('customers').select('tier').where('id', '=', c.customerId).executeTakeFirstOrThrow()).toMatchObject({ tier: 'paid' });
    // At/after the boundary, the downgrade is submitted and finalized.
    const result = await applyScheduledDowngrades(new Date(periodEnd.getTime() + 1000));
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(mock.calls.some((call) => call.method === 'updateSubscription')).toBe(true);
    expect(await db.selectFrom('billing_plan_change_requests').select('status').where('id', '=', requestId).executeTakeFirstOrThrow()).toMatchObject({ status: 'applied' });
    expect(await db.selectFrom('customers').select('tier').where('id', '=', c.customerId).executeTakeFirstOrThrow()).toMatchObject({ tier: 'free' });
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
