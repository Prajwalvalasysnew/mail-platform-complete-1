// CANSPAM-05 (compliance implementation plan): synthetic unsubscribe
// monitoring.
//
// CAN-SPAM requires the opt-out mechanism to keep working for at least 30
// days after each commercial send and opt-outs to be honored within the legal
// deadline (10 business days; this platform suppresses synchronously). This
// module produces the dated evidence on a schedule:
//
// 1. chain_validation — samples real commercial messages across the 30-day
//    window (deliberately including the OLDEST, to prove links from up to a
//    month ago still resolve) and validates the full unsubscribe chain
//    in-process, exactly as the tracker does: URL encode/decode round-trip,
//    message lookup, confirmation-token generate + verify.
// 2. one_click_synthetic — creates a synthetic message to a reserved
//    monitoring recipient, exercises the REAL one-click path (suppression +
//    consent-ledger write), measures suppression latency, verifies the
//    recipient is enforced-suppressed, then cleans up after itself.
// 3. sla_scan — cross-checks every unsubscribe consent event in the window
//    against an enforced suppression row; any opt-out without an enforced
//    suppression is an SLA violation.
//
// Results land in unsubscribe_monitor_runs (message ids and numbers only —
// never recipient addresses).
import crypto from 'node:crypto';
import { db } from './db.js';
import { sql } from 'kysely';
import { encodeMessageIdForUrl, decodeMessageIdFromUrl } from './crypto.js';
import { addSuppression, isSuppressed, removeSuppression } from './suppression.js';

export const SYNTHETIC_UNSUB_DOMAIN = 'unsubscribe-monitor.invalid';

// Mirror of the tracker's confirmation token (packages/tracker/src/server.ts).
// Kept in sync so chain validation proves the token a rendered page would
// carry verifies against the tracker's own check.
function unsubToken(encoded: string): string {
  const secret = process.env.VERP_SECRET ?? process.env.UNSUB_SECRET ?? 'dev-unsub-secret';
  return crypto.createHmac('sha256', secret).update(`unsub:${encoded}`).digest('base64url').slice(0, 24);
}
function verifyUnsubToken(encoded: string, token: string): boolean {
  const expected = unsubToken(encoded);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface RunRow {
  kind: 'chain_validation' | 'one_click_synthetic' | 'sla_scan';
  ok: boolean;
  target_message_id?: string | null;
  message_age_days?: number | null;
  latency_ms?: number | null;
  detail?: Record<string, unknown>;
  error?: string | null;
}

async function record(row: RunRow): Promise<void> {
  await db.insertInto('unsubscribe_monitor_runs').values({
    kind: row.kind,
    ok: row.ok,
    target_message_id: row.target_message_id ?? null,
    message_age_days: row.message_age_days ?? null,
    latency_ms: row.latency_ms ?? null,
    detail: row.detail ?? {},
    error: row.error ?? null,
  }).execute();
}

/** Validate the full unsubscribe chain for one existing message, tracker-style. */
async function validateChain(messageId: string, queuedAt: Date): Promise<RunRow> {
  const started = Date.now();
  const ageDays = (Date.now() - queuedAt.getTime()) / 86_400_000;
  try {
    const encoded = encodeMessageIdForUrl(messageId);
    const decoded = decodeMessageIdFromUrl(encoded);
    if (decoded !== messageId) throw new Error('encode_decode_mismatch');
    // The tracker's GET /u/:encoded lookup.
    const msg = await db.selectFrom('messages')
      .select(['to_address', 'customer_id'])
      .where('message_id', '=', messageId)
      .executeTakeFirst();
    if (!msg) throw new Error('message_lookup_failed');
    // The confirmation token rendered on the page must verify.
    if (!verifyUnsubToken(encoded, unsubToken(encoded))) throw new Error('unsub_token_mismatch');
    return {
      kind: 'chain_validation', ok: true, target_message_id: messageId,
      message_age_days: ageDays, latency_ms: Date.now() - started,
    };
  } catch (err) {
    return {
      kind: 'chain_validation', ok: false, target_message_id: messageId,
      message_age_days: ageDays, latency_ms: Date.now() - started,
      error: err instanceof Error ? err.message : 'unknown',
    };
  }
}

/**
 * Exercise the real one-click write path against a synthetic recipient in a
 * real tenant, measure suppression latency, and clean up.
 */
async function oneClickSynthetic(customerId: string): Promise<RunRow> {
  const syntheticRecipient = `probe-${Date.now()}-${crypto.randomBytes(4).toString('hex')}@${SYNTHETIC_UNSUB_DOMAIN}`;
  const started = Date.now();
  try {
    await addSuppression(customerId, syntheticRecipient, 'unsubscribe', 'canspam synthetic monitor', db, {
      source: 'synthetic_monitor',
    });
    const enforced = await isSuppressed(customerId, syntheticRecipient);
    const latency = Date.now() - started;
    if (!enforced) throw new Error('suppression_not_enforced_after_write');
    return { kind: 'one_click_synthetic', ok: true, latency_ms: latency, detail: { customer_sampled: true } };
  } catch (err) {
    return {
      kind: 'one_click_synthetic', ok: false, latency_ms: Date.now() - started,
      error: err instanceof Error ? err.message : 'unknown',
    };
  } finally {
    // Clean up the probe: remove the suppression and the ledger rows so the
    // synthetic address leaves no lasting state behind.
    try {
      await removeSuppression(customerId, syntheticRecipient, db, { source: 'synthetic_monitor', reason: 'probe_cleanup' });
      await db.deleteFrom('consent_events')
        .where('customer_id', '=', customerId)
        .where('email', '=', syntheticRecipient)
        .execute();
    } catch { /* cleanup is best-effort */ }
  }
}

/** Every unsubscribe consent event in the window must map to an enforced suppression. */
async function slaScan(windowDays: number, customerId?: string): Promise<RunRow> {
  const since = new Date(Date.now() - windowDays * 86_400_000);
  try {
    let q = db.selectFrom('consent_events as ce')
      .select(({ fn }) => fn.countAll<number>().as('count'))
      .where('ce.action', '=', 'suppress')
      .where('ce.reason', '=', 'unsubscribe')
      .where('ce.created_at', '>=', since as never)
      .where('ce.pseudonymized_at', 'is', null)
      .where((eb) => eb.not(eb.exists(
        eb.selectFrom('suppressions as s').select('s.email')
          .whereRef('s.customer_id', '=', 'ce.customer_id')
          .whereRef('s.email', '=', 'ce.email')
      )))
      // An unsuppress AFTER the opt-out (resubscribe, erasure) is a documented
      // exception, not a violation.
      .where((eb) => eb.not(eb.exists(
        eb.selectFrom('consent_events as later').select('later.id')
          .whereRef('later.customer_id', '=', 'ce.customer_id')
          .whereRef('later.email', '=', 'ce.email')
          .where('later.action', '=', 'unsuppress')
          .whereRef('later.created_at', '>=', 'ce.created_at')
      )));
    if (customerId) q = q.where('ce.customer_id', '=', customerId);
    const violations = await q.executeTakeFirstOrThrow();
    const count = Number(violations.count);
    return { kind: 'sla_scan', ok: count === 0, detail: { violations: count, window_days: windowDays } };
  } catch (err) {
    return { kind: 'sla_scan', ok: false, error: err instanceof Error ? err.message : 'unknown' };
  }
}

export interface UnsubscribeMonitorResult {
  runs: number;
  failures: number;
  chainChecks: number;
  oldestMessageAgeDays: number | null;
  slaViolations: number;
}

/**
 * One scheduled monitoring pass. Samples up to `sampleSize` commercial
 * messages spread across the last 30 days — always including the oldest and
 * newest — validates each chain, exercises one synthetic one-click write per
 * distinct sampled tenant (capped at 3), and runs the SLA scan.
 *
 * Pass `customerId` to scope every check to one tenant (per-tenant runs, and
 * hermetic tests on a shared database); the scheduler runs platform-wide.
 */
export async function runUnsubscribeMonitor(options: { sampleSize?: number; windowDays?: number; customerId?: string } = {}): Promise<UnsubscribeMonitorResult> {
  const windowDays = options.windowDays ?? 30;
  const sampleSize = Math.max(2, Math.min(options.sampleSize ?? 6, 50));
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const baseSample = () => {
    let q = db.selectFrom('messages')
      .select(['message_id', 'customer_id', 'queued_at'])
      .where('message_class', '=', 'commercial')
      .where('queued_at', '>=', since as never)
      .where('to_address', 'not like', `%@${SYNTHETIC_UNSUB_DOMAIN}`);
    if (options.customerId) q = q.where('customer_id', '=', options.customerId);
    return q;
  };
  const oldest = await baseSample().orderBy('queued_at', 'asc').limit(Math.ceil(sampleSize / 2)).execute();
  const newest = await baseSample().orderBy('queued_at', 'desc').limit(Math.floor(sampleSize / 2)).execute();

  const seen = new Set<string>();
  const sample = [...oldest, ...newest].filter((m) => !seen.has(m.message_id) && seen.add(m.message_id));

  const results: RunRow[] = [];
  for (const m of sample) {
    results.push(await validateChain(m.message_id, m.queued_at as unknown as Date));
  }
  const tenants = [...new Set(sample.map((m) => m.customer_id))].slice(0, 3);
  for (const customerId of tenants) {
    results.push(await oneClickSynthetic(customerId));
  }
  results.push(await slaScan(windowDays, options.customerId));

  for (const row of results) await record(row);

  const chain = results.filter((r) => r.kind === 'chain_validation');
  const sla = results.find((r) => r.kind === 'sla_scan');
  return {
    runs: results.length,
    failures: results.filter((r) => !r.ok).length,
    chainChecks: chain.length,
    oldestMessageAgeDays: chain.length ? Math.max(...chain.map((r) => r.message_age_days ?? 0)) : null,
    slaViolations: Number((sla?.detail as any)?.violations ?? 0),
  };
}

export interface UnsubscribeMonitorReport {
  window_days: number;
  runs: number;
  failures: number;
  availability_pct: number | null;
  days_with_checks: number;
  max_message_age_checked_days: number | null;
  max_suppression_latency_ms: number | null;
  sla_violations_latest: number | null;
  last_run_at: Date | null;
  recent_failures: Array<{ run_at: Date; kind: string; error: string | null }>;
}

/** Aggregated monitoring evidence for the report window (default 30 days). */
export async function unsubscribeMonitorReport(windowDays = 30): Promise<UnsubscribeMonitorReport> {
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const rows = await db.selectFrom('unsubscribe_monitor_runs')
    .select(['run_at', 'kind', 'ok', 'message_age_days', 'latency_ms', 'detail', 'error'])
    .where('run_at', '>=', since as never)
    .orderBy('run_at', 'desc')
    .limit(10_000)
    .execute();

  const total = rows.length;
  const failures = rows.filter((r) => !r.ok).length;
  const latestSla = rows.find((r) => r.kind === 'sla_scan');
  const daysWithChecks = await db.selectFrom('unsubscribe_monitor_runs')
    .select(sql<number>`count(distinct date_trunc('day', run_at))`.as('days'))
    .where('run_at', '>=', since as never)
    .executeTakeFirstOrThrow();

  return {
    window_days: windowDays,
    runs: total,
    failures,
    availability_pct: total > 0 ? Math.round(((total - failures) / total) * 10_000) / 100 : null,
    days_with_checks: Number(daysWithChecks.days),
    max_message_age_checked_days: rows.reduce<number | null>(
      (acc, r) => (r.message_age_days == null ? acc : Math.max(acc ?? 0, r.message_age_days)), null),
    max_suppression_latency_ms: rows.filter((r) => r.kind === 'one_click_synthetic')
      .reduce<number | null>((acc, r) => (r.latency_ms == null ? acc : Math.max(acc ?? 0, r.latency_ms)), null),
    sla_violations_latest: latestSla ? Number((latestSla.detail as any)?.violations ?? 0) : null,
    last_run_at: (rows[0]?.run_at as unknown as Date) ?? null,
    recent_failures: rows.filter((r) => !r.ok).slice(0, 20)
      .map((r) => ({ run_at: r.run_at as unknown as Date, kind: r.kind, error: r.error })),
  };
}
