// E2E: BASE-08 (compliance implementation plan) — downstream transport
// security for TLS-required tenants.
//
// `customers.tls_required` was detective only: Haraka tagged the message,
// recorded whether the hop was TLS-secured, and logged a violation AFTER the
// message had already gone out in the clear. These tests cover the preventive
// half — a domain observed accepting mail without TLS is refused for the next
// TLS-required message, and recovers once it delivers over TLS again.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  db,
  recordDeliveryTlsOutcome,
  checkDomainTlsSafety,
  listTlsUnsafeDomains,
  recipientDomain,
} from '@platform/shared';

const domains: string[] = [];
function addr(label: string) {
  const domain = `tls-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.example.com`;
  domains.push(domain);
  return `recipient@${domain}`;
}

afterAll(async () => {
  if (domains.length) {
    await db.deleteFrom('recipient_domain_tls').where('domain', 'in', domains).execute();
  }
});

describe('recipientDomain', () => {
  it('extracts and lowercases the domain', () => {
    expect(recipientDomain('User@Example.COM')).toBe('example.com');
    expect(recipientDomain('a@b@example.com')).toBe('example.com');
  });

  it('returns null for malformed addresses', () => {
    expect(recipientDomain('no-at-sign')).toBe(null);
    expect(recipientDomain('trailing@')).toBe(null);
  });
});

describe('BASE-08: recording delivery TLS outcomes', () => {
  it('an unseen domain is not blocked', async () => {
    expect((await checkDomainTlsSafety(addr('unseen'))).unsafe).toBe(false);
  });

  it('a domain observed delivering WITHOUT TLS becomes unsafe', async () => {
    const to = addr('plain');
    await recordDeliveryTlsOutcome(to, false);

    const verdict = await checkDomainTlsSafety(to);
    expect(verdict.unsafe).toBe(true);
    expect(verdict.observedAt).toBeInstanceOf(Date);
  });

  it('a domain delivering over TLS stays safe', async () => {
    const to = addr('secure');
    await recordDeliveryTlsOutcome(to, true);
    expect((await checkDomainTlsSafety(to)).unsafe).toBe(false);
  });

  it('treats an unreported TLS state as no evidence, not as plaintext', async () => {
    const to = addr('unknown');
    await recordDeliveryTlsOutcome(to, null);
    await recordDeliveryTlsOutcome(to, undefined);

    expect((await checkDomainTlsSafety(to)).unsafe).toBe(false);
    const row = await db.selectFrom('recipient_domain_tls').select('domain')
      .where('domain', '=', recipientDomain(to)!).executeTakeFirst();
    expect(row).toBeUndefined(); // nothing recorded at all
  });

  it('recovers a domain once it delivers over TLS again', async () => {
    const to = addr('recovered');
    await recordDeliveryTlsOutcome(to, false);
    expect((await checkDomainTlsSafety(to)).unsafe).toBe(true);

    // The receiving domain fixed its configuration. Continuing to block it
    // would be a permanent outage for that correspondent with no benefit.
    await recordDeliveryTlsOutcome(to, true);
    expect((await checkDomainTlsSafety(to)).unsafe).toBe(false);
  });

  it('blocks again if the domain regresses to plaintext', async () => {
    const to = addr('regressed');
    await recordDeliveryTlsOutcome(to, true);
    await recordDeliveryTlsOutcome(to, false);
    expect((await checkDomainTlsSafety(to)).unsafe).toBe(true);
  });

  it('accumulates counts across deliveries', async () => {
    const to = addr('counts');
    await recordDeliveryTlsOutcome(to, true);
    await recordDeliveryTlsOutcome(to, true);
    await recordDeliveryTlsOutcome(to, false);

    const row = await db.selectFrom('recipient_domain_tls')
      .select(['deliveries_secured', 'deliveries_plaintext'])
      .where('domain', '=', recipientDomain(to)!).executeTakeFirstOrThrow();
    expect(Number(row.deliveries_secured)).toBe(2);
    expect(Number(row.deliveries_plaintext)).toBe(1);
  });

  it('ignores a malformed recipient address', async () => {
    await expect(recordDeliveryTlsOutcome('not-an-address', false)).resolves.toBeUndefined();
  });
});

describe('BASE-08: the unsafe-domain window', () => {
  it('stops blocking once the observation ages out of the window', async () => {
    const to = addr('aged');
    await recordDeliveryTlsOutcome(to, false);
    expect((await checkDomainTlsSafety(to)).unsafe).toBe(true);

    // Age the observation past TLS_UNSAFE_WINDOW_DAYS (default 30).
    await db.updateTable('recipient_domain_tls')
      .set({ last_plaintext_at: new Date(Date.now() - 45 * 86_400_000) })
      .where('domain', '=', recipientDomain(to)!).execute();

    expect((await checkDomainTlsSafety(to)).unsafe).toBe(false);
  });
});

describe('BASE-08: operator report', () => {
  it('lists currently-blocked domains and omits recovered ones', async () => {
    const blocked = addr('report-blocked');
    const recovered = addr('report-recovered');
    await recordDeliveryTlsOutcome(blocked, false);
    await recordDeliveryTlsOutcome(recovered, false);
    await recordDeliveryTlsOutcome(recovered, true);

    const report = await listTlsUnsafeDomains(1000);
    const names = report.map((r) => r.domain);
    expect(names).toContain(recipientDomain(blocked));
    expect(names).not.toContain(recipientDomain(recovered));

    const entry = report.find((r) => r.domain === recipientDomain(blocked))!;
    expect(entry.deliveries_plaintext).toBeGreaterThanOrEqual(1);
    expect(entry.last_plaintext_at).toBeTruthy();
  });
});
