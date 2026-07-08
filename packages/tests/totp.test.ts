import { describe, it, expect } from 'vitest';
import {
  base32Encode,
  base32Decode,
  totpCode,
  verifyTotp,
  verifyTotpStep,
  generateTotpSecret,
  otpauthUri,
  generateRecoveryCodes,
  verifyRecoveryCode,
} from '@platform/shared';

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const buf = Buffer.from('Hello, MFA world!');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });
  it('matches a known RFC 4648 vector', () => {
    // "foobar" -> MZXW6YTBOI
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });
});

describe('TOTP — RFC 6238 Appendix B test vectors (SHA1, 8 digits)', () => {
  // Shared secret is the ASCII string "12345678901234567890".
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [t, expected] of vectors) {
    it(`T=${t} -> ${expected}`, () => {
      expect(totpCode(secret, t * 1000, { digits: 8, step: 30, t0: 0 })).toBe(expected);
    });
  }
});

describe('TOTP verification', () => {
  it('accepts the current 6-digit code', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const code = totpCode(secret, now);
    expect(verifyTotp(secret, code, { forTime: now })).toBe(true);
  });

  it('tolerates one step of clock skew', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const prev = totpCode(secret, now - 30_000);
    expect(verifyTotp(secret, prev, { forTime: now, window: 1 })).toBe(true);
  });

  it('rejects a code outside the window', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const old = totpCode(secret, now - 120_000);
    expect(verifyTotp(secret, old, { forTime: now, window: 1 })).toBe(false);
  });

  it('rejects malformed tokens', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, 'abc')).toBe(false);
    expect(verifyTotp(secret, '12345')).toBe(false);
  });

  it('builds a valid otpauth URI', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'alice@example.com', 'MailPlatform');
    expect(uri.startsWith('otpauth://totp/MailPlatform:alice%40example.com?')).toBe(true);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=MailPlatform');
  });
});

describe('recovery codes', () => {
  it('generates codes that verify against their stored hash and not others', () => {
    const codes = generateRecoveryCodes(5);
    expect(codes).toHaveLength(5);
    for (const { code, hash } of codes) {
      expect(/^[a-z2-9]{4}-[a-z2-9]{4}$/.test(code)).toBe(true);
      expect(verifyRecoveryCode(code, hash)).toBe(true);
      expect(verifyRecoveryCode('aaaa-bbbb', hash)).toBe(false);
    }
  });
  it('is case/space-insensitive on input', () => {
    const [{ code, hash }] = generateRecoveryCodes(1);
    expect(verifyRecoveryCode(`  ${code.toUpperCase()} `, hash)).toBe(true);
  });
});

describe('verifyTotpStep (replay-prevention support)', () => {
  const secret = generateTotpSecret();

  it('returns the matched time-step counter for a valid current code', () => {
    const now = Date.now();
    const code = totpCode(secret, now);
    const step = verifyTotpStep(secret, code, { forTime: now });
    expect(step).not.toBeNull();
    // The counter should equal floor(now/1000 / 30).
    expect(step).toBe(Math.floor(Math.floor(now / 1000) / 30));
  });

  it('returns null for a wrong code', () => {
    expect(verifyTotpStep(secret, '000000', { forTime: Date.now() })).toBeNull();
  });

  it('a code one step in the past yields a strictly smaller counter than the current code', () => {
    const now = Date.now();
    const current = verifyTotpStep(secret, totpCode(secret, now), { forTime: now })!;
    const prevCode = totpCode(secret, now - 30_000);
    const prev = verifyTotpStep(secret, prevCode, { forTime: now })!;
    // Within the ±1 window the previous step is accepted but ranks lower, so a
    // replay guard keyed on "step must exceed last used" rejects reuse.
    expect(prev).toBeLessThan(current);
  });
});
