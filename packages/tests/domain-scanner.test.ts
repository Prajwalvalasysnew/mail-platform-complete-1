// Domain deliverability scanner — pure unit tests with an injected fake
// resolver (no network DNS).
import { describe, it, expect } from 'vitest';
import { scanDomain, isScannableDomain, type ScanResolver } from '@platform/shared';

function fakeResolver(zones: {
  txt?: Record<string, string[]>;
  mx?: Record<string, Array<{ exchange: string; priority: number }>>;
  a?: Record<string, string[]>;
}): ScanResolver {
  return {
    async resolveTxt(host: string) {
      const recs = zones.txt?.[host];
      if (!recs) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return recs.map((r) => [r]);
    },
    async resolveMx(host: string) {
      const recs = zones.mx?.[host];
      if (!recs) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return recs;
    },
    async resolve4(host: string) {
      const recs = zones.a?.[host];
      if (!recs) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      return recs;
    },
  };
}

describe('isScannableDomain', () => {
  it('accepts public FQDNs and rejects garbage, IPs, and internal names', () => {
    expect(isScannableDomain('example.com')).toBe(true);
    expect(isScannableDomain('mail.sub.example.co.uk')).toBe(true);
    expect(isScannableDomain('localhost')).toBe(false);
    expect(isScannableDomain('192.168.1.1')).toBe(false);
    expect(isScannableDomain('foo.internal')).toBe(false);
    expect(isScannableDomain('foo.local')).toBe(false);
    expect(isScannableDomain('not a domain')).toBe(false);
    expect(isScannableDomain('nodots')).toBe(false);
  });
});

describe('scanDomain', () => {
  it('flags a domain with no SPF/DMARC and emits copy-paste fixes (the Labcorp case)', async () => {
    const resolver = fakeResolver({
      txt: { 'example.com': ['google-site-verification=abc'] },
      mx: { 'example.com': [{ exchange: 'example-com.mail.protection.outlook.com', priority: 0 }] },
    });
    const report = await scanDomain('example.com', { resolver, checkBlocklists: false });

    expect(report.spf.found).toBe(false);
    expect(report.dmarc.found).toBe(false);
    expect(report.mx.provider).toBe('Microsoft 365');
    expect(report.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['spf_missing', 'dmarc_missing', 'dkim_not_detected'])
    );
    // Copy-paste fixes for both missing records.
    const fixHosts = report.fixes.map((f) => f.host);
    expect(fixHosts).toContain('example.com');
    expect(fixHosts).toContain('_dmarc.example.com');
    expect(report.grade).toMatch(/[DF]/);
  });

  it('grades a fully configured domain as A and detects the ESP stack (the technographic trick)', async () => {
    const resolver = fakeResolver({
      txt: {
        'acme.com': ['v=spf1 include:sendgrid.net include:_spf.google.com -all'],
        '_dmarc.acme.com': ['v=DMARC1; p=reject; rua=mailto:d@acme.com; pct=100'],
        'sendgrid.net': ['v=spf1 ip4:167.89.0.0/17 -all'],
        '_spf.google.com': ['v=spf1 ip4:35.190.247.0/24 -all'],
        'google._domainkey.acme.com': ['v=DKIM1; k=rsa; p=MIIB'],
      },
      mx: { 'acme.com': [{ exchange: 'aspmx.l.google.com', priority: 1 }] },
    });
    const report = await scanDomain('acme.com', { resolver, checkBlocklists: false });

    expect(report.spf.found).toBe(true);
    expect(report.spf.all_qualifier).toBe('-all');
    expect(report.spf.exceeds_lookup_limit).toBe(false);
    expect(report.dmarc.policy).toBe('reject');
    expect(report.mx.provider).toBe('Google Workspace');
    expect(report.dkim.selectors_found).toContain('google');
    expect(report.esps_detected).toEqual(expect.arrayContaining(['SendGrid', 'Google Workspace']));
    expect(report.grade).toBe('A');
    expect(report.score).toBe(100);
  });

  it('detects the 10-lookup SPF breach through nested includes', async () => {
    // 6 direct includes, each nesting one more include = 12 lookups total.
    const nested: Record<string, string[]> = {
      'big.com': [`v=spf1 ${[1, 2, 3, 4, 5, 6].map((i) => `include:l${i}.big.com`).join(' ')} ~all`],
    };
    for (let i = 1; i <= 6; i++) {
      nested[`l${i}.big.com`] = [`v=spf1 include:n${i}.big.com -all`];
      nested[`n${i}.big.com`] = ['v=spf1 ip4:10.0.0.1 -all'];
    }
    const report = await scanDomain('big.com', {
      resolver: fakeResolver({ txt: nested }),
      checkBlocklists: false,
    });
    expect(report.spf.dns_lookups).toBeGreaterThan(10);
    expect(report.spf.exceeds_lookup_limit).toBe(true);
    expect(report.issues.some((i) => i.code === 'spf_too_many_lookups' && i.severity === 'critical')).toBe(true);
  });

  it('flags +all as critical and p=none DMARC as a warning', async () => {
    const resolver = fakeResolver({
      txt: {
        'weak.com': ['v=spf1 include:mailgun.org +all'],
        '_dmarc.weak.com': ['v=DMARC1; p=none'],
        'mailgun.org': ['v=spf1 ip4:1.2.3.4 -all'],
      },
      mx: { 'weak.com': [{ exchange: 'mx.weak.com', priority: 10 }] },
    });
    const report = await scanDomain('weak.com', { resolver, checkBlocklists: false });
    expect(report.issues.some((i) => i.code === 'spf_plus_all' && i.severity === 'critical')).toBe(true);
    expect(report.issues.some((i) => i.code === 'dmarc_policy_none')).toBe(true);
    expect(report.issues.some((i) => i.code === 'dmarc_no_rua')).toBe(true);
    expect(report.esps_detected).toContain('Mailgun');
  });

  it('flags multiple SPF records as permerror', async () => {
    const resolver = fakeResolver({
      txt: { 'dup.com': ['v=spf1 include:a.dup.com ~all', 'v=spf1 include:b.dup.com ~all'] },
    });
    const report = await scanDomain('dup.com', { resolver, checkBlocklists: false });
    expect(report.spf.record_count).toBe(2);
    expect(report.issues.some((i) => i.code === 'spf_multiple_records')).toBe(true);
  });

  it('reports DNSBL listings for the domain A record', async () => {
    const resolver = fakeResolver({
      txt: {
        'listed.com': ['v=spf1 ip4:5.6.7.8 -all'],
        '_dmarc.listed.com': ['v=DMARC1; p=reject; rua=mailto:x@listed.com'],
      },
      mx: { 'listed.com': [{ exchange: 'mail.listed.com', priority: 10 }] },
      a: {
        'listed.com': ['5.6.7.8'],
        'mail.listed.com': ['5.6.7.8'],
        // DNSBL hit: reversed IP under the zone resolves.
        '8.7.6.5.zen.spamhaus.org': ['127.0.0.2'],
      },
    });
    const report = await scanDomain('listed.com', { resolver });
    expect(report.blocklists.listings).toEqual([{ ip: '5.6.7.8', zone: 'zen.spamhaus.org' }]);
    expect(report.issues.some((i) => i.code === 'ip_blocklisted' && i.severity === 'critical')).toBe(true);
  });

  it('rejects unscannable input', async () => {
    await expect(scanDomain('localhost', { checkBlocklists: false })).rejects.toThrow('invalid_domain');
  });
});
