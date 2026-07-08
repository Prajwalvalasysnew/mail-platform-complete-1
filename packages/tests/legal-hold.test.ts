// DB integration tests for legal hold (gap analysis Top-20 #19). Proves the
// acceptance criterion: "Legal hold blocks destructive erasure where required."
// Covers hold lifecycle (place/list/release), recipient-scoped and tenant-wide
// coverage, and the assertNoActiveHold gate used by the erasure endpoint.

import { describe, it, expect } from 'vitest';
import {
  placeLegalHold,
  releaseLegalHold,
  listLegalHolds,
  isRecipientUnderHold,
  assertNoActiveHold,
  activeHoldsCoveringRecipient,
  recipientHoldScope,
  LegalHoldError,
  seedCustomer,
} from '@platform/shared';

const rndEmail = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

describe('legal hold lifecycle', () => {
  it('places, lists, and releases a hold', async () => {
    const c = await seedCustomer();
    const hold = await placeLegalHold({ customerId: c.customerId, scope: 'customer', reason: 'litigation X' });
    expect(hold.scope).toBe('customer');
    expect(hold.released_at).toBeNull();

    const active = await listLegalHolds(c.customerId, { activeOnly: true });
    expect(active.find((h) => h.id === hold.id)).toBeTruthy();

    expect(await releaseLegalHold(c.customerId, hold.id, 'admin@example.com')).toBe(true);
    // Releasing again is a no-op (already released).
    expect(await releaseLegalHold(c.customerId, hold.id)).toBe(false);

    const activeAfter = await listLegalHolds(c.customerId, { activeOnly: true });
    expect(activeAfter.find((h) => h.id === hold.id)).toBeFalsy();
  });
});

describe('legal hold coverage', () => {
  it('a recipient-scoped hold covers only that recipient', async () => {
    const c = await seedCustomer();
    const held = rndEmail('held');
    const other = rndEmail('other');
    await placeLegalHold({ customerId: c.customerId, scope: recipientHoldScope(held), reason: 'subpoena' });

    expect(await isRecipientUnderHold(c.customerId, held)).toBe(true);
    expect(await isRecipientUnderHold(c.customerId, other)).toBe(false);
  });

  it('a tenant-wide (customer) hold covers every recipient', async () => {
    const c = await seedCustomer();
    await placeLegalHold({ customerId: c.customerId, scope: 'customer', reason: 'regulatory freeze' });

    expect(await isRecipientUnderHold(c.customerId, rndEmail('anyone'))).toBe(true);
    expect(await isRecipientUnderHold(c.customerId, rndEmail('another'))).toBe(true);
  });

  it('matching is case-insensitive on the recipient email', async () => {
    const c = await seedCustomer();
    const email = rndEmail('Case');
    await placeLegalHold({ customerId: c.customerId, scope: recipientHoldScope(email), reason: 'hold' });
    expect(await isRecipientUnderHold(c.customerId, email.toUpperCase())).toBe(true);
  });

  it('holds are tenant-isolated', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    const email = rndEmail('shared');
    await placeLegalHold({ customerId: a.customerId, scope: recipientHoldScope(email), reason: 'A only' });
    expect(await isRecipientUnderHold(a.customerId, email)).toBe(true);
    expect(await isRecipientUnderHold(b.customerId, email)).toBe(false);
  });
});

describe('assertNoActiveHold (the erasure gate)', () => {
  it('throws LegalHoldError when the recipient is held, with the blocking holds', async () => {
    const c = await seedCustomer();
    const email = rndEmail('block');
    await placeLegalHold({ customerId: c.customerId, scope: recipientHoldScope(email), reason: 'do not delete' });

    await expect(assertNoActiveHold(c.customerId, email)).rejects.toBeInstanceOf(LegalHoldError);
    try {
      await assertNoActiveHold(c.customerId, email);
    } catch (err) {
      expect(err).toBeInstanceOf(LegalHoldError);
      expect((err as LegalHoldError).holds[0].reason).toBe('do not delete');
    }
  });

  it('does NOT throw once the hold is released (erasure becomes allowed)', async () => {
    const c = await seedCustomer();
    const email = rndEmail('release');
    const hold = await placeLegalHold({ customerId: c.customerId, scope: recipientHoldScope(email), reason: 'temp' });
    await expect(assertNoActiveHold(c.customerId, email)).rejects.toThrow();

    await releaseLegalHold(c.customerId, hold.id);
    await expect(assertNoActiveHold(c.customerId, email)).resolves.toBeUndefined();
  });

  it('does not throw for an unheld recipient', async () => {
    const c = await seedCustomer();
    await expect(assertNoActiveHold(c.customerId, rndEmail('free'))).resolves.toBeUndefined();
    expect(await activeHoldsCoveringRecipient(c.customerId, rndEmail('free'))).toEqual([]);
  });
});
