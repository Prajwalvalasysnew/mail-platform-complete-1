import { describe, expect, it, beforeEach } from 'vitest';
import { roleAtLeast } from '@platform/shared';
import { getMasterKeyProvider, resetMasterKeyProvider } from '@platform/shared';

describe('roleAtLeast', () => {
  it('superadmin satisfies every role', () => {
    expect(roleAtLeast('superadmin', 'support')).toBe(true);
    expect(roleAtLeast('superadmin', 'admin')).toBe(true);
  });

  it('support does not satisfy admin', () => {
    expect(roleAtLeast('support', 'admin')).toBe(false);
    expect(roleAtLeast('support', 'support')).toBe(true);
  });

  it('orders correctly through the hierarchy', () => {
    expect(roleAtLeast('operator', 'support')).toBe(true);
    expect(roleAtLeast('admin', 'operator')).toBe(true);
    expect(roleAtLeast('operator', 'admin')).toBe(false);
  });
});

describe('KMS provider selection', () => {
  beforeEach(() => {
    resetMasterKeyProvider();
    process.env.KMS_PROVIDER = 'env';
    process.env.ENCRYPTION_KEY = '0'.repeat(64); // 32 bytes hex
  });

  it('env provider returns a 32-byte key', () => {
    const p = getMasterKeyProvider();
    expect(p.name).toBe('env');
    const k = p.getKey();
    expect(Buffer.isBuffer(k)).toBe(true);
    expect((k as Buffer).length).toBe(32);
  });

  it('remote providers cannot be used before startup preload', () => {
    resetMasterKeyProvider();
    process.env.KMS_PROVIDER = 'aws';
    const p = getMasterKeyProvider();
    expect(p.name).toBe('aws');
    expect(() => p.getKey()).toThrow(/not preloaded/);
  });

  it('unknown provider name throws on selection', () => {
    resetMasterKeyProvider();
    process.env.KMS_PROVIDER = 'bogus';
    expect(() => getMasterKeyProvider()).toThrow(/unknown KMS_PROVIDER/);
  });
});
