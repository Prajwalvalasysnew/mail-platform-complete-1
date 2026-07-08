// DB integration tests for the DKIM selector rotation state machine
// (packages/shared/src/dkim-rotation.ts). This path was previously untested,
// yet it's security-sensitive: a broken rotation silently breaks email
// authentication for a domain. Covers the documented lifecycle
//   pending -> active -> retiring -> retired
// plus the invariant "exactly one active selector per domain" and the
// retiring-grace-period retirement.

import { describe, expect, it, beforeAll } from 'vitest';
import {
  seedCustomer,
  addDomain,
  createPendingKey,
  promoteKey,
  retireOldKeys,
  getActiveKey,
  generateDkimKeypair,
  db,
} from '@platform/shared';

const rndDomain = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.example.com`;

async function seedDomain(): Promise<string> {
  const c = await seedCustomer();
  const added = await addDomain({ customerId: c.customerId, domain: rndDomain('dkim'), dkimSelector: 'seed' });
  return added.id;
}

describe('generateDkimKeypair', () => {
  it('produces a 2048-bit RSA keypair and a DNS-ready public value', () => {
    const { publicKey, privateKey, publicDnsValue } = generateDkimKeypair();
    expect(publicKey).toContain('BEGIN PUBLIC KEY');
    expect(privateKey).toContain('BEGIN PRIVATE KEY');
    // DNS value is the base64 body with all PEM headers/whitespace stripped.
    expect(publicDnsValue).not.toContain('BEGIN');
    expect(publicDnsValue).not.toMatch(/\s/);
    expect(publicDnsValue.length).toBeGreaterThan(300);
  });
});

describe('DKIM rotation lifecycle', () => {
  it('createPendingKey inserts a pending key with a publishable DNS record', async () => {
    const domainId = await seedDomain();
    const res = await createPendingKey(domainId, 'sel-a');
    expect(res.selector).toBe('sel-a');
    expect(res.dns_value).toMatch(/^v=DKIM1; k=rsa; p=/);

    const row = await db.selectFrom('dkim_keys').select(['state']).where('id', '=', res.id).executeTakeFirst();
    expect(row?.state).toBe('pending');
  });

  it('rejects a duplicate selector for the same domain', async () => {
    const domainId = await seedDomain();
    await createPendingKey(domainId, 'dup');
    await expect(createPendingKey(domainId, 'dup')).rejects.toThrow(/already exists/i);
  });

  it('promoteKey makes the selector active and there is no prior active to demote', async () => {
    const domainId = await seedDomain();
    await createPendingKey(domainId, 'first');
    await promoteKey(domainId, 'first');

    const active = await getActiveKey(domainId);
    expect(active?.selector).toBe('first');
    // The private key is stored encrypted (ciphertext), never plaintext PEM.
    expect(active?.private_key).not.toContain('BEGIN PRIVATE KEY');
  });

  it('promoting a second key demotes the first to retiring (exactly one active)', async () => {
    const domainId = await seedDomain();
    await createPendingKey(domainId, 'k1');
    await promoteKey(domainId, 'k1');
    await createPendingKey(domainId, 'k2');
    await promoteKey(domainId, 'k2');

    const active = await getActiveKey(domainId);
    expect(active?.selector).toBe('k2');

    const states = await db
      .selectFrom('dkim_keys')
      .select(['selector', 'state'])
      .where('domain_id', '=', domainId)
      .execute();
    const bySelector = Object.fromEntries(states.map((s) => [s.selector, s.state]));
    expect(bySelector['k1']).toBe('retiring');
    expect(bySelector['k2']).toBe('active');

    // Invariant: never more than one active selector per domain.
    const activeCount = states.filter((s) => s.state === 'active').length;
    expect(activeCount).toBe(1);
  });

  it('retireOldKeys only retires keys past the grace period (measured from retiring_at)', async () => {
    const domainId = await seedDomain();
    await createPendingKey(domainId, 'old');
    await promoteKey(domainId, 'old');
    await createPendingKey(domainId, 'new');
    await promoteKey(domainId, 'new'); // 'old' -> retiring, retiring_at = now

    // Freshly retiring: a 7-day retire must NOT touch it yet.
    const retiredNow = await retireOldKeys(7);
    const oldStateFresh = await db.selectFrom('dkim_keys').select('state').where('domain_id', '=', domainId).where('selector', '=', 'old').executeTakeFirst();
    expect(oldStateFresh?.state).toBe('retiring');

    // Backdate retiring_at beyond the grace window, then retire with ttl 0.
    await db.updateTable('dkim_keys')
      .set({ retiring_at: new Date(Date.now() - 10 * 86400_000) })
      .where('domain_id', '=', domainId).where('selector', '=', 'old').execute();

    const retired = await retireOldKeys(7);
    expect(retired).toBeGreaterThanOrEqual(1);
    const oldStateAfter = await db.selectFrom('dkim_keys').select('state').where('domain_id', '=', domainId).where('selector', '=', 'old').executeTakeFirst();
    expect(oldStateAfter?.state).toBe('retired');

    // The active key is never retired by the sweep.
    const active = await getActiveKey(domainId);
    expect(active?.selector).toBe('new');
    void retiredNow;
  });
});
