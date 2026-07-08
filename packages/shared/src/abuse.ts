// Abuse / content scanning applied at send time.
// This is a pragmatic first line of defense, NOT a replacement for ML-based
// spam classification. It catches the obvious cases and provides volume-anomaly
// detection hooks. Returns a risk score 0-100 and a list of reasons.

import { redis } from './redis.js';
import { db } from './db.js';

export interface ScanResult {
  score: number;          // 0 (clean) to 100 (block)
  reasons: string[];
  action: 'allow' | 'review' | 'block';
}

// High-signal spam phrases (intentionally conservative to avoid false positives)
const SPAM_PHRASES: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /\b(viagra|cialis|pharmacy)\b/i, weight: 65, label: 'pharma_spam' },
  { pattern: /\bnigerian?\s+prince\b/i, weight: 65, label: 'advance_fee_scam' },
  { pattern: /\b(wire transfer|western union).{0,40}(urgent|immediately)\b/i, weight: 35, label: 'wire_fraud' },
  { pattern: /\bwon\b.{0,40}\b(lottery|prize|million)\b/i, weight: 65, label: 'lottery_scam' },
  { pattern: /\bguaranteed\b.{0,30}\b(income|profit|returns)\b/i, weight: 25, label: 'financial_scam' },
  { pattern: /\b(crypto|bitcoin).{0,30}\b(double|guaranteed|10x|100x)\b/i, weight: 35, label: 'crypto_scam' },
  { pattern: /\bverify\s+your\s+account\b.{0,60}\b(suspend|click here|immediately)\b/i, weight: 30, label: 'phishing' },
];

const SUSPICIOUS_PATTERNS: Array<{ pattern: RegExp; weight: number; label: string }> = [
  { pattern: /(.)\1{15,}/, weight: 15, label: 'char_repetition' },
  { pattern: /[A-Z\s!]{40,}/, weight: 10, label: 'excessive_caps' },
  { pattern: /(\$|usd|eur)\s?\d{4,}/i, weight: 8, label: 'large_money_amount' },
];

/**
 * Static content scan of subject + body.
 */
export function scanContent(subject: string, html?: string, text?: string): ScanResult {
  const corpus = `${subject}\n${text ?? ''}\n${(html ?? '').replace(/<[^>]+>/g, ' ')}`;
  const reasons: string[] = [];
  let score = 0;

  for (const rule of SPAM_PHRASES) {
    if (rule.pattern.test(corpus)) {
      score += rule.weight;
      reasons.push(rule.label);
    }
  }
  for (const rule of SUSPICIOUS_PATTERNS) {
    if (rule.pattern.test(corpus)) {
      score += rule.weight;
      reasons.push(rule.label);
    }
  }

  // Excessive link count is a weak spam signal
  const linkCount = (html ?? '').match(/<a\s/gi)?.length ?? 0;
  if (linkCount > 30) {
    score += 15;
    reasons.push('excessive_links');
  }

  score = Math.min(score, 100);
  const action: ScanResult['action'] = score >= 60 ? 'block' : score >= 30 ? 'review' : 'allow';
  return { score, reasons, action };
}

/**
 * Volume anomaly detection. Compares this customer's send rate in the current
 * hour against their rolling baseline. Returns true if anomalous.
 *
 * Uses a Redis sorted set / counter per customer per hour.
 */
export async function checkVolumeAnomaly(
  customerId: string,
  incomingCount: number
): Promise<{ anomalous: boolean; currentHour: number; baseline: number }> {
  const hourKey = `vol:${customerId}:${new Date().toISOString().slice(0, 13)}`; // hourly bucket
  const baselineKey = `vol:baseline:${customerId}`;

  // Increment current hour
  const currentHour = await redis.incrby(hourKey, incomingCount);
  await redis.expire(hourKey, 7200); // keep 2h

  // Baseline = EMA stored in Redis, but DURABLY backed by Postgres. A Redis
  // flush must not silently reset detection to permissive: if the cache is
  // cold we reload the last persisted baseline from volume_baselines.
  let baselineRaw = await redis.get(baselineKey);
  if (baselineRaw === null) {
    const row = await db
      .selectFrom('volume_baselines')
      .select('hourly_baseline')
      .where('customer_id', '=', customerId)
      .executeTakeFirst();
    if (row) {
      baselineRaw = String(row.hourly_baseline);
      await redis.set(baselineKey, baselineRaw);
    }
  }
  const baseline = baselineRaw ? Number(baselineRaw) : 0;

  // Anomalous if current hour exceeds 5x baseline AND is over a floor of 100
  const anomalous = baseline > 0 && currentHour > Math.max(baseline * 5, 100);

  return { anomalous, currentHour, baseline };
}

/**
 * Update the rolling baseline (call hourly via a scheduled job). Persists to
 * Postgres so it survives a Redis flush.
 */
export async function updateVolumeBaseline(customerId: string): Promise<void> {
  const prevHour = new Date(Date.now() - 3600_000).toISOString().slice(0, 13);
  const hourKey = `vol:${customerId}:${prevHour}`;
  const baselineKey = `vol:baseline:${customerId}`;

  const lastHour = Number((await redis.get(hourKey)) ?? 0);
  const baseline = Number((await redis.get(baselineKey)) ?? 0);

  // EMA with alpha = 0.3
  const newBaseline = Math.round(baseline === 0 ? lastHour : 0.3 * lastHour + 0.7 * baseline);
  await redis.set(baselineKey, String(newBaseline));
  await db
    .insertInto('volume_baselines')
    .values({ customer_id: customerId, hourly_baseline: newBaseline })
    .onConflict((oc) =>
      oc.column('customer_id').doUpdateSet({ hourly_baseline: newBaseline, updated_at: new Date() })
    )
    .execute();
}
