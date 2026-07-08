// Integration: atomic quota reservation. Runs against live Redis (+ Postgres for
// durable seeding). Verifies that reserveQuota consumes from both daily and
// monthly counters atomically, rejects over-limit requests without partial
// consumption, and that release returns capacity. This is the correctness core
// of billing/quota enforcement and had no direct test.

import { describe, it, expect, beforeEach } from 'vitest';
import { reserveQuota, releaseQuota, getQuotaUsage } from '@platform/shared';
import { seedCustomer, resetQuota } from './e2e/harness.js';

describe('reserveQuota', () => {
  it('allows sends under the limit and reports usage', async () => {
    const c = await seedCustomer();
    await resetQuota(c.customerId);

    const d = await reserveQuota(c.customerId, 3, 100, 1000);
    expect(d.allowed).toBe(true);
    expect(d.daily_used).toBe(3);
    expect(d.monthly_used).toBe(3);
  });

  it('consumes incrementally across calls', async () => {
    const c = await seedCustomer();
    await resetQuota(c.customerId);

    await reserveQuota(c.customerId, 2, 100, 1000);
    const d = await reserveQuota(c.customerId, 5, 100, 1000);
    expect(d.allowed).toBe(true);
    expect(d.daily_used).toBe(7);
  });

  it('rejects when the daily limit would be exceeded, consuming nothing', async () => {
    const c = await seedCustomer();
    await resetQuota(c.customerId);

    const d = await reserveQuota(c.customerId, 5, 3, 1000);
    expect(d.allowed).toBe(false);
    expect(d.exceeded).toBe('daily');

    // Nothing consumed — a subsequent in-limit request still succeeds fully.
    const ok = await reserveQuota(c.customerId, 3, 3, 1000);
    expect(ok.allowed).toBe(true);
    expect(ok.daily_used).toBe(3);
  });

  it('rejects when the monthly limit would be exceeded', async () => {
    const c = await seedCustomer();
    await resetQuota(c.customerId);

    const d = await reserveQuota(c.customerId, 10, 1000, 5);
    expect(d.allowed).toBe(false);
    expect(d.exceeded).toBe('monthly');
  });

  it('enforces the boundary exactly (at-limit allowed, one-over rejected)', async () => {
    const c = await seedCustomer();
    await resetQuota(c.customerId);

    const atLimit = await reserveQuota(c.customerId, 10, 10, 1000);
    expect(atLimit.allowed).toBe(true);

    const oneOver = await reserveQuota(c.customerId, 1, 10, 1000);
    expect(oneOver.allowed).toBe(false);
  });

  it('releaseQuota returns capacity after a reservation', async () => {
    const c = await seedCustomer();
    await resetQuota(c.customerId);

    await reserveQuota(c.customerId, 8, 10, 1000);
    await releaseQuota(c.customerId, 5);

    const usage = await getQuotaUsage(c.customerId);
    expect(usage.daily_used).toBe(3);
  });

  it('handles concurrent reservations without overselling', async () => {
    const c = await seedCustomer();
    await resetQuota(c.customerId);
    // Warm the counter (one reservation of 0 would not seed; do a real seed via
    // a tiny reservation then reset usage to a known baseline) so all concurrent
    // calls hit a warm key and we're testing the atomic INCR boundary, not the
    // cold-start seeding race.
    await reserveQuota(c.customerId, 0 + 1, 1000, 100000); // seeds + consumes 1
    await releaseQuota(c.customerId, 1); // back to 0 used, key now warm

    // Fire 10 concurrent single-send reservations against a limit of 6.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserveQuota(c.customerId, 1, 6, 100000))
    );
    const allowed = results.filter((r) => r.allowed).length;
    // Atomic Lua check-and-incr: exactly 6 pass, never more, never fewer.
    expect(allowed).toBe(6);
  });

  it('releasing more than reserved floors usage at zero (no underflow)', async () => {
    const c = await seedCustomer();
    await resetQuota(c.customerId);
    await reserveQuota(c.customerId, 2, 1000, 100000); // used = 2

    // Over-release (e.g. a buggy double-release of 5 against 2 reserved).
    await releaseQuota(c.customerId, 5);

    const usage = await getQuotaUsage(c.customerId);
    // Must clamp at 0, never go negative — a negative counter would silently
    // grant extra send capacity beyond the customer's limit.
    expect(usage.daily_used).toBe(0);
    expect(usage.monthly_used).toBe(0);

    // And a fresh reservation against a limit of 3 still admits exactly 3.
    const after = await Promise.all(
      Array.from({ length: 5 }, () => reserveQuota(c.customerId, 1, 3, 100000))
    );
    expect(after.filter((r) => r.allowed).length).toBe(3);
  });
});
