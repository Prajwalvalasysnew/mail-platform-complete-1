// List-quality scoring for suppression/recipient imports.
//
// Rejects obviously dirty lists at import time: high share of role accounts,
// disposable domains, known spam-trap domains, or malformed addresses. Returns
// a 0-100 quality score and a recommendation.

import { db } from './db.js';

const ROLE_LOCALPARTS = new Set([
  'admin', 'administrator', 'postmaster', 'hostmaster', 'webmaster', 'abuse',
  'noreply', 'no-reply', 'info', 'support', 'sales', 'contact', 'help',
  'root', 'security', 'billing', 'marketing', 'newsletter',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ListQualityResult {
  total: number;
  valid: number;
  invalid: number;
  role: number;
  disposable: number;
  spam_trap: number;
  quality_score: number; // 0 (reject) - 100 (clean)
  recommendation: 'accept' | 'review' | 'reject';
  bad_addresses: string[];
}

export async function scoreList(emails: string[]): Promise<ListQualityResult> {
  const total = emails.length;
  let invalid = 0;
  let role = 0;
  const bad: string[] = [];
  const domains = new Set<string>();
  const byDomain: Record<string, number> = {};

  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      invalid++;
      if (bad.length < 50) bad.push(raw);
      continue;
    }
    const [local, domain] = email.split('@') as [string, string];
    if (ROLE_LOCALPARTS.has(local)) role++;
    domains.add(domain);
    byDomain[domain] = (byDomain[domain] ?? 0) + 1;
  }

  // Domain intel lookup (spam_trap / disposable)
  let disposable = 0;
  let spamTrap = 0;
  if (domains.size > 0) {
    // Chunk the IN list. Postgres' wire protocol caps bound parameters at
    // 65535; a bulk import can contain far more unique domains than that, which
    // would crash the driver. 5000 per query is comfortably safe.
    const allDomains = Array.from(domains);
    const CHUNK = 5000;
    const rows: Array<{ domain: string; category: string }> = [];
    for (let i = 0; i < allDomains.length; i += CHUNK) {
      const chunk = allDomains.slice(i, i + CHUNK);
      const part = await db
        .selectFrom('recipient_domain_intel')
        .select(['domain', 'category'])
        .where('domain', 'in', chunk)
        .execute();
      rows.push(...(part as any));
    }
    for (const r of rows) {
      const n = byDomain[r.domain] ?? 0;
      if (r.category === 'disposable') disposable += n;
      if (r.category === 'spam_trap') spamTrap += n;
    }
  }

  const valid = total - invalid;
  // Scoring: spam traps are fatal; invalids and disposables erode score.
  let score = 100;
  if (total > 0) {
    score -= Math.round((invalid / total) * 60);
    score -= Math.round((disposable / total) * 40);
    score -= Math.round((role / total) * 20);
    if (spamTrap > 0) score = Math.min(score, 5); // any trap → reject
  }
  score = Math.max(0, Math.min(100, score));

  const recommendation: ListQualityResult['recommendation'] =
    spamTrap > 0 || score < 40 ? 'reject' : score < 75 ? 'review' : 'accept';

  return { total, valid, invalid, role, disposable, spam_trap: spamTrap, quality_score: score, recommendation, bad_addresses: bad };
}

/** Quick single-address spam-trap / disposable check used at send time. */
export async function isTrapOrDisposable(email: string): Promise<{ trap: boolean; disposable: boolean }> {
  const domain = email.toLowerCase().split('@')[1];
  if (!domain) return { trap: false, disposable: false };
  const row = await db
    .selectFrom('recipient_domain_intel')
    .select('category')
    .where('domain', '=', domain)
    .executeTakeFirst();
  return { trap: row?.category === 'spam_trap', disposable: row?.category === 'disposable' };
}

/**
 * Batched trap/disposable lookup. The intel is keyed by DOMAIN, and a recipient
 * list usually shares a handful of domains, so we query the distinct domains in
 * one `domain IN (...)` round-trip instead of one query per recipient. Returns a
 * per-email verdict map (lowercased email -> {trap, disposable}).
 */
export async function isTrapOrDisposableBatch(
  emails: string[]
): Promise<Map<string, { trap: boolean; disposable: boolean }>> {
  const out = new Map<string, { trap: boolean; disposable: boolean }>();
  if (emails.length === 0) return out;

  const emailToDomain = new Map<string, string | undefined>();
  const domains = new Set<string>();
  for (const e of emails) {
    const lower = e.toLowerCase();
    const d = lower.split('@')[1];
    emailToDomain.set(lower, d);
    if (d) domains.add(d);
  }

  const byDomain = new Map<string, string>();
  if (domains.size > 0) {
    const rows = await db
      .selectFrom('recipient_domain_intel')
      .select(['domain', 'category'])
      .where('domain', 'in', Array.from(domains))
      .execute();
    for (const r of rows) byDomain.set(r.domain, r.category);
  }

  for (const [email, domain] of emailToDomain) {
    const category = domain ? byDomain.get(domain) : undefined;
    out.set(email, { trap: category === 'spam_trap', disposable: category === 'disposable' });
  }
  return out;
}
