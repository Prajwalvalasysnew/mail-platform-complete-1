import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.VERP_SECRET = 'test-verp-secret-at-least-16-chars';
  process.env.PLATFORM_DOMAIN = 'send.example.com';
});

describe('VERP bounce tokens', () => {
  it('round-trips a message id through sign + verify', async () => {
    const { buildVerpToken, verifyVerpToken } = await import('@platform/shared');
    const mid = '<abc123@send.example.com>';
    const local = buildVerpToken(mid);
    expect(local).toMatch(/^bounce\+/);
    expect(verifyVerpToken(local)).toBe(mid);
  });

  it('rejects a forged token (bad signature)', async () => {
    const { verifyVerpToken } = await import('@platform/shared');
    const encoded = Buffer.from('evil@attacker.com').toString('base64url');
    const forged = `bounce+${encoded}.AAAAAAAAAAA`;
    expect(verifyVerpToken(forged)).toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const { buildVerpToken, verifyVerpToken } = await import('@platform/shared');
    const local = buildVerpToken('<x@y.com>');
    const tampered = local.slice(0, -2) + (local.endsWith('A') ? 'BB' : 'AA');
    expect(verifyVerpToken(tampered)).toBeNull();
  });

  it('rejects a malformed local part', async () => {
    const { verifyVerpToken } = await import('@platform/shared');
    expect(verifyVerpToken('not-a-bounce-address')).toBeNull();
    expect(verifyVerpToken('bounce+nodot')).toBeNull();
  });
});
