import { describe, it, expect } from 'vitest';
import { db, expirePlanChangeRequests, seedCustomer } from '@platform/shared';

describe('billing plan-change lifecycle', () => {
  it('expires stale unsubmitted previews without touching submitted requests', async () => {
    const customer = await seedCustomer();
    const base = { customer_id: customer.customerId, current_plan: 'free', target_plan: 'pro', provider: 'stripe',
      provider_price_id: `price_expiry_${Date.now()}`, direction: 'upgrade' as const, expires_at: new Date(Date.now() - 1000) };
    const preview = await db.insertInto('billing_plan_change_requests').values(base).returning('id').executeTakeFirstOrThrow();
    const submitted = await db.insertInto('billing_plan_change_requests').values({ ...base, provider_price_id: `${base.provider_price_id}_submitted`, status: 'checkout_started' }).returning('id').executeTakeFirstOrThrow();
    expect(await expirePlanChangeRequests()).toBeGreaterThanOrEqual(1);
    expect(await db.selectFrom('billing_plan_change_requests').select('status').where('id', '=', preview.id).executeTakeFirstOrThrow()).toMatchObject({ status: 'expired' });
    expect(await db.selectFrom('billing_plan_change_requests').select('status').where('id', '=', submitted.id).executeTakeFirstOrThrow()).toMatchObject({ status: 'checkout_started' });
  });
});
