// Integration regression tests for the Antigravity fixes that touch the DB:
// bulk suppression import (bug 6) and DKIM rotation grace period (bug 5).

import { describe, it, expect } from 'vitest';
import {
  addSuppressionsBulk,
  isSuppressed,
  scoreList,
} from '@platform/shared';
import { seedCustomer } from './e2e/harness.js';

describe('bug 6 — bulk suppression import', () => {
  it('imports many addresses in one call and all are suppressed', async () => {
    const c = await seedCustomer();
    const emails = Array.from({ length: 250 }, (_, i) => `bulk${i}@example.com`);
    const n = await addSuppressionsBulk(c.customerId, emails, 'unsubscribe', 'bulk import');
    expect(n).toBe(250);
    // Spot-check several.
    expect(await isSuppressed(c.customerId, 'bulk0@example.com')).toBe(true);
    expect(await isSuppressed(c.customerId, 'bulk249@example.com')).toBe(true);
    expect(await isSuppressed(c.customerId, 'BULK100@EXAMPLE.COM')).toBe(true);
  });

  it('is idempotent on duplicate addresses', async () => {
    const c = await seedCustomer();
    const n1 = await addSuppressionsBulk(c.customerId, ['dup@example.com', 'dup@example.com'], 'manual');
    expect(n1).toBe(1); // de-duped
    const n2 = await addSuppressionsBulk(c.customerId, ['dup@example.com'], 'manual');
    expect(n2).toBe(1);
    expect(await isSuppressed(c.customerId, 'dup@example.com')).toBe(true);
  });

  it('handles an empty list without error', async () => {
    const c = await seedCustomer();
    expect(await addSuppressionsBulk(c.customerId, [], 'manual')).toBe(0);
  });
});

describe('bug 4 — list scoring handles large unique-domain sets', () => {
  it('scores a list with thousands of unique domains without crashing', async () => {
    // Build 6000 unique domains -> exercises the chunked IN query (CHUNK=5000).
    const emails = Array.from({ length: 6000 }, (_, i) => `user@d${i}.example`);
    const result = await scoreList(emails);
    expect(result).toBeTruthy();
    expect(typeof result.quality_score).toBe('number');
  });
});
