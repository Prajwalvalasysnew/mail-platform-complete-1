// Persona E2E: a paid SaaS team completes its production lifecycle.
//
// owner registration -> email verification -> scoped production API key ->
// compliance/domain readiness -> governed paid upgrade -> transactional sends
// -> idempotent retry -> usage and tenant-isolated invoice visibility.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applySubscriptionState,
  db,
  MockBillingProvider,
  setBillingProvider,
} from '@platform/shared';
import {
  countMessagesTo,
  getEventTypes,
  getUsageSent,
  resetPoolWarmup,
  resetQuota,
  seedVerifiedDomain,
  startHarness,
  waitForStatus,
  type Harness,
} from '../harness.js';

let h: Harness;
let billing: MockBillingProvider;

beforeAll(async () => {
  billing = new MockBillingProvider('stripe');
  setBillingProvider(billing);
  h = await startHarness();
  await resetPoolWarmup('transactional');
});

afterAll(async () => {
  setBillingProvider(null);
  await h.close();
});

function sessionAuth(token: string) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function apiAuth(apiKey: string, idempotencyKey?: string) {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  };
}

describe('persona: paid SaaS customer', () => {
  it('upgrades, sends production traffic safely, and sees only its own billing data', async () => {
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ownerEmail = `owner-${run}@paid-saas.example.com`;

    // 1. A human owner creates both their account and their organization.
    const registration = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: ownerEmail,
        password: 'correct-horse-battery',
        name: 'Paid SaaS Owner',
        org_name: 'Paid SaaS Persona',
      },
    });
    expect(registration.statusCode).toBe(201);
    const registered = registration.json();
    const sessionToken = registered.token as string;
    const customerId = registered.customer_id as string;
    const verificationToken = registered._dev_email_verify_token as string;

    const initialBilling = await h.app.inject({
      method: 'GET', url: '/v1/account/billing', headers: sessionAuth(sessionToken),
    });
    expect(initialBilling.statusCode).toBe(200);
    expect(initialBilling.json()).toMatchObject({
      tier: 'free', plan: 'free', daily_quota: 100, monthly_quota: 3000,
    });

    // 2. The owner creates a least-privilege production integration key.
    const keyResponse = await h.app.inject({
      method: 'POST',
      url: '/v1/account/api-keys',
      headers: sessionAuth(sessionToken),
      payload: {
        name: 'Production transactional service',
        key_type: 'secret',
        scopes: ['send', 'messages', 'domains'],
      },
    });
    expect(keyResponse.statusCode).toBe(201);
    const apiKey = keyResponse.json().api_key as string;
    expect(apiKey).toMatch(/^mp_live_/);

    const profileUpdate = await h.app.inject({
      method: 'PATCH',
      url: '/v1/profile',
      headers: apiAuth(apiKey),
      payload: { physical_address: '500 SaaS Avenue, San Francisco, CA 94107' },
    });
    expect(profileUpdate.statusCode).toBe(200);

    // DNS is an external system, so this models the completed DNS check while
    // retaining the real API/database/queue/worker path for every send.
    const domain = await seedVerifiedDomain(customerId, `paid-${run}.example.com`);
    const welcomePayload = {
      from: `notifications@${domain}`,
      to: 'new-customer@example.net',
      subject: 'Welcome to the product',
      html: '<p>Your workspace is ready.</p>',
      tags: ['persona', 'paid-saas', 'welcome'],
    };

    const blocked = await h.app.inject({
      method: 'POST', url: '/v1/send', headers: apiAuth(apiKey), payload: welcomePayload,
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('email_not_verified');

    // The owner's verification also verifies their matching initial org, which
    // is the identity used by production API keys.
    const verify = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token: verificationToken },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().ok).toBe(true);
    expect((await db.selectFrom('customers').select('email_verified_at')
      .where('id', '=', customerId).executeTakeFirstOrThrow()).email_verified_at).toBeTruthy();

    // 3. The owner previews and confirms a provider-governed Pro upgrade. The
    // account changes only after the authenticated provider state arrives.
    const providerSubscriptionId = `sub_persona_${run}`;
    await db.insertInto('subscriptions').values({
      customer_id: customerId,
      provider: 'stripe',
      provider_subscription_id: providerSubscriptionId,
      provider_plan_item_id: 'si_persona_base',
      plan: 'free',
      status: 'active',
      price_id: 'price_free',
    }).execute();

    const preview = await h.app.inject({
      method: 'POST',
      url: '/v1/account/billing/plan-change/preview',
      headers: sessionAuth(sessionToken),
      payload: { price_id: 'price_pro' },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      current_plan: 'free', target_plan: 'pro', direction: 'upgrade',
    });

    const requestId = preview.json().request_id as string;
    const confirm = await h.app.inject({
      method: 'POST',
      url: `/v1/account/billing/plan-change/${requestId}/confirm`,
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(confirm.statusCode).toBe(202);
    expect(confirm.json().status).toBe('pending_provider_confirmation');
    expect(billing.calls.some((call) => call.method === 'previewSubscriptionChange')).toBe(true);
    expect(billing.calls.some((call) => call.method === 'updateSubscription')).toBe(true);

    await applySubscriptionState({
      provider: 'stripe',
      provider_event_id: `evt_persona_upgrade_${run}`,
      type: 'customer.subscription.updated',
      internal_customer_id: customerId,
      provider_subscription_id: providerSubscriptionId,
      plan_item_id: 'si_persona_base',
      price_id: 'price_pro',
      status: 'active',
    });

    const paidCustomer = await db.selectFrom('customers')
      .select(['tier', 'daily_quota', 'monthly_quota'])
      .where('id', '=', customerId)
      .executeTakeFirstOrThrow();
    expect(paidCustomer).toMatchObject({
      tier: 'paid', daily_quota: 50_000, monthly_quota: 1_000_000,
    });
    expect(await db.selectFrom('billing_plan_change_requests').select('status')
      .where('id', '=', requestId).executeTakeFirstOrThrow()).toMatchObject({ status: 'applied' });

    // 4. Production traffic includes multiple transactional message types. A
    // network retry with the same idempotency key returns the original result.
    await resetQuota(customerId);
    const idempotencyKey = `welcome-${run}`;
    const welcome = await h.app.inject({
      method: 'POST', url: '/v1/send', headers: apiAuth(apiKey, idempotencyKey), payload: welcomePayload,
    });
    expect(welcome.statusCode).toBe(202);
    const welcomeRetry = await h.app.inject({
      method: 'POST', url: '/v1/send', headers: apiAuth(apiKey, idempotencyKey), payload: welcomePayload,
    });
    expect(welcomeRetry.statusCode).toBe(202);
    expect(welcomeRetry.json()).toEqual(welcome.json());
    expect(await countMessagesTo(customerId, 'new-customer@example.net')).toBe(1);

    const otp = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: apiAuth(apiKey, `otp-${run}`),
      payload: {
        from: `security@${domain}`,
        to: 'returning-user@example.net',
        subject: 'Your sign-in code',
        text: 'Your one-time code is 482193.',
        tags: ['persona', 'paid-saas', 'otp'],
      },
    });
    expect(otp.statusCode).toBe(202);

    const invoiceMail = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: apiAuth(apiKey, `invoice-${run}`),
      payload: {
        from: `billing@${domain}`,
        to: ['finance@example.net', 'buyer@example.net'],
        subject: 'Your monthly invoice',
        html: '<p>Your invoice is ready.</p>',
        tags: ['persona', 'paid-saas', 'invoice'],
      },
    });
    expect(invoiceMail.statusCode).toBe(202);
    expect(invoiceMail.json().accepted).toBe(2);

    const messageIds = [
      ...(welcome.json().message_ids as string[]),
      ...(otp.json().message_ids as string[]),
      ...(invoiceMail.json().message_ids as string[]),
    ];
    expect(messageIds).toHaveLength(4);
    for (const messageId of messageIds) {
      expect(['accepted', 'sent']).toContain(await waitForStatus(messageId, ['accepted', 'sent']));
      expect(await getEventTypes(messageId)).toEqual(expect.arrayContaining(['queued', 'sent']));
    }
    expect(await getUsageSent(customerId)).toBe(4);

    const quota = await h.app.inject({ method: 'GET', url: '/v1/usage/quota', headers: apiAuth(apiKey) });
    expect(quota.statusCode).toBe(200);
    expect(quota.json()).toMatchObject({
      daily: { used: 4, limit: 50_000, remaining: 49_996 },
      monthly: { used: 4, limit: 1_000_000, remaining: 999_996 },
    });
    const usage = await h.app.inject({ method: 'GET', url: '/v1/usage?days=7', headers: apiAuth(apiKey) });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().totals.sent).toBe(4);

    // 5. The owner's invoice appears in their console and remains invisible to
    // another authenticated tenant.
    const invoice = await db.insertInto('invoices').values({
      customer_id: customerId,
      provider_invoice_id: `in_persona_${run}`,
      period_start: new Date('2026-06-01T00:00:00.000Z'),
      period_end: new Date('2026-07-01T00:00:00.000Z'),
      amount_cents: 12_500,
      currency: 'usd',
      status: 'open',
      billed_quantity: 4,
    }).returning('id').executeTakeFirstOrThrow();
    await db.insertInto('invoice_line_items').values({
      invoice_id: invoice.id,
      provider_line_item_id: `line_persona_${run}`,
      description: 'Transactional email usage',
      quantity: 4,
      amount_cents: 12_500,
      currency: 'usd',
    }).execute();

    const invoices = await h.app.inject({
      method: 'GET', url: '/v1/account/billing/invoices', headers: sessionAuth(sessionToken),
    });
    expect(invoices.statusCode).toBe(200);
    expect(invoices.json().invoices.some((row: { id: string }) => row.id === invoice.id)).toBe(true);
    const detail = await h.app.inject({
      method: 'GET', url: `/v1/account/billing/invoices/${invoice.id}`, headers: sessionAuth(sessionToken),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: invoice.id, amount_cents: 12_500 });
    expect(detail.json().lines).toHaveLength(1);

    const otherRegistration = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: `other-${run}@example.com`,
        password: 'correct-horse-battery',
        name: 'Other Tenant Owner',
        org_name: 'Other Tenant',
      },
    });
    expect(otherRegistration.statusCode).toBe(201);
    const isolated = await h.app.inject({
      method: 'GET',
      url: `/v1/account/billing/invoices/${invoice.id}`,
      headers: sessionAuth(otherRegistration.json().token),
    });
    expect(isolated.statusCode).toBe(404);
  }, 60_000);
});
