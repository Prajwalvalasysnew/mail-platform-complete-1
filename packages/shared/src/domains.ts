// Sending-domain management, org-scoped. Shared by the API-key route
// (requireScope('domains')) and the dashboard route (requireCapability(
// 'domains:manage')) so the DKIM/DNS logic lives in one place. Every query
// filters by customer_id. DKIM private keys are encrypted at rest.

import { promises as dns } from 'node:dns';
import { withTenant } from './tenant-context.js';
import { encryptSecret } from './encryption.js';
import { generateDkimKeypair } from './dkim-rotation.js';

export class DomainError extends Error {
  domainId?: string;
  constructor(public code: string, message?: string, domainId?: string) {
    super(message ?? code);
    this.name = 'DomainError';
    this.domainId = domainId;
  }
}

export interface DomainRecord {
  id: string;
  domain: string;
  dkim_selector: string;
  dkim_public_key: string;
  verified_at: Date | null;
  spf_verified: boolean;
  dkim_verified: boolean;
  dmarc_verified: boolean;
  dmarc_policy: 'none' | 'quarantine' | 'reject' | null;
  verification_token: string;
  created_at: Date;
}

export interface DnsRecord {
  type: 'TXT' | 'CNAME';
  host: string;
  value: string;
  purpose: string;
}

const DOMAIN_COLS = [
  'id', 'domain', 'dkim_selector', 'dkim_public_key',
  'verified_at', 'spf_verified', 'dkim_verified', 'dmarc_verified', 'dmarc_policy',
  'verification_token', 'created_at',
] as const;

/** Strip PEM armor/newlines from a public key to get the DKIM DNS value. */
export function dkimPublicDnsValue(pemPublicKey: string): string {
  return pemPublicKey
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s+/g, '');
}

/** Build the DNS records a customer must publish to authenticate a domain. */
export function buildDomainDnsRecords(domain: string, selector: string, verificationToken: string, pemPublicKey: string): DnsRecord[] {
  const platformDomain = process.env.PLATFORM_DOMAIN ?? 'mail-platform.local';
  const bounceDomain = process.env.BOUNCE_DOMAIN ?? `bounces.${platformDomain}`;
  return [
    { type: 'TXT', host: `_mailplatform.${domain}`, value: verificationToken, purpose: 'Domain ownership verification' },
    { type: 'TXT', host: domain, value: `v=spf1 include:${platformDomain} ~all`, purpose: 'SPF — authorize platform to send for this domain' },
    { type: 'TXT', host: `${selector}._domainkey.${domain}`, value: `v=DKIM1; k=rsa; p=${dkimPublicDnsValue(pemPublicKey)}`, purpose: 'DKIM — public key for signature verification' },
    { type: 'TXT', host: `_dmarc.${domain}`, value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain};`, purpose: 'DMARC — start with p=none, move to quarantine then reject' },
    { type: 'CNAME', host: `bounces.${domain}`, value: bounceDomain, purpose: 'Return-path / bounce handling' },
  ];
}

export async function listDomains(customerId: string): Promise<DomainRecord[]> {
  const rows = await withTenant(customerId, (trx) =>
    trx
      .selectFrom('sending_domains')
      .select([...DOMAIN_COLS])
      .where('customer_id', '=', customerId)
      .orderBy('created_at', 'desc')
      .execute()
  );
  return rows as unknown as DomainRecord[];
}

/** Fetch a single domain (org-scoped) with the DNS records to publish. */
export async function getDomainWithDnsRecords(customerId: string, id: string): Promise<(DomainRecord & { dns_records: DnsRecord[] }) | null> {
  const row = await withTenant(customerId, (trx) =>
    trx
      .selectFrom('sending_domains')
      .select([...DOMAIN_COLS])
      .where('id', '=', id)
      .where('customer_id', '=', customerId)
      .executeTakeFirst()
  );
  if (!row) return null;
  const r = row as unknown as DomainRecord;
  return { ...r, dns_records: buildDomainDnsRecords(r.domain, r.dkim_selector, r.verification_token, r.dkim_public_key) };
}

export interface AddedDomain {
  id: string;
  domain: string;
  dkim_selector: string;
  verification_token: string;
  dns_records: DnsRecord[];
}

/** Add a sending domain: generate a DKIM keypair and return DNS setup records. */
export async function addDomain(input: { customerId: string; domain: string; dkimSelector?: string }): Promise<AddedDomain> {
  const domain = input.domain.toLowerCase();
  const selector = input.dkimSelector ?? 'default';

  const existing = await withTenant(input.customerId, (trx) =>
    trx
      .selectFrom('sending_domains')
      .select('id')
      .where('customer_id', '=', input.customerId)
      .where('domain', '=', domain)
      .executeTakeFirst()
  );
  if (existing) throw new DomainError('domain_exists', 'This domain is already added.', existing.id);

  // RSA key generation is CPU-bound, not a DB call — done outside any
  // transaction so we never hold a Postgres connection open across it.
  const { publicKey, privateKey } = generateDkimKeypair();
  const row = await withTenant(input.customerId, (trx) =>
    trx
      .insertInto('sending_domains')
      .values({
        customer_id: input.customerId,
        domain,
        dkim_selector: selector,
        dkim_public_key: publicKey,
        dkim_private_key: encryptSecret(privateKey),
      })
      .returning(['id', 'verification_token', 'dkim_selector'])
      .executeTakeFirstOrThrow()
  );

  return {
    id: row.id,
    domain,
    dkim_selector: row.dkim_selector,
    verification_token: row.verification_token,
    dns_records: buildDomainDnsRecords(domain, row.dkim_selector, row.verification_token, publicKey),
  };
}

export interface DomainVerifyResult {
  id: string;
  results: { ownership: boolean; spf: boolean; dkim: boolean; dmarc: boolean; dmarc_policy: 'none' | 'quarantine' | 'reject' | null };
  verified: boolean;
  dmarc_warning?: string;
}

/** Parse the DMARC policy level from a raw TXT record string. */
function parseDmarcPolicy(txt: string): 'none' | 'quarantine' | 'reject' | null {
  const m = txt.match(/\bp=(\w+)/i);
  if (!m) return null;
  const p = m[1]!.toLowerCase();
  if (p === 'reject' || p === 'quarantine' || p === 'none') return p as 'none' | 'quarantine' | 'reject';
  return null;
}

/** Verify a domain by checking its published DNS records. Returns null if not in org. */
export async function verifyDomain(customerId: string, id: string): Promise<DomainVerifyResult | null> {
  const domain = await withTenant(customerId, (trx) =>
    trx
      .selectFrom('sending_domains')
      .selectAll()
      .where('id', '=', id)
      .where('customer_id', '=', customerId)
      .executeTakeFirst()
  );
  if (!domain) return null;

  const results: DomainVerifyResult['results'] = { ownership: false, spf: false, dkim: false, dmarc: false, dmarc_policy: null };

  // DNS lookups are network I/O — deliberately done here, between the two
  // tenant-scoped DB calls, with no transaction held open across them (each
  // resolveTxt() can take up to the resolver timeout).
  try {
    const txt = await dns.resolveTxt(`_mailplatform.${domain.domain}`);
    results.ownership = txt.flat().includes(domain.verification_token);
  } catch { /* DNS not propagated yet */ }
  try {
    const txt = await dns.resolveTxt(domain.domain);
    const joined = txt.map((r) => r.join('')).join(' ');
    results.spf = /v=spf1/i.test(joined) && joined.includes(process.env.PLATFORM_DOMAIN ?? '');
  } catch { /* ignore */ }
  try {
    const txt = await dns.resolveTxt(`${domain.dkim_selector}._domainkey.${domain.domain}`);
    const joined = txt.map((r) => r.join('')).join('');
    results.dkim = /v=DKIM1/i.test(joined) && joined.includes('p=');
  } catch { /* ignore */ }
  try {
    const txt = await dns.resolveTxt(`_dmarc.${domain.domain}`);
    const joined = txt.map((r) => r.join('')).join(' ');
    results.dmarc = /v=DMARC1/i.test(joined);
    if (results.dmarc) results.dmarc_policy = parseDmarcPolicy(joined);
  } catch { /* ignore */ }

  const verified = results.ownership && results.spf && results.dkim;
  await withTenant(customerId, (trx) =>
    trx
      .updateTable('sending_domains')
      .set({
        spf_verified: results.spf,
        dkim_verified: results.dkim,
        dmarc_verified: results.dmarc,
        dmarc_policy: results.dmarc_policy,
        verified_at: verified ? new Date() : null,
      })
      .where('id', '=', id)
      .where('customer_id', '=', customerId)
      .execute()
  );

  // Advisory: p=none means DMARC is monitoring-only; no enforcement.
  // Encourage customers to move to quarantine or reject for full protection.
  const dmarc_warning = results.dmarc_policy === 'none'
    ? 'DMARC is set to p=none (monitoring only). Upgrade to p=quarantine or p=reject to protect against spoofing.'
    : undefined;

  return { id, results, verified, ...(dmarc_warning ? { dmarc_warning } : {}) };
}

export async function deleteDomain(customerId: string, id: string): Promise<boolean> {
  const res = await withTenant(customerId, (trx) =>
    trx
      .deleteFrom('sending_domains')
      .where('id', '=', id)
      .where('customer_id', '=', customerId)
      .executeTakeFirst()
  );
  return Number(res.numDeletedRows ?? 0) > 0;
}
