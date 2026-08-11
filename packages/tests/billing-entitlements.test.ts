import { describe, it, expect } from 'vitest';
import { db, evaluateBillingAccess, hasEntitlement, seedCustomer } from '@platform/shared';

describe('billing access and entitlements', () => {
  it('allows active customers and resolves catalog features', async () => {
    const customer = await seedCustomer({ tier: 'enterprise' });
    await db.insertInto('subscriptions').values({
      customer_id: customer.customerId, provider: 'stripe', provider_subscription_id: `sub-${Date.now()}`,
      plan: 'enterprise', status: 'active', price_id: null,
    }).execute();
    expect(await evaluateBillingAccess(customer.customerId)).toMatchObject({ allowed: true, plan: 'enterprise' });
    expect(await hasEntitlement(customer.customerId, 'sso')).toBe(true);
  });

  it('allows past-due customers only within their grace window', async () => {
    const customer = await seedCustomer({ billingStatus: 'past_due' });
    await db.insertInto('billing_dunning_state').values({
      customer_id: customer.customerId, state: 'grace', grace_ends_at: new Date(Date.now() + 60_000), failure_count: 1,
    }).execute();
    expect(await evaluateBillingAccess(customer.customerId)).toMatchObject({ allowed: true });
    await db.updateTable('billing_dunning_state').set({ grace_ends_at: new Date(Date.now() - 1000) }).where('customer_id', '=', customer.customerId).execute();
    expect(await evaluateBillingAccess(customer.customerId)).toMatchObject({ allowed: false, reason: 'grace_expired' });
  });

  it('blocks restricted and canceled accounts centrally', async () => {
    const restricted = await seedCustomer({ billingStatus: 'past_due' });
    await db.insertInto('billing_dunning_state').values({ customer_id: restricted.customerId, state: 'restricted', failure_count: 2 }).execute();
    expect(await evaluateBillingAccess(restricted.customerId)).toMatchObject({ allowed: false, reason: 'payment_required' });
    const canceled = await seedCustomer({ billingStatus: 'canceled' });
    expect(await evaluateBillingAccess(canceled.customerId)).toMatchObject({ allowed: false, reason: 'billing_canceled' });
  });

  it('uses the parent billing relationship for a sub-account', async () => {
    const parent = await seedCustomer({ tier: 'enterprise' });
    await db.insertInto('subscriptions').values({
      customer_id: parent.customerId, provider: 'stripe', provider_subscription_id: `sub-parent-${Date.now()}`,
      plan: 'enterprise', status: 'active', price_id: null,
    }).execute();
    const child = await db.insertInto('customers').values({
      email: `billing-child-${Date.now()}@example.test`,
      name: 'Billing child',
      status: 'active',
      billing_status: 'canceled',
      tier: 'free',
      parent_customer_id: parent.customerId,
    } as any).returning('id').executeTakeFirstOrThrow();

    expect(await evaluateBillingAccess(child.id)).toMatchObject({
      allowed: true,
      plan: 'enterprise',
    });
    expect(await hasEntitlement(child.id, 'sso')).toBe(true);
  });
});
