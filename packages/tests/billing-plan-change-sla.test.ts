import { describe, it, expect } from 'vitest';
import { db, countStuckPlanChanges, seedCustomer } from '@platform/shared';

// Operator SLA guard: a plan-change request submitted to the provider
// (status='checkout_started') that is never applied/reconciled must be counted
// as an SLA breach once it ages past the window, so the scheduler can publish
// mp_billing_stuck_requests and page an operator (BillingPlanChangeStuck alert).
describe('billing plan-change operator SLA', () => {
  it('counts only submitted requests older than the SLA window', async () => {
    const customer = await seedCustomer();
    const base = {
      customer_id: customer.customerId, current_plan: 'free', target_plan: 'pro', provider: 'stripe',
      direction: 'upgrade' as const, expires_at: new Date(Date.now() + 60_000),
    };
    const oldTs = new Date(Date.now() - 90 * 60_000); // 90 min ago — past the 60m SLA

    // Measure as a delta: the count is global, but the shared test DB may hold
    // unrelated rows, so we assert the change our inserts cause.
    const before = await countStuckPlanChanges(60);

    // Stuck: submitted 90 minutes ago and never applied.
    await db.insertInto('billing_plan_change_requests')
      .values({ ...base, provider_price_id: `price_sla_stuck_${Date.now()}`, status: 'checkout_started', updated_at: oldTs })
      .execute();
    // Fresh submission — within the SLA window, must NOT count.
    await db.insertInto('billing_plan_change_requests')
      .values({ ...base, provider_price_id: `price_sla_fresh_${Date.now()}`, status: 'checkout_started', updated_at: new Date() })
      .execute();
    // Old but only previewed (never submitted) — not an SLA breach.
    await db.insertInto('billing_plan_change_requests')
      .values({ ...base, provider_price_id: `price_sla_preview_${Date.now()}`, status: 'previewed', updated_at: oldTs })
      .execute();

    const after = await countStuckPlanChanges(60);
    expect(after - before).toBe(1);
  });

  it('does not flag a submitted request that is still inside the SLA window', async () => {
    const customer = await seedCustomer();
    const before = await countStuckPlanChanges(60);
    await db.insertInto('billing_plan_change_requests')
      .values({ customer_id: customer.customerId, current_plan: 'free', target_plan: 'pro', provider: 'stripe',
        provider_price_id: `price_sla_recent_${Date.now()}`, direction: 'upgrade', status: 'checkout_started',
        updated_at: new Date(Date.now() - 5 * 60_000), expires_at: new Date(Date.now() + 60_000) })
      .execute();
    expect(await countStuckPlanChanges(60)).toBe(before);
  });
});
