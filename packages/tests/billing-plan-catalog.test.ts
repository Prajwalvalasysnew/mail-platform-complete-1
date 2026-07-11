import { describe, it, expect } from 'vitest';
import { db, resolveCatalogPlan } from '@platform/shared';

describe('governed billing plan catalog', () => {
  it('resolves an active provider price to catalog quotas and tier', async () => {
    const providerPriceId = `price_live_catalog_${Date.now()}`;
    await db.insertInto('billing_plan_prices').values({
      plan_key: 'pro', provider: 'stripe', environment: 'live', provider_price_id: providerPriceId, currency: 'usd', active: true,
    }).execute();
    const plan = await resolveCatalogPlan(providerPriceId, 'stripe');
    expect(plan).toMatchObject({ plan: 'pro', tier: 'paid', daily: 50000, monthly: 1000000, providerPriceId });
  });

  it('fails closed on placeholders and inactive mappings in production', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(await resolveCatalogPlan('price_pro', 'stripe')).toBeUndefined();
      const providerPriceId = `price_inactive_catalog_${Date.now()}`;
      await db.insertInto('billing_plan_prices').values({
        plan_key: 'pro', provider: 'stripe', environment: 'live', provider_price_id: providerPriceId, active: false,
      }).execute();
      expect(await resolveCatalogPlan(providerPriceId, 'stripe')).toBeUndefined();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
