import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
});

describe('encryption', () => {
  it('round-trips a secret', async () => {
    const { encryptSecret, decryptSecret } = await import('@platform/shared');
    const plaintext = 'super-secret-dkim-private-key';
    const encrypted = encryptSecret(plaintext);
    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it('passes through legacy plaintext', async () => {
    const { decryptSecret } = await import('@platform/shared');
    expect(decryptSecret('plain-old-key')).toBe('plain-old-key');
  });

  it('produces different ciphertext each time (random IV)', async () => {
    const { encryptSecret } = await import('@platform/shared');
    const a = encryptSecret('same');
    const b = encryptSecret('same');
    expect(a).not.toBe(b);
  });

  it('fails to decrypt tampered ciphertext', async () => {
    const { encryptSecret, decryptSecret } = await import('@platform/shared');
    const enc = encryptSecret('data');
    const parts = enc.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });
});
