import { describe, it, expect } from 'vitest';
import { dailyCapForStage, generateMessageId, encodeMessageIdForUrl, decodeMessageIdFromUrl } from '@platform/shared';

describe('warmup schedule', () => {
  it('starts small', () => {
    expect(dailyCapForStage(0)).toBe(50);
  });

  it('ramps up monotonically', () => {
    let prev = 0;
    for (let s = 0; s < 17; s++) {
      const cap = dailyCapForStage(s);
      expect(cap).toBeGreaterThanOrEqual(prev);
      prev = cap;
    }
  });

  it('is effectively unlimited when fully warmed', () => {
    expect(dailyCapForStage(100)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('message id encoding', () => {
  it('round-trips through url encoding', () => {
    const id = generateMessageId('send.example.com');
    expect(id).toMatch(/^<[0-9a-f]+@send\.example\.com>$/);
    const encoded = encodeMessageIdForUrl(id);
    expect(encoded).not.toContain('@');
    expect(encoded).not.toContain('<');
    expect(decodeMessageIdFromUrl(encoded)).toBe(id);
  });

  it('produces url-safe output', () => {
    const id = generateMessageId('a.b.c');
    const encoded = encodeMessageIdForUrl(id);
    expect(encoded).not.toMatch(/[+/=]/); // base64url, no padding
  });
});
