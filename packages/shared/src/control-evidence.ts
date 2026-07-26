// SOC2-06 (compliance implementation plan): evidence automation.
//
// Every control on this platform produces evidence — unsubscribe monitor runs,
// sender-health verdicts, privacy-case timeliness, erasure completion, audit
// checkpoints, retention sweeps. None of it was collected anywhere an auditor
// could look, and "did this control operate last quarter?" was answerable only
// by hand-querying eight tables.
//
// TWO RULES THIS MODULE IS BUILT AROUND:
//
// 1. MISSING IS A FINDING, NOT A BLANK. "The job never ran" and "nothing
//    happened" produce the same empty result set. Every collector therefore
//    returns an explicit completeness verdict, and 'missing' is a distinct
//    outcome from a zero count. A silent control is the failure mode auditors
//    care about most, and it is invisible unless something asserts it.
//
// 2. NO SECRETS, NO PERSONAL DATA. Metrics are counts and timestamps. An
//    evidence store is something auditors get time-bounded access to; it must
//    not become a second copy of the data these controls exist to protect.
//    assertEvidenceIsSafe() enforces this and is exercised by the tests.

import { sql } from 'kysely';
import { db } from './db.js';

export type Completeness = 'complete' | 'partial' | 'missing';

export interface ControlEvidence {
  control_id: string;
  metrics: Record<string, unknown>;
  completeness: Completeness;
  notes?: string | null;
}

export interface EvidencePeriod {
  start: Date;
  end: Date;
}

/**
 * Reject anything that looks like personal data or a secret before it is
 * written to the evidence store.
 *
 * Deliberately crude and deliberately loud: the cost of a false positive is a
 * developer rewording a metric name, and the cost of a false negative is
 * recipient addresses sitting in the system auditors are given access to.
 */
export function assertEvidenceIsSafe(controlId: string, metrics: Record<string, unknown>): void {
  const json = JSON.stringify(metrics);
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(json)) {
    throw new Error(`evidence_contains_pii: ${controlId} metrics contain an email address`);
  }
  if (/\b(secret|token|password|api[_-]?key|private[_-]?key)\b/i.test(json)) {
    throw new Error(`evidence_contains_secret: ${controlId} metrics reference a credential`);
  }
}

// ─── Per-control collectors ─────────────────────────────────────────────────

async function canspam05(p: EvidencePeriod): Promise<ControlEvidence> {
  const rows = await db.selectFrom('unsubscribe_monitor_runs')
    .select(['kind', 'ok'])
    .where(sql<boolean>`run_at BETWEEN ${p.start} AND ${p.end}`)
    .execute();

  const total = rows.length;
  const failed = rows.filter((r) => !r.ok).length;
  const kinds = new Set(rows.map((r) => r.kind));

  return {
    control_id: 'CANSPAM-05',
    metrics: {
      monitor_runs: total,
      failed_runs: failed,
      kinds_exercised: [...kinds].sort(),
    },
    // The control claims continuous availability monitoring. No runs at all
    // means the monitor stopped, which is the thing the control exists to
    // detect — reporting it as "0 failures" would be actively misleading.
    completeness: total === 0 ? 'missing' : failed > 0 ? 'partial' : 'complete',
    notes: total === 0
      ? 'No unsubscribe monitor runs in the period — the scheduled monitor did not run.'
      : failed > 0 ? `${failed} monitor run(s) failed.` : null,
  };
}

async function canspam08(p: EvidencePeriod): Promise<ControlEvidence> {
  const rows = await db.selectFrom('sender_health_runs')
    .select(['verdict', 'reviewed_at'])
    .where(sql<boolean>`created_at BETWEEN ${p.start} AND ${p.end}`)
    .execute();

  const holds = rows.filter((r) => r.verdict === 'hold');
  const unreviewedHolds = holds.filter((r) => !r.reviewed_at).length;

  return {
    control_id: 'CANSPAM-08',
    metrics: {
      verdicts_recorded: rows.length,
      watch: rows.filter((r) => r.verdict === 'watch').length,
      holds: holds.length,
      holds_unreviewed: unreviewedHolds,
    },
    // A clean period genuinely can produce no verdicts, so zero is 'complete'
    // here — unlike the monitor above, this control only writes when a
    // threshold is crossed. An unreviewed hold IS a gap: the reviewer decision
    // is what closes the control.
    completeness: unreviewedHolds > 0 ? 'partial' : 'complete',
    notes: unreviewedHolds > 0
      ? `${unreviewedHolds} automated sending hold(s) awaiting reviewer decision.`
      : null,
  };
}

async function base06(p: EvidencePeriod): Promise<ControlEvidence> {
  const runs = await db.selectFrom('retention_runs')
    .select(['error', 'duration_ms'])
    .where(sql<boolean>`finished_at BETWEEN ${p.start} AND ${p.end}`)
    .execute();

  const failures = runs.filter((r) => r.error !== null).length;

  return {
    control_id: 'BASE-06',
    metrics: {
      retention_runs: runs.length,
      failed_runs: failures,
      max_duration_ms: runs.reduce((m, r) => Math.max(m, Number(r.duration_ms ?? 0)), 0),
    },
    // Silent non-deletion is the failure that matters: nothing looks broken
    // while data accumulates past its window.
    completeness: runs.length === 0 ? 'missing' : failures > 0 ? 'partial' : 'complete',
    notes: runs.length === 0
      ? 'No retention sweep completed in the period — data may be accumulating past its window.'
      : failures > 0 ? `${failures} retention sweep(s) failed.` : null,
  };
}

async function privacyRequests(p: EvidencePeriod): Promise<ControlEvidence> {
  const cases = await db.selectFrom('privacy_cases')
    .select(['status', 'due_at', 'extended_until', 'closed_at'])
    .where(sql<boolean>`received_at BETWEEN ${p.start} AND ${p.end}`)
    .execute();

  const now = new Date();
  const open = cases.filter((c) => !['fulfilled', 'denied', 'closed'].includes(c.status as string));
  const overdue = open.filter((c) => {
    const deadline = new Date((c.extended_until ?? c.due_at) as unknown as string);
    return deadline < now;
  }).length;

  const appeals = await db.selectFrom('privacy_case_appeals')
    .select(['status', 'due_at'])
    .where(sql<boolean>`submitted_at BETWEEN ${p.start} AND ${p.end}`)
    .execute();
  const appealsOverdue = appeals.filter(
    (a) => a.status === 'received' && new Date(a.due_at as unknown as string) < now,
  ).length;

  return {
    control_id: 'BASE-05',
    metrics: {
      cases_received: cases.length,
      cases_open: open.length,
      cases_overdue: overdue,
      cases_fulfilled: cases.filter((c) => c.status === 'fulfilled').length,
      cases_denied: cases.filter((c) => c.status === 'denied').length,
      appeals_received: appeals.length,
      appeals_overdue: appealsOverdue,
    },
    // Statutory deadlines are the whole control; missing one is a partial
    // result even if every other number looks healthy.
    completeness: overdue > 0 || appealsOverdue > 0 ? 'partial' : 'complete',
    notes: overdue > 0 || appealsOverdue > 0
      ? `${overdue} case(s) and ${appealsOverdue} appeal(s) past their statutory deadline.`
      : null,
  };
}

async function base03(p: EvidencePeriod): Promise<ControlEvidence> {
  const requests = await db.selectFrom('deletion_requests')
    .select(['status'])
    .where(sql<boolean>`created_at BETWEEN ${p.start} AND ${p.end}`)
    .execute();

  const failed = requests.filter((r) => r.status === 'failed').length;
  const pending = requests.filter((r) => r.status === 'pending').length;

  return {
    control_id: 'BASE-03',
    metrics: {
      erasure_requests: requests.length,
      completed: requests.filter((r) => r.status === 'completed').length,
      pending,
      failed,
    },
    // A failed erasure means a data subject's request is unfulfilled and their
    // own statutory clock is running.
    completeness: failed > 0 ? 'partial' : 'complete',
    notes: failed > 0 ? `${failed} erasure(s) failed and need manual remediation.` : null,
  };
}

async function pci02(p: EvidencePeriod): Promise<ControlEvidence> {
  const rows = await db.selectFrom('audit_log')
    .select((eb) => eb.fn.countAll().as('n'))
    .where('action', '=', 'card_data_detected')
    .where(sql<boolean>`occurred_at BETWEEN ${p.start} AND ${p.end}`)
    .executeTakeFirst();

  const detections = Number((rows as any)?.n ?? 0);
  return {
    control_id: 'PCI-02',
    metrics: { card_data_detections: detections },
    // Zero detections is the expected healthy state for this one.
    completeness: 'complete',
    notes: detections > 0
      ? `${detections} card-data detection(s) — see runbooks/CARD_DATA.md for the containment record.`
      : null,
  };
}

async function base10(p: EvidencePeriod): Promise<ControlEvidence> {
  const rows = await db.selectFrom('audit_checkpoints')
    .select((eb) => eb.fn.countAll().as('n'))
    .where(sql<boolean>`checkpoint_at BETWEEN ${p.start} AND ${p.end}`)
    .executeTakeFirst();

  const checkpoints = Number((rows as any)?.n ?? 0);
  return {
    control_id: 'BASE-10',
    metrics: { audit_checkpoints: checkpoints },
    completeness: checkpoints === 0 ? 'missing' : 'complete',
    notes: checkpoints === 0
      ? 'No audit-chain checkpoints in the period — tamper-evidence is unverified for this window.'
      : null,
  };
}

const COLLECTORS = [canspam05, canspam08, base06, privacyRequests, base03, pci02, base10];

/**
 * Collect evidence for every instrumented control over a period.
 *
 * Idempotent per (control, period): re-running updates the row rather than
 * duplicating it, so a re-collection after fixing a gap replaces the finding
 * instead of leaving two contradictory records.
 */
export async function collectControlEvidence(period: EvidencePeriod): Promise<ControlEvidence[]> {
  const collected: ControlEvidence[] = [];

  for (const collector of COLLECTORS) {
    const evidence = await collector(period);
    assertEvidenceIsSafe(evidence.control_id, evidence.metrics);

    await db.insertInto('control_evidence_runs').values({
      control_id: evidence.control_id,
      period_start: period.start,
      period_end: period.end,
      metrics: JSON.stringify(evidence.metrics) as never,
      completeness: evidence.completeness,
      notes: evidence.notes ?? null,
    } as never)
      .onConflict((oc) => oc
        .columns(['control_id', 'period_start', 'period_end'])
        .doUpdateSet({
          metrics: JSON.stringify(evidence.metrics) as never,
          completeness: evidence.completeness,
          notes: evidence.notes ?? null,
          collected_at: new Date(),
          // A re-collection invalidates any prior sign-off: the reviewer
          // approved different numbers.
          reviewed_at: null,
          reviewed_by: null,
          review_note: null,
        } as never))
      .execute();

    collected.push(evidence);
  }

  return collected;
}

/** The previous complete calendar month, in UTC. */
export function previousMonthPeriod(now: Date = new Date()): EvidencePeriod {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { start, end };
}

/**
 * Scheduled collection for the previous complete month.
 *
 * The scheduler ticks daily, but a closed month must be collected exactly
 * once: collectControlEvidence() clears reviewer sign-off on re-collection
 * (correct for a deliberate re-run — the reviewer approved different numbers),
 * and a daily re-run would therefore wipe an approval every night. So this
 * returns null when the period is already on file and leaves the row alone.
 */
export async function collectMonthlyControlEvidence(
  now: Date = new Date(),
): Promise<{ period: EvidencePeriod; evidence: ControlEvidence[] } | null> {
  const period = previousMonthPeriod(now);
  const existing = await db.selectFrom('control_evidence_runs')
    .select('id')
    .where('period_start', '=', period.start)
    .where('period_end', '=', period.end)
    .executeTakeFirst();
  if (existing) return null;

  return { period, evidence: await collectControlEvidence(period) };
}

export async function listControlEvidence(opts: {
  controlId?: string;
  unreviewedOnly?: boolean;
  limit?: number;
} = {}): Promise<any[]> {
  let q = db.selectFrom('control_evidence_runs').selectAll()
    .orderBy('period_end', 'desc')
    .limit(Math.min(Math.max(1, opts.limit ?? 100), 500));
  if (opts.controlId) q = q.where('control_id', '=', opts.controlId);
  if (opts.unreviewedOnly) q = q.where('reviewed_at', 'is', null);
  return q.execute();
}

export class EvidenceReviewError extends Error {
  readonly code = 'not_found';
}

/**
 * Record reviewer sign-off. Evidence nobody looked at does not demonstrate
 * operating effectiveness, which is precisely what an auditor tests.
 */
export async function reviewControlEvidence(input: {
  id: string;
  reviewedBy: string;
  note?: string | null;
}): Promise<void> {
  const res = await db.updateTable('control_evidence_runs')
    .set({
      reviewed_at: new Date(),
      reviewed_by: input.reviewedBy,
      review_note: input.note ?? null,
    } as never)
    .where('id', '=', input.id)
    .where('reviewed_at', 'is', null)
    .executeTakeFirst();

  if (Number(res?.numUpdatedRows ?? 0) === 0) {
    throw new EvidenceReviewError('No unreviewed evidence record with that id.');
  }
}
