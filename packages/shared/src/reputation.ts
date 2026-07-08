// Reputation feedback loop + per-IP warmup + blocklist monitoring.
//
// This is the operational machinery that decides whether mail keeps flowing:
//   - reputationGuard(): computes rolling bounce/complaint rates per pool and
//     auto-throttles or pauses sending when they cross ISP-dangerous thresholds.
//   - checkBlocklists(): DNSBL lookups (Spamhaus, SpamCop, Barracuda, SORBS)
//     per sending IP, recorded with alerting on new listings.
//   - advanceIpWarmup(): per-IP warmup ramp (the send path enforces per IP, not
//     just per pool).
//   - ingestPostmaster(): polls Google Postmaster Tools + Microsoft SNDS and
//     persists the results via recordReputationSnapshot().

import { promises as dns } from 'node:dns';
import { createSign } from 'node:crypto';
import { sql } from 'kysely';
import { db } from './db.js';
import { redis } from './redis.js';
import { dailyCapForStage } from './warmup.js';

// ISP-dangerous thresholds. Gmail/Yahoo expect complaint < 0.3%; a sustained
// hard-bounce rate over ~5% gets IPs blocklisted fast.
export const BOUNCE_PAUSE_THRESHOLD = Number(process.env.BOUNCE_PAUSE_THRESHOLD ?? 0.05);
export const COMPLAINT_PAUSE_THRESHOLD = Number(process.env.COMPLAINT_PAUSE_THRESHOLD ?? 0.003);

export interface PoolHealth {
  pool: string;
  sent: number;
  bounced: number;
  complained: number;
  bounce_rate: number;
  complaint_rate: number;
  action: 'ok' | 'throttle' | 'pause';
  reasons: string[];
}

/**
 * Compute rolling (last 24h) bounce/complaint rates per IP pool from events,
 * and return the recommended action. Pausing/throttling is applied by setting
 * a Redis flag the send path checks.
 */
export async function evaluatePoolHealth(): Promise<PoolHealth[]> {
  const rows = await db
    .selectFrom('messages')
    .select([
      'ip_pool',
      db.fn.count<number>('message_id').as('sent'),
      sql<number>`count(*) filter (where status = 'hard_bounced')`.as('bounced'),
    ])
    .where(sql<boolean>`queued_at >= now() - interval '24 hours'`)
    .groupBy('ip_pool')
    .execute();

  // Complaints come from the events table (no message status for complaint).
  const complaintRows = await db
    .selectFrom('events')
    .innerJoin('messages', 'messages.message_id', 'events.message_id')
    .select(['messages.ip_pool as ip_pool', db.fn.count<number>('events.id').as('complained')])
    .where('events.event_type', '=', 'complaint')
    .where(sql<boolean>`events.occurred_at >= now() - interval '24 hours'`)
    .groupBy('messages.ip_pool')
    .execute();
  const complaintsByPool = new Map(complaintRows.map((r) => [r.ip_pool, Number(r.complained)]));

  const out: PoolHealth[] = [];
  for (const r of rows) {
    const sent = Number(r.sent);
    const bounced = Number(r.bounced);
    const complained = complaintsByPool.get(r.ip_pool) ?? 0;
    const bounceRate = sent > 0 ? bounced / sent : 0;
    const complaintRate = sent > 0 ? complained / sent : 0;
    const reasons: string[] = [];
    let action: PoolHealth['action'] = 'ok';

    // Only act on a meaningful sample to avoid pausing on 1/2 noise.
    if (sent >= 500) {
      if (bounceRate > BOUNCE_PAUSE_THRESHOLD) {
        action = 'pause';
        reasons.push(`bounce_rate ${(bounceRate * 100).toFixed(2)}% > ${(BOUNCE_PAUSE_THRESHOLD * 100).toFixed(1)}%`);
      } else if (bounceRate > BOUNCE_PAUSE_THRESHOLD * 0.6) {
        action = 'throttle';
        reasons.push(`bounce_rate elevated ${(bounceRate * 100).toFixed(2)}%`);
      }
      if (complaintRate > COMPLAINT_PAUSE_THRESHOLD) {
        action = 'pause';
        reasons.push(`complaint_rate ${(complaintRate * 100).toFixed(3)}% > ${(COMPLAINT_PAUSE_THRESHOLD * 100).toFixed(1)}%`);
      }
    }

    await redis.set(`pool:action:${r.ip_pool}`, action, 'EX', 3600);
    out.push({ pool: r.ip_pool, sent, bounced, complained, bounce_rate: bounceRate, complaint_rate: complaintRate, action, reasons });
  }
  return out;
}

/** The send path calls this; 'pause' rejects, 'throttle' slows (handled by caller). */
export async function poolAction(pool: string): Promise<'ok' | 'throttle' | 'pause'> {
  const v = await redis.get(`pool:action:${pool}`);
  return (v as any) ?? 'ok';
}

// =====================================================
// DNSBL blocklist monitoring
// =====================================================
const DNSBLS: Array<{ provider: string; zone: string }> = [
  { provider: 'spamhaus_zen', zone: 'zen.spamhaus.org' },
  { provider: 'spamcop', zone: 'bl.spamcop.net' },
  { provider: 'barracuda', zone: 'b.barracudacentral.org' },
  { provider: 'sorbs', zone: 'dnsbl.sorbs.net' },
];

function reverseIp(ip: string): string {
  return ip.split('.').reverse().join('.');
}

/** Check a single IPv4 address against the DNSBLs and persist results. */
export async function checkBlocklists(ip: string): Promise<Array<{ provider: string; listed: boolean; code?: string }>> {
  const reversed = reverseIp(ip);
  const results = await Promise.all(
    DNSBLS.map(async ({ provider, zone }) => {
      try {
        const addrs = await dns.resolve4(`${reversed}.${zone}`);
        return { provider, listed: addrs.length > 0, code: addrs[0] };
      } catch (err: any) {
        // NXDOMAIN = not listed (the normal, healthy case)
        if (err?.code === 'ENOTFOUND' || err?.code === 'ENODATA') return { provider, listed: false };
        return { provider, listed: false, code: `error:${err?.code ?? 'unknown'}` };
      }
    })
  );
  if (results.length) {
    await db
      .insertInto('blocklist_checks')
      .values(results.map((r) => ({ ip, provider: r.provider, listed: r.listed, return_code: r.code ?? null })))
      .execute();
  }
  return results;
}

/** Run blocklist checks for every active sending IP. Returns any new listings. */
export async function monitorAllBlocklists(): Promise<Array<{ ip: string; provider: string; code?: string }>> {
  const ips = await db.selectFrom('sending_ips').select('ip').where('status', '=', 'active').execute();
  const listings: Array<{ ip: string; provider: string; code?: string }> = [];
  for (const { ip } of ips) {
    const results = await checkBlocklists(String(ip));
    for (const r of results) if (r.listed) listings.push({ ip: String(ip), provider: r.provider, code: r.code });
  }
  return listings;
}

// =====================================================
// Per-IP warmup ramp
// =====================================================
/**
 * Advance each active IP's warmup_stage by one per day, but only if it actually
 * used a healthy fraction of yesterday's cap (proving real, deliverable volume).
 * Run daily via cron.
 */
export async function advanceIpWarmup(): Promise<Array<{ ip: string; from: number; to: number }>> {
  const ips = await db
    .selectFrom('sending_ips')
    .select(['ip', 'warmup_stage'])
    .where('status', '=', 'active')
    .execute();
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const advanced: Array<{ ip: string; from: number; to: number }> = [];

  for (const ip of ips) {
    const used = Number((await redis.get(`warmup:ip:${ip.ip}:${yesterday}`)) ?? 0);
    const cap = dailyCapForStage(ip.warmup_stage);
    if (used >= cap * 0.8 && cap !== Number.MAX_SAFE_INTEGER) {
      await db.updateTable('sending_ips').set({ warmup_stage: ip.warmup_stage + 1 }).where('ip', '=', ip.ip).execute();
      advanced.push({ ip: String(ip.ip), from: ip.warmup_stage, to: ip.warmup_stage + 1 });
    }
  }
  return advanced;
}

/** Record sends against a specific IP's daily warmup counter. */
export async function recordIpSends(ip: string, count: number): Promise<void> {
  const key = `warmup:ip:${ip}:${new Date().toISOString().slice(0, 10)}`;
  await redis.incrby(key, count);
  await redis.expire(key, 172800);
}

// =====================================================
// Postmaster / SNDS ingestion (shape; wire to the real APIs with credentials)
// =====================================================
export interface ReputationSnapshot {
  ip: string;
  date: string;
  google_reputation?: string;
  google_spam_rate?: number;
  snds_color?: string;
}

/** Persist a reputation snapshot pulled from Google Postmaster / Microsoft SNDS. */
export async function recordReputationSnapshot(s: ReputationSnapshot): Promise<void> {
  await db
    .insertInto('ip_reputation')
    .values({
      ip: s.ip,
      snapshot_date: s.date,
      google_reputation: s.google_reputation ?? null,
      google_spam_rate: s.google_spam_rate ?? null,
      snds_color: s.snds_color ?? null,
    })
    .onConflict((oc) =>
      oc.columns(['ip', 'snapshot_date']).doUpdateSet({
        google_reputation: s.google_reputation ?? null,
        google_spam_rate: s.google_spam_rate ?? null,
        snds_color: s.snds_color ?? null,
      })
    )
    .execute();
}

// =====================================================
// Google Postmaster Tools + Microsoft SNDS API polling
// =====================================================

const GPT_API = 'https://gmailpostmastertools.googleapis.com/v1';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface ServiceAccountKey {
  private_key: string;
  client_email: string;
}

async function getGoogleAccessToken(saKeyJson: string): Promise<string> {
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(saKeyJson) as ServiceAccountKey;
  } catch {
    throw new Error('GOOGLE_POSTMASTER_SA_KEY_JSON is not valid JSON');
  }

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: key.client_email,
    sub: key.client_email,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/postmaster.readonly',
  })).toString('base64url');

  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(key.private_key, 'base64url');

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${payload}.${signature}`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Google OAuth2 token exchange failed: ${resp.status} ${text}`);
  }
  return ((await resp.json()) as { access_token: string }).access_token;
}

async function fetchGooglePostmasterStats(accessToken: string): Promise<void> {
  const domainsResp = await fetch(`${GPT_API}/domains`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!domainsResp.ok) throw new Error(`Postmaster list domains failed: ${domainsResp.status}`);
  const domainsData = (await domainsResp.json()) as { domains?: Array<{ name: string }> };
  const domains = domainsData.domains ?? [];

  const ips = await db.selectFrom('sending_ips').select('ip').where('status', '=', 'active').execute();
  if (ips.length === 0 || domains.length === 0) return;

  for (const { name: domainResource } of domains) {
    const statsResp = await fetch(`${GPT_API}/${domainResource}/trafficStats?pageSize=7`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!statsResp.ok) continue;
    const statsData = (await statsResp.json()) as {
      trafficStats?: Array<{ name: string; domainReputation?: string; userReportedSpamRatio?: number }>;
    };
    const latest = statsData.trafficStats?.[0];
    if (!latest) continue;

    // "domains/example.com/trafficStats/20240615" → "2024-06-15"
    const raw = latest.name.split('/').pop() ?? '';
    const date = raw.length === 8
      ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
      : new Date().toISOString().slice(0, 10);

    for (const { ip } of ips) {
      await recordReputationSnapshot({
        ip: String(ip),
        date,
        google_reputation: latest.domainReputation,
        google_spam_rate: latest.userReportedSpamRatio,
      });
    }
  }
}

async function fetchSndsStats(apiKey: string): Promise<void> {
  const resp = await fetch(
    `https://sendersupport.olc.protection.outlook.com/snds/data.aspx?key=${encodeURIComponent(apiKey)}`,
    { signal: AbortSignal.timeout(30_000) }
  );
  if (!resp.ok) throw new Error(`SNDS fetch failed: ${resp.status}`);
  const text = await resp.text();
  const today = new Date().toISOString().slice(0, 10);

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sep = trimmed.includes('\t') ? '\t' : ',';
    const cols = trimmed.split(sep).map((c) => c.trim());
    if (cols.length < 2) continue;
    const ip = cols[0];
    if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) continue;
    if (ip.split('.').some((o) => parseInt(o, 10) > 255)) continue;
    let sndsColor: string | undefined;
    for (const col of cols) {
      const v = col.toLowerCase();
      if (v === 'green' || v === 'yellow' || v === 'red') { sndsColor = v; break; }
    }
    if (!sndsColor) continue;
    await recordReputationSnapshot({ ip, date: today, snds_color: sndsColor });
  }
}

/**
 * Pull Google Postmaster Tools + Microsoft SNDS data for all registered domains
 * and active sending IPs, then persist via recordReputationSnapshot().
 * Skips each provider if the relevant env var is absent — safe to call daily.
 */
export async function ingestPostmaster(): Promise<{ google: boolean; snds: boolean }> {
  let google = false;
  let snds = false;

  const saKeyJson = process.env.GOOGLE_POSTMASTER_SA_KEY_JSON;
  if (saKeyJson) {
    const accessToken = await getGoogleAccessToken(saKeyJson);
    await fetchGooglePostmasterStats(accessToken);
    google = true;
  }

  const sndsKey = process.env.SNDS_API_KEY;
  if (sndsKey) {
    await fetchSndsStats(sndsKey);
    snds = true;
  }

  return { google, snds };
}
