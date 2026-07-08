import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '@platform/shared';

describe('passwords (scrypt)', () => {
  it('verifies a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    const res = await verifyPassword('correct horse battery staple', stored);
    expect(res.ok).toBe(true);
    expect(res.needsRehash).toBe(false);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('s3cret-pass');
    const res = await verifyPassword('wrong-pass', stored);
    expect(res.ok).toBe(false);
  });

  it('produces a self-describing, salted format (distinct hashes per call)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b); // random salt
    expect(a.startsWith('scrypt$32768$8$1$')).toBe(true);
  });

  it('rejects malformed stored hashes without throwing', async () => {
    const res = await verifyPassword('x', 'not-a-real-hash');
    expect(res.ok).toBe(false);
  });

  it('flags needsRehash when stored params are below policy', async () => {
    // Hand-craft a hash with weak N to simulate an older policy.
    const crypto = await import('node:crypto');
    const salt = crypto.randomBytes(16);
    const weak = crypto.scryptSync('pw', salt, 32, { N: 1024, r: 8, p: 1 });
    const stored = `scrypt$1024$8$1$${salt.toString('base64url')}$${weak.toString('base64url')}`;
    const res = await verifyPassword('pw', stored);
    expect(res.ok).toBe(true);
    expect(res.needsRehash).toBe(true);
  });

  it('rejects empty passwords at hash time', async () => {
    await expect(hashPassword('')).rejects.toThrow();
  });
});
