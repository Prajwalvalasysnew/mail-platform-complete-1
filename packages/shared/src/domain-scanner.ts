// Domain deliverability scanner.
//
// Productizes the analysis behind the sales motion: given any domain, parse
// its live DNS posture — SPF (including the 10-lookup limit and nested
// includes), DMARC policy, MX provider, DKIM selectors, and DNSBL listings —
// and return a graded report with copy-paste DNS fixes plus a technographic
// list of the ESPs currently authorized to send for it (detected from SPF
// includes, exactly the way the ICP dossiers do it).
//
// Uses only DNS queries (no HTTP), so there is no SSRF surface; the resolver
// is injectable so tests never touch the network.

import dns from 'node:dns/promises';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanResolver {
  resolveTxt(host: string): Promise<string[][]>;
  resolveMx(host: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolve4(host: string): Promise<string[]>;
}

export type ScanSeverity = 'critical' | 'warning' | 'info';

export interface DomainScanIssue {
  severity: ScanSeverity;
  code: string;
  message: string;
}

export interface DomainDnsFix {
  type: 'TXT';
  host: string;
  value: string;
  reason: string;
}

export interface DomainScanReport {
  domain: string;
  scanned_at: string;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  spf: {
    found: boolean;
    record: string | null;
    record_count: number;
    all_qualifier: '-all' | '~all' | '?all' | '+all' | 'none' | null;
    dns_lookups: number;
    exceeds_lookup_limit: boolean;
    includes: string[];
  };
  dmarc: {
    found: boolean;
    record: string | null;
    policy: 'none' | 'quarantine' | 'reject' | null;
    subdomain_policy: string | null;
    pct: number | null;
    has_rua: boolean;
  };
  mx: {
    found: boolean;
    hosts: string[];
    provider: string | null;
  };
  dkim: {
    selectors_found: string[];
    selectors_probed: number;
  };
  blocklists: {
    checked_ips: string[];
    listings: Array<{ ip: string; zone: string }>;
  };
  esps_detected: string[];
  issues: DomainScanIssue[];
  fixes: DomainDnsFix[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DNS_TIMEOUT_MS = Number(process.env.DOMAIN_SCAN_DNS_TIMEOUT_MS ?? 4000);
const SPF_LOOKUP_LIMIT = 10;
const MAX_INCLUDE_DEPTH = 6;

// SPF include / redirect hostname fragments → sending platform. This is the
// same technographic fingerprinting the ICP analyses perform by hand.
const ESP_SIGNATURES: Array<[string, string]> = [
  ['sendgrid.net', 'SendGrid'],
  ['mailgun.org', 'Mailgun'],
  ['amazonses.com', 'Amazon SES'],
  ['spf.protection.outlook.com', 'Microsoft 365'],
  ['_spf.google.com', 'Google Workspace'],
  ['zoho', 'Zoho'],
  ['emsd1.com', 'Elastic Email'],
  ['mandrillapp.com', 'Mandrill (Mailchimp)'],
  ['servers.mcsv.net', 'Mailchimp'],
  ['e2ma.net', 'Emma'],
  ['vx-email.com', 'Vuture'],
  ['secondstreetmail.com', 'Second Street'],
  ['navigacloud.com', 'Naviga'],
  ['shops.shopify.com', 'Shopify'],
  ['sparkpostmail.com', 'SparkPost'],
  ['mtasv.net', 'Postmark'],
  ['sendinblue.com', 'Brevo (Sendinblue)'],
  ['brevo.com', 'Brevo'],
  ['qualtrics.com', 'Qualtrics'],
  ['exacttarget.com', 'Salesforce Marketing Cloud'],
  ['pardot.com', 'Salesforce Pardot'],
  ['mktomail.com', 'Marketo'],
  ['hubspotemail.net', 'HubSpot'],
  ['sailthru.com', 'Sailthru'],
  ['mailerlite.com', 'MailerLite'],
  ['mailigen.com', 'Mailigen'],
  ['pphosted.com', 'Proofpoint'],
  ['mimecast', 'Mimecast'],
  ['barracuda', 'Barracuda'],
  ['rediffmailpro.com', 'Rediffmail Pro'],
];

const MX_SIGNATURES: Array<[string, string]> = [
  ['google.com', 'Google Workspace'],
  ['googlemail.com', 'Google Workspace'],
  ['mail.protection.outlook.com', 'Microsoft 365'],
  ['pphosted.com', 'Proofpoint'],
  ['mimecast', 'Mimecast'],
  ['barracudanetworks.com', 'Barracuda'],
  ['trendmicro', 'Trend Micro'],
  ['greenradar', 'Green Radar'],
  ['zoho', 'Zoho Mail'],
  ['yandex', 'Yandex'],
  ['emailsrvr.com', 'Rackspace Email'],
  ['secureserver.net', 'GoDaddy / Microsoft 365'],
];

// Common DKIM selectors worth probing (Google, M365, major ESPs, generic).
const DKIM_SELECTORS = [
  'google', 'default', 'selector1', 'selector2', 'k1', 'k2', 's1', 's2',
  'dkim', 'smtp', 'mandrill', 'zoho', 'em1', 'sg', 'mp1', 'pm',
];

const DNSBL_ZONES = [
  { provider: 'spamhaus-zen', zone: 'zen.spamhaus.org' },
  { provider: 'spamcop', zone: 'bl.spamcop.net' },
  { provider: 'sorbs', zone: 'dnsbl.sorbs.net' },
];

// Hostname shape only — no IPs, no localhost/internal names. DNS-only probing
// means there is no request-forgery surface, but garbage input still costs
// resolver time.
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost', '.arpa', '.test', '.invalid'];

export function isScannableDomain(raw: string): boolean {
  const domain = raw.trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) return false;
  if (BLOCKED_SUFFIXES.some((s) => domain.endsWith(s))) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Resolver plumbing
// ---------------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms = DNS_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('dns_timeout')), ms).unref?.()),
  ]);
}

const defaultResolver: ScanResolver = {
  resolveTxt: (h) => withTimeout(dns.resolveTxt(h)),
  resolveMx: (h) => withTimeout(dns.resolveMx(h)),
  resolve4: (h) => withTimeout(dns.resolve4(h)),
};

async function txtRecords(resolver: ScanResolver, host: string): Promise<string[]> {
  try {
    const rows = await resolver.resolveTxt(host);
    return rows.map((chunks) => chunks.join(''));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// SPF parsing
// ---------------------------------------------------------------------------

interface SpfWalkResult {
  lookups: number;
  includes: string[];
  exceeded: boolean;
}

/**
 * Count the DNS-lookup cost of an SPF record the way validators do: include,
 * redirect, a, mx, ptr, and exists each cost one lookup, and nested includes'
 * own mechanisms count too. Bounded by depth and a visited-set so malicious
 * or looping records terminate.
 */
async function walkSpf(
  resolver: ScanResolver,
  record: string,
  depth: number,
  visited: Set<string>,
  acc: SpfWalkResult
): Promise<void> {
  if (depth > MAX_INCLUDE_DEPTH || acc.lookups > SPF_LOOKUP_LIMIT + 5) {
    acc.exceeded = acc.lookups > SPF_LOOKUP_LIMIT;
    return;
  }
  const terms = record.split(/\s+/).slice(1); // drop v=spf1
  for (const raw of terms) {
    const term = raw.replace(/^[+\-~?]/, '').toLowerCase();
    if (term.startsWith('include:') || term.startsWith('redirect=')) {
      const target = term.split(/[:=]/)[1] ?? '';
      acc.lookups++;
      if (target && !visited.has(target)) {
        visited.add(target);
        acc.includes.push(target);
        const nested = (await txtRecords(resolver, target)).find((t) => /^v=spf1(\s|$)/i.test(t));
        if (nested) await walkSpf(resolver, nested, depth + 1, visited, acc);
      }
    } else if (/^(a|mx)([:/]|$)/.test(term) || term.startsWith('ptr') || term.startsWith('exists:')) {
      acc.lookups++;
    }
  }
  acc.exceeded = acc.lookups > SPF_LOOKUP_LIMIT;
}

function spfAllQualifier(record: string): DomainScanReport['spf']['all_qualifier'] {
  const m = record.match(/(^|\s)([+\-~?]?)all(\s|$)/i);
  if (!m) return 'none';
  const q = m[2] || '+';
  return (`${q}all`) as DomainScanReport['spf']['all_qualifier'];
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export async function scanDomain(
  rawDomain: string,
  opts: { resolver?: ScanResolver; checkBlocklists?: boolean } = {}
): Promise<DomainScanReport> {
  const domain = rawDomain.trim().toLowerCase();
  if (!isScannableDomain(domain)) {
    throw new Error('invalid_domain');
  }
  const resolver = opts.resolver ?? defaultResolver;
  const issues: DomainScanIssue[] = [];
  const fixes: DomainDnsFix[] = [];
  const platformDomain = process.env.PLATFORM_DOMAIN ?? 'mail.example.com';

  // ---- SPF ----------------------------------------------------------------
  const rootTxt = await txtRecords(resolver, domain);
  const spfRecords = rootTxt.filter((t) => /^v=spf1(\s|$)/i.test(t));
  const spfRecord = spfRecords[0] ?? null;
  const spfWalk: SpfWalkResult = { lookups: 0, includes: [], exceeded: false };
  let allQualifier: DomainScanReport['spf']['all_qualifier'] = null;

  if (spfRecords.length === 0) {
    issues.push({
      severity: 'critical',
      code: 'spf_missing',
      message: 'No SPF record found. Receivers cannot verify authorized senders; mail is far more likely to be rejected or land in spam, and the domain is trivially spoofable.',
    });
    fixes.push({
      type: 'TXT',
      host: domain,
      value: `v=spf1 include:${platformDomain} ~all`,
      reason: 'Publish an SPF record authorizing your sending platform.',
    });
  } else {
    if (spfRecords.length > 1) {
      issues.push({
        severity: 'critical',
        code: 'spf_multiple_records',
        message: `Found ${spfRecords.length} SPF records. Multiple v=spf1 records are a permanent error (permerror) — receivers treat SPF as failed. Merge them into a single record.`,
      });
    }
    await walkSpf(resolver, spfRecord!, 0, new Set(), spfWalk);
    if (spfWalk.exceeded) {
      issues.push({
        severity: 'critical',
        code: 'spf_too_many_lookups',
        message: `SPF resolves to ${spfWalk.lookups} DNS lookups — over the hard limit of ${SPF_LOOKUP_LIMIT}. Validators return permerror and treat SPF as failed. Remove unused includes or flatten the record.`,
      });
    }
    allQualifier = spfAllQualifier(spfRecord!);
    if (allQualifier === '+all') {
      issues.push({
        severity: 'critical',
        code: 'spf_plus_all',
        message: 'SPF ends in +all, which authorizes EVERY server on the internet to send as this domain. This is equivalent to having no SPF protection at all.',
      });
    } else if (allQualifier === '?all' || allQualifier === 'none') {
      issues.push({
        severity: 'warning',
        code: 'spf_weak_all',
        message: `SPF ${allQualifier === 'none' ? 'has no "all" mechanism' : 'ends in ?all (neutral)'} — unauthorized senders are neither failed nor soft-failed. End the record with ~all or -all.`,
      });
    }
  }

  // ---- DMARC --------------------------------------------------------------
  const dmarcTxt = (await txtRecords(resolver, `_dmarc.${domain}`)).find((t) => /^v=DMARC1/i.test(t)) ?? null;
  let dmarcPolicy: DomainScanReport['dmarc']['policy'] = null;
  let dmarcSp: string | null = null;
  let dmarcPct: number | null = null;
  let hasRua = false;
  if (!dmarcTxt) {
    issues.push({
      severity: 'critical',
      code: 'dmarc_missing',
      message: 'No DMARC record found. Anyone can spoof this domain in phishing mail, and Gmail/Yahoo bulk-sender rules now require DMARC for reliable delivery.',
    });
    fixes.push({
      type: 'TXT',
      host: `_dmarc.${domain}`,
      value: `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@${domain}; pct=100`,
      reason: 'Publish a DMARC policy so receivers reject spoofed mail and send you aggregate reports.',
    });
  } else {
    dmarcPolicy = (dmarcTxt.match(/[;\s]p=(none|quarantine|reject)/i)?.[1]?.toLowerCase() ?? null) as any;
    dmarcSp = dmarcTxt.match(/sp=(\w+)/i)?.[1]?.toLowerCase() ?? null;
    const pctM = dmarcTxt.match(/pct=(\d+)/i);
    dmarcPct = pctM ? Number(pctM[1]) : 100;
    hasRua = /rua=/i.test(dmarcTxt);
    if (dmarcPolicy === 'none') {
      issues.push({
        severity: 'warning',
        code: 'dmarc_policy_none',
        message: 'DMARC policy is p=none (monitor only) — spoofed mail is still delivered. Move to p=quarantine, then p=reject once reports look clean.',
      });
    }
    if (!hasRua) {
      issues.push({
        severity: 'info',
        code: 'dmarc_no_rua',
        message: 'DMARC has no rua= reporting address — you have no visibility into who is sending as this domain.',
      });
    }
    if (dmarcPct !== null && dmarcPct < 100) {
      issues.push({
        severity: 'warning',
        code: 'dmarc_partial_pct',
        message: `DMARC pct=${dmarcPct} applies the policy to only ${dmarcPct}% of mail — spoofed messages slip through the remainder.`,
      });
    }
  }

  // ---- MX -----------------------------------------------------------------
  let mxHosts: string[] = [];
  try {
    const mx = await resolver.resolveMx(domain);
    mxHosts = mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange.toLowerCase());
  } catch {
    /* none */
  }
  let mxProvider: string | null = null;
  for (const [sig, name] of MX_SIGNATURES) {
    if (mxHosts.some((h) => h.includes(sig))) {
      mxProvider = name;
      break;
    }
  }
  if (mxHosts.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'mx_missing',
      message: 'No MX records found — this domain cannot receive mail (replies, bounce notifications, and DMARC reports are lost).',
    });
  } else if (!mxProvider && mxHosts.some((h) => h === domain || h.endsWith(`.${domain}`))) {
    mxProvider = 'Self-hosted';
    issues.push({
      severity: 'info',
      code: 'mx_self_hosted',
      message: 'MX points at the domain itself — self-hosted mail. A single compromised mailbox or IP listing takes down all inbound and outbound mail.',
    });
  }

  // ---- DKIM selector probe ------------------------------------------------
  const selectorsFound: string[] = [];
  await Promise.all(
    DKIM_SELECTORS.map(async (sel) => {
      const recs = await txtRecords(resolver, `${sel}._domainkey.${domain}`);
      if (recs.some((r) => /v=DKIM1|k=rsa|p=[A-Za-z0-9+/]/.test(r))) selectorsFound.push(sel);
    })
  );
  if (selectorsFound.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'dkim_not_detected',
      message: `No DKIM keys found under ${DKIM_SELECTORS.length} common selectors. If mail is not DKIM-signed, DMARC cannot pass on forwarded mail and Gmail/Yahoo bulk rules will throttle delivery. (Keys may exist under a custom selector.)`,
    });
  }

  // ---- ESP technographics -------------------------------------------------
  const espsDetected: string[] = [];
  const includeHosts = spfWalk.includes;
  for (const [sig, name] of ESP_SIGNATURES) {
    if (includeHosts.some((h) => h.includes(sig)) && !espsDetected.includes(name)) {
      espsDetected.push(name);
    }
  }
  if (includeHosts.some((h) => h.includes(platformDomain)) && !espsDetected.includes('This platform')) {
    espsDetected.push('This platform');
  }

  // ---- DNSBL checks -------------------------------------------------------
  const checkedIps: string[] = [];
  const listings: Array<{ ip: string; zone: string }> = [];
  if (opts.checkBlocklists !== false) {
    const ips = new Set<string>();
    try {
      for (const ip of await resolver.resolve4(domain)) ips.add(ip);
    } catch { /* none */ }
    for (const mxHost of mxHosts.slice(0, 2)) {
      try {
        for (const ip of (await resolver.resolve4(mxHost)).slice(0, 2)) ips.add(ip);
      } catch { /* none */ }
    }
    for (const ip of [...ips].slice(0, 4)) {
      checkedIps.push(ip);
      const reversed = ip.split('.').reverse().join('.');
      for (const { zone } of DNSBL_ZONES) {
        try {
          const res = await resolver.resolve4(`${reversed}.${zone}`);
          // Spamhaus signals errors (blocked public resolver, no query allowed)
          // in 127.255.255.0/24 — those are not listings.
          if (res.length > 0 && !res.some((r) => r.startsWith('127.255.255.'))) {
            listings.push({ ip, zone });
          }
        } catch {
          /* NXDOMAIN = clean (or zone unreachable) */
        }
      }
    }
    for (const l of listings) {
      issues.push({
        severity: 'critical',
        code: 'ip_blocklisted',
        message: `IP ${l.ip} (serving this domain's mail) is listed on ${l.zone}. Receivers consulting this blocklist will reject or spam-folder its mail.`,
      });
    }
  }

  // ---- Score --------------------------------------------------------------
  let score = 100;
  for (const i of issues) {
    if (i.severity === 'critical') score -= 25;
    else if (i.severity === 'warning') score -= 10;
  }
  score = Math.max(0, score);
  const grade: DomainScanReport['grade'] =
    score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

  return {
    domain,
    scanned_at: new Date().toISOString(),
    score,
    grade,
    spf: {
      found: spfRecords.length > 0,
      record: spfRecord,
      record_count: spfRecords.length,
      all_qualifier: spfRecords.length > 0 ? allQualifier : null,
      dns_lookups: spfWalk.lookups,
      exceeds_lookup_limit: spfWalk.exceeded,
      includes: includeHosts,
    },
    dmarc: {
      found: !!dmarcTxt,
      record: dmarcTxt,
      policy: dmarcPolicy,
      subdomain_policy: dmarcSp,
      pct: dmarcTxt ? dmarcPct : null,
      has_rua: hasRua,
    },
    mx: { found: mxHosts.length > 0, hosts: mxHosts, provider: mxProvider },
    dkim: { selectors_found: selectorsFound.sort(), selectors_probed: DKIM_SELECTORS.length },
    blocklists: { checked_ips: checkedIps, listings },
    esps_detected: espsDetected,
    issues,
    fixes,
  };
}
