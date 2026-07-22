// BASE-03 (compliance implementation plan): keyed pseudonyms for erased
// recipient identifiers. The pseudonym must be deterministic under one key
// (so retained opt-out/erasure evidence stays verifiable), tenant-scoped
// (same address at two customers is unlinkable), key-dependent, and must
// never contain the plaintext address.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { erasedRecipientPseudonym, isErasedPseudonym, ERASED_PSEUDONYM_PREFIX } from '@platform/shared';

const ORIGINAL = { ...process.env };
beforeEach(() => { process.env.PRIVACY_PSEUDONYM_SECRET = 'unit-test-pseudonym-secret-0123456789'; });
afterEach(() => { process.env = { ...ORIGINAL }; });

describe('erasedRecipientPseudonym', () => {
  it('is deterministic for the same tenant + email and normalizes case', () => {
    const a = erasedRecipientPseudonym('cust-1', 'Person@Example.com');
    const b = erasedRecipientPseudonym('cust-1', 'person@example.com');
    expect(a).toBe(b);
  });

  it('is scoped per tenant — same email at two customers is unlinkable', () => {
    const a = erasedRecipientPseudonym('cust-1', 'person@example.com');
    const b = erasedRecipientPseudonym('cust-2', 'person@example.com');
    expect(a).not.toBe(b);
  });

  it('depends on the key', () => {
    const a = erasedRecipientPseudonym('cust-1', 'person@example.com');
    process.env.PRIVACY_PSEUDONYM_SECRET = 'a-different-secret-key-9876543210';
    const b = erasedRecipientPseudonym('cust-1', 'person@example.com');
    expect(a).not.toBe(b);
  });

  it('never contains the plaintext address and fits an email column', () => {
    const p = erasedRecipientPseudonym('cust-1', 'person@example.com');
    expect(p.startsWith(ERASED_PSEUDONYM_PREFIX)).toBe(true);
    expect(isErasedPseudonym(p)).toBe(true);
    expect(p).not.toContain('person');
    expect(p).not.toContain('example.com');
    expect(p).toMatch(/^erased:[0-9a-f]{32}$/);
    expect(p.length).toBeLessThanOrEqual(64);
  });

  it('falls back to ENCRYPTION_KEY and refuses to run without any key', () => {
    delete process.env.PRIVACY_PSEUDONYM_SECRET;
    process.env.ENCRYPTION_KEY = 'fallback-encryption-key-0123456789';
    expect(isErasedPseudonym(erasedRecipientPseudonym('cust-1', 'p@example.com'))).toBe(true);
    delete process.env.ENCRYPTION_KEY;
    expect(() => erasedRecipientPseudonym('cust-1', 'p@example.com')).toThrow(/PRIVACY_PSEUDONYM_SECRET/);
  });

  it('isErasedPseudonym rejects ordinary addresses', () => {
    expect(isErasedPseudonym('person@example.com')).toBe(false);
  });
});
