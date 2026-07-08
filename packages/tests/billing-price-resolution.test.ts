// Unit tests for provider price-id -> internal plan resolution (gap analysis:
// "placeholder price IDs" in TIER_BY_PRICE). The bug: a live Stripe price id
// like "price_1P9x..." never equals the internal key "price_starter", so the
// webhook couldn't map it to a tier and the customer's quota stayed unchanged.
// resolvePlanForPrice()/isKnownPrice() add the STRIPE_PRICE_MAP_JSON bridge.

import { describe, it, expect, afterEach } from 'vitest';
import { resolvePlanForPrice, isKnownPrice, TIER_BY_PRICE } from '@platform/shared';

const ORIG = process.env.STRIPE_PRICE_MAP_JSON;
afterEach(() => {
  if (ORIG === undefined) delete process.env.STRIPE_PRICE_MAP_JSON;
  else process.env.STRIPE_PRICE_MAP_JSON = ORIG;
});

describe('resolvePlanForPrice', () => {
  it('resolves internal keys directly (self-host / tests / free default)', () => {
    expect(resolvePlanForPrice('price_starter')).toEqual(TIER_BY_PRICE['price_starter']);
    expect(resolvePlanForPrice('price_free')?.tier).toBe('free');
    expect(resolvePlanForPrice('price_enterprise')?.tier).toBe('enterprise');
  });

  it('resolves a REAL provider price id via STRIPE_PRICE_MAP_JSON (the actual bug)', () => {
    process.env.STRIPE_PRICE_MAP_JSON = JSON.stringify({
      price_1P9xAbCStarter: 'price_starter',
      price_1P9xProXyz: 'price_pro',
    });
    expect(resolvePlanForPrice('price_1P9xAbCStarter')?.plan).toBe('starter');
    expect(resolvePlanForPrice('price_1P9xProXyz')?.plan).toBe('pro');
    expect(resolvePlanForPrice('price_1P9xProXyz')?.daily).toBe(50000);
  });

  it('returns undefined for an unmapped provider id', () => {
    process.env.STRIPE_PRICE_MAP_JSON = JSON.stringify({ price_known: 'price_pro' });
    expect(resolvePlanForPrice('price_totally_unknown')).toBeUndefined();
  });

  it('returns undefined for null/undefined/empty', () => {
    expect(resolvePlanForPrice(undefined)).toBeUndefined();
    expect(resolvePlanForPrice(null)).toBeUndefined();
    expect(resolvePlanForPrice('')).toBeUndefined();
  });

  it('does not throw on malformed STRIPE_PRICE_MAP_JSON (bad env must not 500 a webhook)', () => {
    process.env.STRIPE_PRICE_MAP_JSON = '{not valid json';
    // Internal keys still resolve; unknown ids just return undefined.
    expect(() => resolvePlanForPrice('price_1P9xAbC')).not.toThrow();
    expect(resolvePlanForPrice('price_1P9xAbC')).toBeUndefined();
    expect(resolvePlanForPrice('price_pro')?.plan).toBe('pro');
  });

  it('ignores a map entry that points at a non-existent internal key', () => {
    process.env.STRIPE_PRICE_MAP_JSON = JSON.stringify({ price_x: 'price_nonexistent' });
    expect(resolvePlanForPrice('price_x')).toBeUndefined();
  });
});

describe('isKnownPrice', () => {
  it('is true for internal keys and mapped provider ids, false otherwise', () => {
    process.env.STRIPE_PRICE_MAP_JSON = JSON.stringify({ price_1P9xLive: 'price_pro' });
    expect(isKnownPrice('price_pro')).toBe(true);
    expect(isKnownPrice('price_1P9xLive')).toBe(true);
    expect(isKnownPrice('price_unmapped')).toBe(false);
    expect(isKnownPrice(undefined)).toBe(false);
  });
});
