// Integration: suppression list (Redis cache + Postgres fallback) and
// soft-bounce escalation. Runs against live Postgres + Redis. These exercise the
// real DB paths that the send pipeline depends on but that previously had no
// direct coverage.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  isSuppressed,
  isSuppressedBatch,
  isTrapOrDisposableBatch,
  addSuppression,
  removeSuppression,
  recordSoftBounce,
  clearSoftBounce,
} from '@platform/shared';
import { seedCustomer } from './e2e/harness.js';

describe('suppression list', () => {
  it('reports a fresh recipient as not suppressed', async () => {
    const c = await seedCustomer();
    expect(await isSuppressed(c.customerId, 'nobody@example.com')).toBe(false);
  });

  it('adds, detects, and removes a suppression (case-insensitive)', async () => {
    const c = await seedCustomer();
    await addSuppression(c.customerId, 'Blocked@Example.com', 'hard_bounce');

    // Stored and queried lowercased.
    expect(await isSuppressed(c.customerId, 'blocked@example.com')).toBe(true);
    expect(await isSuppressed(c.customerId, 'BLOCKED@EXAMPLE.COM')).toBe(true);

    await removeSuppression(c.customerId, 'blocked@example.com');
    expect(await isSuppressed(c.customerId, 'blocked@example.com')).toBe(false);
  });

  it('is idempotent — adding the same suppression twice does not throw', async () => {
    const c = await seedCustomer();
    await addSuppression(c.customerId, 'dup@example.com', 'complaint');
    await addSuppression(c.customerId, 'dup@example.com', 'unsubscribe');
    expect(await isSuppressed(c.customerId, 'dup@example.com')).toBe(true);
  });

  it('scopes suppressions per customer', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    await addSuppression(a.customerId, 'shared@example.com', 'manual');
    expect(await isSuppressed(a.customerId, 'shared@example.com')).toBe(true);
    expect(await isSuppressed(b.customerId, 'shared@example.com')).toBe(false);
  });
});

describe('soft-bounce escalation', () => {
  it('does not escalate below the limit', async () => {
    const c = await seedCustomer();
    let escalated = false;
    for (let i = 0; i < 4; i++) {
      escalated = await recordSoftBounce(c.customerId, 'flaky@example.com');
    }
    expect(escalated).toBe(false);
    expect(await isSuppressed(c.customerId, 'flaky@example.com')).toBe(false);
  });

  it('escalates to suppression once the limit is reached within the window', async () => {
    const c = await seedCustomer();
    let escalated = false;
    // Default SOFT_BOUNCE_LIMIT is 5.
    for (let i = 0; i < 5; i++) {
      escalated = await recordSoftBounce(c.customerId, 'dead@example.com');
    }
    expect(escalated).toBe(true);
    expect(await isSuppressed(c.customerId, 'dead@example.com')).toBe(true);
  });

  it('clearing a soft bounce resets the counter so a delivered address survives', async () => {
    const c = await seedCustomer();
    for (let i = 0; i < 3; i++) await recordSoftBounce(c.customerId, 'recover@example.com');
    await clearSoftBounce(c.customerId, 'recover@example.com');
    // After clearing, it takes a fresh full run of 5 to escalate again.
    let escalated = false;
    for (let i = 0; i < 4; i++) escalated = await recordSoftBounce(c.customerId, 'recover@example.com');
    expect(escalated).toBe(false);
    expect(await isSuppressed(c.customerId, 'recover@example.com')).toBe(false);
  });
});

describe('batched recipient screening (perf-correctness parity)', () => {
  it('isSuppressedBatch returns exactly the suppressed subset and matches the single-email path', async () => {
    const c = await seedCustomer();
    await addSuppression(c.customerId, 'bad1@example.com', 'hard_bounce');
    await addSuppression(c.customerId, 'bad2@example.com', 'complaint');

    const recipients = ['bad1@example.com', 'good1@example.com', 'BAD2@example.com', 'good2@example.com'];
    const set = await isSuppressedBatch(c.customerId, recipients);

    // Suppressed set is case-insensitive and contains only the bad addresses.
    expect(set.has('bad1@example.com')).toBe(true);
    expect(set.has('bad2@example.com')).toBe(true); // BAD2 normalized
    expect(set.has('good1@example.com')).toBe(false);
    expect(set.has('good2@example.com')).toBe(false);

    // Parity with the single-email implementation.
    for (const r of recipients) {
      expect(set.has(r.toLowerCase())).toBe(await isSuppressed(c.customerId, r));
    }
  });

  it('isSuppressedBatch handles an empty list and all-clean list', async () => {
    const c = await seedCustomer();
    expect((await isSuppressedBatch(c.customerId, [])).size).toBe(0);
    const clean = await isSuppressedBatch(c.customerId, ['a@x.com', 'b@y.com']);
    expect(clean.size).toBe(0);
  });

  it('isTrapOrDisposableBatch flags trap domains across a mixed recipient list', async () => {
    // Seed domain intel directly (one trap domain, one disposable).
    const { db } = await import('@platform/shared');
    const trapDomain = `trap-${Date.now()}.example`;
    const dispDomain = `disp-${Date.now()}.example`;
    await db.insertInto('recipient_domain_intel').values([
      { domain: trapDomain, category: 'spam_trap' },
      { domain: dispDomain, category: 'disposable' },
    ] as any).onConflict((oc) => oc.column('domain').doNothing()).execute();

    const emails = [`a@${trapDomain}`, `b@${dispDomain}`, 'c@clean-domain.example'];
    const map = await isTrapOrDisposableBatch(emails);

    expect(map.get(`a@${trapDomain}`)?.trap).toBe(true);
    expect(map.get(`b@${dispDomain}`)?.disposable).toBe(true);
    expect(map.get(`b@${dispDomain}`)?.trap).toBe(false);
    expect(map.get('c@clean-domain.example')?.trap).toBe(false);
  });
});
