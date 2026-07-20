// Critical-priority send lane.
//
// OTPs, fraud alerts, and outage notifications cannot sit behind a marketing
// burst. `priority: "critical"` on /v1/send puts a message at the head of the
// queue (BullMQ priority 1) regardless of the account's tier default.
//
// Guardrails so the lane stays fast for everyone:
//   - free tier is not eligible (downgraded to the standard lane), and
//   - a per-customer per-minute cap (CRITICAL_LANE_PER_MINUTE, default 120)
//     downgrades overflow to standard instead of rejecting the send — the
//     mail still goes out, the response says which lane applied.

import { redis } from './redis.js';

export type SendLane = 'critical' | 'standard';

export interface LaneDecision {
  lane: SendLane;
  /** BullMQ priority for the outbox row (1 = head of queue). */
  priority: number;
  /** Present when a requested critical lane was not granted. */
  downgraded_reason?: 'tier_not_eligible' | 'rate_capped';
}

const CRITICAL_LANE_PER_MINUTE = Number(process.env.CRITICAL_LANE_PER_MINUTE ?? 120);

export function tierPriority(tier: string): number {
  return tier === 'enterprise' ? 1 : tier === 'paid' ? 5 : 10;
}

/** Prometheus label for a queue-priority value (stable, low-cardinality). */
export function laneLabel(priority: number | undefined): string {
  const p = priority ?? 10;
  return p <= 1 ? 'p1' : p <= 5 ? 'p5' : 'p10';
}

export async function resolveSendLane(
  customerId: string,
  tier: string,
  requested: 'normal' | 'critical' | undefined,
  recipientCount: number
): Promise<LaneDecision> {
  const standard: LaneDecision = { lane: 'standard', priority: tierPriority(tier) };
  if (requested !== 'critical') return standard;
  if (tier !== 'paid' && tier !== 'enterprise') {
    return { ...standard, downgraded_reason: 'tier_not_eligible' };
  }

  const minute = Math.floor(Date.now() / 60_000);
  const key = `lane:critical:${customerId}:${minute}`;
  try {
    const used = await redis.incrby(key, recipientCount);
    if (used === recipientCount) await redis.expire(key, 120);
    if (used > CRITICAL_LANE_PER_MINUTE) {
      return { ...standard, downgraded_reason: 'rate_capped' };
    }
  } catch {
    // Redis blip: fail toward the standard lane rather than an unmetered
    // critical lane.
    return { ...standard, downgraded_reason: 'rate_capped' };
  }
  return { lane: 'critical', priority: 1 };
}
