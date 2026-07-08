// DB integration tests for the org-scoped sending-domain service: add (DKIM
// keypair + DNS records + encrypted private key), duplicate detection, listing,
// detail-with-DNS, verification (no real DNS -> not verified), delete, and
// strict per-org isolation. Pure helpers (record building, PEM stripping) too.

import { describe, expect, it } from 'vitest';
import {
  seedCustomer,
  addDomain,
  listDomains,
  getDomainWithDnsRecords,
  verifyDomain,
  deleteDomain,
  buildDomainDnsRecords,
  dkimPublicDnsValue,
  DomainError,
  db,
} from '@platform/shared';

const rndDomain = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.example.com`;

describe('addDomain', () => {
  it('creates a domain with a DKIM keypair and the five DNS records', async () => {
    const c = await seedCustomer();
    const d = rndDomain('add');
    const added = await addDomain({ customerId: c.customerId, domain: d, dkimSelector: 'sel1' });
    expect(added.domain).toBe(d);
    expect(added.verification_token).toBeTruthy();
    const types = added.dns_records.map((r) => `${r.type}:${r.host.split('.')[0]}`);
    expect(added.dns_records).toHaveLength(5);
    expect(added.dns_records.find((r) => r.host === `_mailplatform.${d}`)).toBeTruthy();
    expect(added.dns_records.find((r) => r.host === `sel1._domainkey.${d}`)?.value).toMatch(/v=DKIM1/);
    expect(types).toContain('CNAME:bounces');
  });

  it('stores the DKIM private key encrypted, not in plaintext', async () => {
    const c = await seedCustomer();
    const added = await addDomain({ customerId: c.customerId, domain: rndDomain('enc') });
    const row = await db.selectFrom('sending_domains').select(['dkim_private_key']).where('id', '=', added.id).executeTakeFirstOrThrow();
    expect(row.dkim_private_key).not.toContain('BEGIN PRIVATE KEY');
  });

  it('lowercases the domain', async () => {
    const c = await seedCustomer();
    const d = rndDomain('Case').toUpperCase();
    const added = await addDomain({ customerId: c.customerId, domain: d });
    expect(added.domain).toBe(d.toLowerCase());
  });

  it('rejects a duplicate domain in the same org with the existing id', async () => {
    const c = await seedCustomer();
    const d = rndDomain('dup');
    const first = await addDomain({ customerId: c.customerId, domain: d });
    const err = await addDomain({ customerId: c.customerId, domain: d }).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe('domain_exists');
    expect(err.domainId).toBe(first.id);
  });

  it('allows the same domain in two different orgs', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    const d = rndDomain('shared');
    await expect(addDomain({ customerId: a.customerId, domain: d })).resolves.toBeTruthy();
    await expect(addDomain({ customerId: b.customerId, domain: d })).resolves.toBeTruthy();
  });
});

describe('listDomains / getDomainWithDnsRecords', () => {
  it('lists only the org\'s domains, newest first', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    await addDomain({ customerId: a.customerId, domain: rndDomain('a1') });
    await new Promise((r) => setTimeout(r, 5));
    const second = await addDomain({ customerId: a.customerId, domain: rndDomain('a2') });
    await addDomain({ customerId: b.customerId, domain: rndDomain('b1') });

    const aList = await listDomains(a.customerId);
    expect(aList).toHaveLength(2);
    expect(aList[0].id).toBe(second.id);
  });

  it('returns detail with DNS records, or null cross-org', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    const added = await addDomain({ customerId: a.customerId, domain: rndDomain('detail') });
    const detail = await getDomainWithDnsRecords(a.customerId, added.id);
    expect(detail!.dns_records).toHaveLength(5);
    expect(await getDomainWithDnsRecords(b.customerId, added.id)).toBeNull();
  });
});

describe('verifyDomain', () => {
  it('returns an unverified result when DNS records are not published', async () => {
    const c = await seedCustomer();
    const added = await addDomain({ customerId: c.customerId, domain: rndDomain('verify') });
    const res = await verifyDomain(c.customerId, added.id);
    expect(res).not.toBeNull();
    expect(res!.verified).toBe(false);
    expect(res!.results).toMatchObject({ ownership: false, spf: false, dkim: false, dmarc: false });
    // Flags persisted as not verified.
    const row = await db.selectFrom('sending_domains').select(['verified_at', 'spf_verified']).where('id', '=', added.id).executeTakeFirstOrThrow();
    expect(row.verified_at).toBeNull();
  });

  it('returns null for a domain not in the org', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    const added = await addDomain({ customerId: a.customerId, domain: rndDomain('verxorg') });
    expect(await verifyDomain(b.customerId, added.id)).toBeNull();
  });
});

describe('deleteDomain', () => {
  it('removes a domain, org-scoped', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    const added = await addDomain({ customerId: a.customerId, domain: rndDomain('del') });
    expect(await deleteDomain(b.customerId, added.id)).toBe(false);
    expect(await deleteDomain(a.customerId, added.id)).toBe(true);
    expect(await deleteDomain(a.customerId, added.id)).toBe(false);
  });
});

describe('pure DNS helpers', () => {
  it('buildDomainDnsRecords places each record at the right host', () => {
    const recs = buildDomainDnsRecords('acme.test', 'k1', 'tok123', '-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----');
    expect(recs.find((r) => r.host === '_mailplatform.acme.test')!.value).toBe('tok123');
    expect(recs.find((r) => r.host === 'acme.test')!.value).toMatch(/v=spf1/);
    expect(recs.find((r) => r.host === 'k1._domainkey.acme.test')!.value).toContain('p=ABC');
    expect(recs.find((r) => r.host === '_dmarc.acme.test')!.value).toMatch(/v=DMARC1/);
  });

  it('dkimPublicDnsValue strips PEM armor and whitespace', () => {
    expect(dkimPublicDnsValue('-----BEGIN PUBLIC KEY-----\nAB\nCD\n-----END PUBLIC KEY-----')).toBe('ABCD');
  });
});
