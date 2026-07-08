// DB integration tests for customer self-service API key management.
// Covers creation, listing (metadata-only), revocation, rotation with overlap,
// scope/type validation, and — critically — strict per-org isolation.

import { describe, expect, it } from 'vitest';
import {
  seedCustomer,
  listCustomerApiKeys,
  createCustomerApiKey,
  revokeCustomerApiKey,
  rotateCustomerApiKey,
  validateScopes,
  ApiKeyError,
  detectKeyType,
  db,
} from '@platform/shared';

describe('validateScopes', () => {
  it('rejects an empty scope set', () => {
    expect(() => validateScopes([], 'secret')).toThrow(ApiKeyError);
  });
  it('rejects unknown scopes', () => {
    expect(() => validateScopes(['send', 'nonsense'], 'secret')).toThrow(/Unknown scope/);
  });
  it('forbids publishable keys from holding the send scope', () => {
    expect(() => validateScopes(['send'], 'publishable')).toThrow(/publishable/i);
  });
  it('accepts a valid scope set', () => {
    expect(() => validateScopes(['send', 'domains'], 'secret')).not.toThrow();
  });
});

describe('createCustomerApiKey', () => {
  it('creates a secret key with the requested scopes and returns the plaintext once', async () => {
    const c = await seedCustomer();
    const created = await createCustomerApiKey({ customerId: c.customerId, name: 'CI key', scopes: ['send', 'messages'] });
    expect(created.api_key).toBeTruthy();
    expect(detectKeyType(created.api_key)).toBe('secret');
    expect(created.scopes).toEqual(['send', 'messages']);
    expect(created.status).toBe('active');
    // The plaintext/hash must never appear in the stored metadata listing.
    const listed = await listCustomerApiKeys(c.customerId);
    const row = listed.find((k) => k.id === created.id)!;
    expect((row as any).key_hash).toBeUndefined();
    expect((row as any).api_key).toBeUndefined();
  });

  it('defaults to a secret key with the send scope', async () => {
    const c = await seedCustomer();
    const created = await createCustomerApiKey({ customerId: c.customerId, name: 'default' });
    expect(created.key_type).toBe('secret');
    expect(created.scopes).toEqual(['send']);
  });

  it('honors an expiry window', async () => {
    const c = await seedCustomer();
    const created = await createCustomerApiKey({ customerId: c.customerId, name: 'exp', expiresInDays: 30 });
    expect(created.expires_at).toBeTruthy();
    const ms = new Date(created.expires_at!).getTime() - Date.now();
    expect(ms).toBeGreaterThan(28 * 86400_000);
    expect(ms).toBeLessThan(32 * 86400_000);
  });

  it('rejects an invalid expiry', async () => {
    const c = await seedCustomer();
    await expect(createCustomerApiKey({ customerId: c.customerId, name: 'x', expiresInDays: 99999 })).rejects.toThrow(ApiKeyError);
  });

  it('rejects a blank name', async () => {
    const c = await seedCustomer();
    await expect(createCustomerApiKey({ customerId: c.customerId, name: '   ' })).rejects.toThrow(/name/i);
  });
});

describe('listCustomerApiKeys', () => {
  it('returns only the org\'s keys, newest first', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    await createCustomerApiKey({ customerId: a.customerId, name: 'a1' });
    await new Promise((r) => setTimeout(r, 5));
    await createCustomerApiKey({ customerId: a.customerId, name: 'a2' });
    await createCustomerApiKey({ customerId: b.customerId, name: 'b1' });

    const aKeys = await listCustomerApiKeys(a.customerId);
    const names = aKeys.map((k) => k.name);
    // seedCustomer also creates a default key, so a1/a2 are present plus the seed.
    expect(names).toContain('a1');
    expect(names).toContain('a2');
    expect(names).not.toContain('b1');
    // newest-first ordering
    expect(names.indexOf('a2')).toBeLessThan(names.indexOf('a1'));
  });

  it('derives revoked and expired statuses', async () => {
    const c = await seedCustomer();
    const k = await createCustomerApiKey({ customerId: c.customerId, name: 'tostatus' });
    await db.updateTable('api_keys').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', k.id).execute();
    let row = (await listCustomerApiKeys(c.customerId)).find((x) => x.id === k.id)!;
    expect(row.status).toBe('expired');
    await revokeCustomerApiKey(c.customerId, k.id);
    row = (await listCustomerApiKeys(c.customerId)).find((x) => x.id === k.id)!;
    expect(row.status).toBe('revoked'); // revoked takes precedence
  });
});

describe('revokeCustomerApiKey', () => {
  it('revokes a key and is idempotent', async () => {
    const c = await seedCustomer();
    const k = await createCustomerApiKey({ customerId: c.customerId, name: 'rev' });
    expect(await revokeCustomerApiKey(c.customerId, k.id)).toBe(true);
    expect(await revokeCustomerApiKey(c.customerId, k.id)).toBe(true); // idempotent
    const row = (await listCustomerApiKeys(c.customerId)).find((x) => x.id === k.id)!;
    expect(row.status).toBe('revoked');
  });

  it('will not revoke another org\'s key', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    const k = await createCustomerApiKey({ customerId: a.customerId, name: 'mine' });
    expect(await revokeCustomerApiKey(b.customerId, k.id)).toBe(false); // not found in b's org
    const row = (await listCustomerApiKeys(a.customerId)).find((x) => x.id === k.id)!;
    expect(row.status).toBe('active'); // untouched
  });
});

describe('rotateCustomerApiKey', () => {
  it('mints a linked replacement and expires the old key after the overlap', async () => {
    const c = await seedCustomer();
    const k = await createCustomerApiKey({ customerId: c.customerId, name: 'rotate-me', scopes: ['send', 'domains'] });
    const rotated = await rotateCustomerApiKey(c.customerId, k.id, 24);
    expect(rotated).not.toBeNull();
    expect(rotated!.rotated_from_id).toBe(k.id);
    expect(rotated!.scopes).toEqual(['send', 'domains']); // inherits scopes
    expect(rotated!.api_key).toBeTruthy();

    const list = await listCustomerApiKeys(c.customerId);
    const oldRow = list.find((x) => x.id === k.id)!;
    expect(oldRow.expires_at).toBeTruthy();
    const newRow = list.find((x) => x.id === rotated!.id)!;
    expect(newRow.rotated_from).toBe(k.id);
  });

  it('returns null for an unknown / cross-org key', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    const k = await createCustomerApiKey({ customerId: a.customerId, name: 'a-only' });
    expect(await rotateCustomerApiKey(b.customerId, k.id)).toBeNull();
  });

  it('refuses to rotate a revoked key', async () => {
    const c = await seedCustomer();
    const k = await createCustomerApiKey({ customerId: c.customerId, name: 'dead' });
    await revokeCustomerApiKey(c.customerId, k.id);
    await expect(rotateCustomerApiKey(c.customerId, k.id)).rejects.toThrow(/revoked/i);
  });
});
