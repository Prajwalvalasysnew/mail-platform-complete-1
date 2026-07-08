import { describe, expect, it, beforeAll } from 'vitest';
import { generateApiKeyV2, verifyApiKeyV2, hashApiKey, detectKeyType } from '@platform/shared';

beforeAll(() => {
  process.env.API_KEY_PEPPER = 'test-pepper-' + 'x'.repeat(40);
});

describe('API key generation + verification', () => {
  it('round-trips a secret key', async () => {
    const k = generateApiKeyV2('secret');
    expect(k.plaintext.startsWith('mp_live_')).toBe(true);
    expect(k.hash.startsWith('hmac:')).toBe(true);
    expect(await verifyApiKeyV2(k.plaintext, k.hash)).toBe(true);
  });

  it('round-trips a test key', async () => {
    const k = generateApiKeyV2('test');
    expect(k.plaintext.startsWith('mp_test_')).toBe(true);
    expect(await verifyApiKeyV2(k.plaintext, k.hash)).toBe(true);
    expect(detectKeyType(k.plaintext)).toBe('test');
  });

  it('round-trips a publishable key', async () => {
    const k = generateApiKeyV2('publishable');
    expect(detectKeyType(k.plaintext)).toBe('publishable');
    expect(await verifyApiKeyV2(k.plaintext, k.hash)).toBe(true);
  });

  it('rejects a wrong plaintext against a real hash', async () => {
    const k = generateApiKeyV2('secret');
    const k2 = generateApiKeyV2('secret');
    expect(await verifyApiKeyV2(k2.plaintext, k.hash)).toBe(false);
  });

  it('produces a 12-char prefix for indexed lookup', () => {
    const k = generateApiKeyV2('secret');
    expect(k.prefix).toHaveLength(12);
    expect(k.plaintext.startsWith(k.prefix)).toBe(true);
  });

  it('different peppers produce different hashes for the same plaintext', () => {
    const original = process.env.API_KEY_PEPPER;
    process.env.API_KEY_PEPPER = 'pepper-A-' + 'x'.repeat(32);
    const hA = hashApiKey('mp_live_abc123');
    process.env.API_KEY_PEPPER = 'pepper-B-' + 'x'.repeat(32);
    const hB = hashApiKey('mp_live_abc123');
    process.env.API_KEY_PEPPER = original;
    expect(hA).not.toBe(hB);
  });

  it('rejects unrecognized key formats', () => {
    expect(detectKeyType('mp_live_abc')).toBe('secret');
    expect(detectKeyType('mp_test_abc')).toBe('test');
    expect(detectKeyType('mp_pub_abc')).toBe('publishable');
    expect(detectKeyType('sk_live_abc')).toBe(null);
    expect(detectKeyType('garbage')).toBe(null);
  });
});
