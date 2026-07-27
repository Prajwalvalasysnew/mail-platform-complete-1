// CANSPAM-08 (compliance implementation plan): per-sender complaint, bounce
// and unsubscribe monitoring with automated holds and reviewer evidence.
//
// reputation.ts already watches IP-POOL health and can throttle or pause a
// pool. That protects the shared sending infrastructure but says nothing about
// WHICH tenant caused the damage, and it cannot hold one sender while the rest
// of the pool keeps sending. CANSPAM-08 is about governing senders — a
// customer, agency, affiliate or reseller mailing people who did not ask to
// hear from them.
//
// THREE DESIGN DECISIONS WORTH KNOWING ABOUT:
//
// 1. Minimum volume. A tenant with 1 complaint out of 10 messages has a 10%
//    complaint rate. Judging that would hold every new legitimate sender on
//    their first small campaign. No verdict above 'ok' is issued below
//    SENDER_HEALTH_MIN_VOLUME.
//
// 2. Unsubscribes never trigger a hold. People unsubscribing is HEALTHY — it
//    is the opt-out working. A high rate is a list-quality signal worth
//    surfacing, but blocking a sender for honouring opt-outs would punish
//    exactly the behaviour CAN-SPAM requires.
//
// 3. The action is 'hold', not 'suspend'. Suspension is a commercial decision
//    with contractual consequences. A hold stops NEW sends pending human
//    review and is reversible by a reviewer — the proportionate automated
//    response, and the one that produces the reviewer evidence the control
//    asks for.

import { sql } from 'kysely';
import { db } from './db.js';
import type { DbExecutor } from './db.js';

export const SENDER_HEALTH_WINDOW_DAYS = Number(process.env.SENDER_HEALTH_WINDOW_DAYS ?? 7);
export const SENDER_HEALTH_MIN_VOLUME = Number(process.env.SENDER_HEALTH_MIN_VOLUME ?? 500);

// Complaint thresholds track the major mailbox providers' bulk-sender
// guidance, where 0.3% is the stated hard limit.
export const COMPLAINT_WATCH = Number(process.env.SENDER_COMPLAINT_WATCH ?? 0.001);
export const COMPLAINT_HOLD = Number(process.env.SENDER_COMPLAINT_HOLD ?? 0.003);
export const BOUNCE_WATCH = Number(process.env.SENDER_BOUNCE_WATCH ?? 0.03);
export const BOUNCE_HOLD = Number(process.env.SENDER_BOUNCE_HOLD ?? 0.05);
// Watch only — see design decision 2.
export const UNSUBSCRIBE_WATCH = Number(process.env.SENDER_UNSUBSCRIBE_WATCH ?? 0.005);

export type SenderVerdict = 'ok' | 'watch' | 'hold';

export interface SenderHealth {
  customer_id: string;
  window_start: Date;
  window_end: Date;
  sent: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  bounce_rate: number;
  complaint_rate: number;
  unsubscribe_rate: number;
  verdict: SenderVerdict;
  triggered_by: string[];
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** Compute a tenant's sending health over the rolling window. */
export async function evaluateSenderHealth(
  customerId: string,
  opts: { windowDays?: number } = {},
  executor: DbExecutor = db,
): Promise<SenderHealth> {
  const windowDays = opts.windowDays ?? SENDER_HEALTH_WINDOW_DAYS;
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowDays * 86_400_000);

  const usage = await executor
    .selectFrom('usage_daily')
    .select((eb) => [
      eb.fn.sum<number>('sent').as('sent'),
      eb.fn.sum<number>('bounced').as('bounced'),
      eb.fn.sum<number>('complained').as('complained'),
    ])
    .where('customer_id', '=', customerId)
    .where('usage_date', '>=', windowStart.toISOString().slice(0, 10) as never)
    .executeTakeFirst();

  // Unsubscribes are not in usage_daily; the consent ledger is authoritative.
  const unsub = await executor
    .selectFrom('consent_events')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('customer_id', '=', customerId)
    .where('action', '=', 'suppress')
    .where('reason', '=', 'unsubscribe')
    .where(sql<boolean>`created_at >= ${windowStart}::timestamptz`)
    .executeTakeFirst();

  const sent = Number(usage?.sent ?? 0);
  const bounced = Number(usage?.bounced ?? 0);
  const complained = Number(usage?.complained ?? 0);
  const unsubscribed = Number((unsub as any)?.n ?? 0);

  const bounceRate = rate(bounced, sent);
  const complaintRate = rate(complained, sent);
  const unsubscribeRate = rate(unsubscribed, sent);

  const triggered: string[] = [];
  let verdict: SenderVerdict = 'ok';

  // Below the minimum volume no verdict above 'ok' is issued: the rates are
  // not statistically meaningful and would hold new legitimate senders.
  if (sent >= SENDER_HEALTH_MIN_VOLUME) {
    if (complaintRate >= COMPLAINT_HOLD) { verdict = 'hold'; triggered.push('complaint_rate'); }
    else if (complaintRate >= COMPLAINT_WATCH) { verdict = 'watch'; triggered.push('complaint_rate'); }

    if (bounceRate >= BOUNCE_HOLD) { verdict = 'hold'; triggered.push('bounce_rate'); }
    else if (bounceRate >= BOUNCE_WATCH && verdict !== 'hold') { verdict = 'watch'; triggered.push('bounce_rate'); }

    // Never escalates to a hold — honouring opt-outs is the required behaviour.
    if (unsubscribeRate >= UNSUBSCRIBE_WATCH) {
      if (verdict === 'ok') verdict = 'watch';
      triggered.push('unsubscribe_rate');
    }
  }

  return {
    customer_id: customerId,
    window_start: windowStart,
    window_end: windowEnd,
    sent, bounced, complained, unsubscribed,
    bounce_rate: bounceRate,
    complaint_rate: complaintRate,
    unsubscribe_rate: unsubscribeRate,
    verdict,
    triggered_by: [...new Set(triggered)],
  };
}

/**
 * Is this tenant currently blocked from sending?
 *
 * A hold is active while it is UNREVIEWED, and stays active if a reviewer
 * UPHELD or ESCALATED it. Only an explicit 'released' decision lifts it —
 * treating "reviewed" as "resolved" would mean confirming a hold silently
 * unblocked the sender, which is the opposite of the reviewer's intent.
 */
export async function isSenderOnHold(customerId: string, executor: DbExecutor = db): Promise<boolean> {
  const row = await executor
    .selectFrom('sender_health_runs')
    .select('id')
    .where('customer_id', '=', customerId)
    .where('verdict', '=', 'hold')
    .where((eb) => eb.or([
      eb('reviewed_at', 'is', null),
      eb('review_decision', 'in', ['upheld', 'escalated']),
    ]))
    .executeTakeFirst();
  return !!row;
}

/** Open cases for the reviewer queue: held and not yet decided. */
export async function isSenderHoldUnreviewed(customerId: string, executor: DbExecutor = db): Promise<boolean> {
  const row = await executor
    .selectFrom('sender_health_runs')
    .select('id')
    .where('customer_id', '=', customerId)
    .where('verdict', '=', 'hold')
    .where('reviewed_at', 'is', null)
    .executeTakeFirst();
  return !!row;
}

export interface SweepResult {
  evaluated: number;
  watch: number;
  held: number;
  /** Tenants already on hold, so re-evaluation did not double-record. */
  already_held: number;
}

/**
 * Evaluate every tenant that sent in the window and record the outcome.
 *
 * A tenant already under an unreviewed hold is re-evaluated but NOT
 * re-recorded as a new hold — otherwise a daily sweep would bury the reviewer
 * queue in duplicates of the same unresolved case.
 */
export async function sweepSenderHealth(opts: { windowDays?: number } = {}): Promise<SweepResult> {
  const windowDays = opts.windowDays ?? SENDER_HEALTH_WINDOW_DAYS;
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);

  const senders = await db
    .selectFrom('usage_daily')
    .select('customer_id')
    .where('usage_date', '>=', since as never)
    .groupBy('customer_id')
    .execute();

  const result: SweepResult = { evaluated: 0, watch: 0, held: 0, already_held: 0 };

  for (const { customer_id } of senders) {
    const health = await evaluateSenderHealth(customer_id, { windowDays });
    result.evaluated++;
    if (health.verdict === 'ok') continue;

    if (health.verdict === 'hold' && (await isSenderHoldUnreviewed(customer_id))) {
      result.already_held++;
      continue;
    }

    await db.insertInto('sender_health_runs').values({
      customer_id,
      window_start: health.window_start,
      window_end: health.window_end,
      sent: health.sent,
      bounced: health.bounced,
      complained: health.complained,
      unsubscribed: health.unsubscribed,
      bounce_rate: health.bounce_rate.toFixed(5),
      complaint_rate: health.complaint_rate.toFixed(5),
      unsubscribe_rate: health.unsubscribe_rate.toFixed(5),
      verdict: health.verdict,
      triggered_by: health.triggered_by,
      action_taken: health.verdict === 'hold' ? 'held' : 'alerted',
    } as any).execute();

    if (health.verdict === 'hold') result.held++;
    else result.watch++;
  }

  return result;
}

/** Reviewer queue: open holds and recent watch records. */
export async function listSenderHealthRuns(opts: {
  openHoldsOnly?: boolean;
  customerId?: string;
  limit?: number;
} = {}): Promise<any[]> {
  let q = db
    .selectFrom('sender_health_runs')
    .selectAll()
    .orderBy('created_at', 'desc')
    .limit(Math.min(Math.max(1, opts.limit ?? 100), 500));
  if (opts.customerId) q = q.where('customer_id', '=', opts.customerId);
  if (opts.openHoldsOnly) q = q.where('verdict', '=', 'hold').where('reviewed_at', 'is', null);
  return q.execute();
}

export class SenderHealthReviewError extends Error {
  readonly code = 'not_found';
}

/**
 * Record a reviewer decision. This is what closes the control: an automated
 * hold that nobody ever looks at is an outage, not governance.
 *
 * 'released' lifts the hold; 'upheld' and 'escalated' keep the sender blocked
 * while recording that a human confirmed it — escalation to suspension stays a
 * separate, deliberate action.
 */
export async function reviewSenderHealth(input: {
  runId: string;
  decision: 'released' | 'upheld' | 'escalated';
  reviewedBy: string;
  notes?: string | null;
}): Promise<void> {
  const res = await db
    .updateTable('sender_health_runs')
    .set({
      reviewed_at: new Date(),
      reviewed_by: input.reviewedBy,
      review_decision: input.decision,
      review_notes: input.notes ?? null,
    } as any)
    .where('id', '=', input.runId)
    .where('reviewed_at', 'is', null)
    .executeTakeFirst();

  if (Number(res?.numUpdatedRows ?? 0) === 0) {
    throw new SenderHealthReviewError('No open sender-health run with that id.');
  }
}
