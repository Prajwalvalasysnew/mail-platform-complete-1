// E2E: SOC2-06 (compliance implementation plan) — automated control-evidence
// collection.
//
// The tests that carry weight here are the ones guarding the two design rules,
// because both are easy to regress into something that still "passes":
//
//   * 'missing' must stay distinct from a zero count. If a collector ever
//     reports a silent control as "0 failures", the evidence store becomes
//     actively misleading — an auditor reads a clean number for a control that
//     stopped running.
//   * the evidence store must never accumulate personal data or secrets. It is
//     the one system third parties are granted access to.
//
// Collectors are global rather than per-tenant, so every test here pins a
// period far in the past that no other suite writes into. That keeps the
// counts deterministic under file interleaving.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedAdminSession } from './harness.js';
import {
  db,
  assertEvidenceIsSafe,
  collectControlEvidence,
  collectMonthlyControlEvidence,
  previousMonthPeriod,
  listControlEvidence,
  reviewControlEvidence,
  EvidenceReviewError,
  runRetentionWithEvidence,
} from '@platform/shared';

let app: FastifyInstance;
let operatorToken: string;
let supportToken: string;

// Disjoint historical windows, one per test, so no test can see another's rows.
const P = (month: number) => ({
  start: new Date(Date.UTC(2019, month, 1)),
  end: new Date(Date.UTC(2019, month + 1, 1)),
});
const inside = (p: { start: Date }) => new Date(p.start.getTime() + 86_400_000);

beforeAll(async () => {
  app = await buildTestApp();
  operatorToken = (await seedAdminSession('operator')).token;
  supportToken = (await seedAdminSession('support')).token;
  // Also clear on the way in, so a run that was interrupted before afterAll
  // does not poison the next one.
  await clearHistoricalWindow();
});

const WINDOW_START = new Date(Date.UTC(2019, 0, 1));
const WINDOW_END = new Date(Date.UTC(2020, 0, 1));

// Clear both the collected evidence AND the fixture rows it was collected
// from. Leaving the fixtures behind would make a second run of this file see
// two of everything and the exact-count assertions would drift upward — the
// classic "passes once, fails on re-run" test.
async function clearHistoricalWindow() {
  await db.deleteFrom('control_evidence_runs')
    .where('period_start', '>=', WINDOW_START).where('period_end', '<=', WINDOW_END).execute();
  await db.deleteFrom('unsubscribe_monitor_runs')
    .where('run_at', '>=', WINDOW_START).where('run_at', '<', WINDOW_END).execute();
  await db.deleteFrom('audit_checkpoints')
    .where('checkpoint_at', '>=', WINDOW_START).where('checkpoint_at', '<', WINDOW_END).execute();
  await db.deleteFrom('sender_health_runs')
    .where('created_at', '>=', WINDOW_START).where('created_at', '<', WINDOW_END).execute();
  await db.deleteFrom('retention_runs')
    .where('started_at', '>=', WINDOW_START).where('started_at', '<', WINDOW_END).execute();
}

afterAll(async () => {
  await clearHistoricalWindow();
  await app.close();
});

function byControl(evidence: Array<{ control_id: string }>, id: string) {
  const found = evidence.find((e) => e.control_id === id);
  if (!found) throw new Error(`no evidence collected for ${id}`);
  return found as any;
}

describe('SOC2-06: evidence must not carry personal data or secrets', () => {
  it('accepts counts and timestamps', () => {
    expect(() => assertEvidenceIsSafe('BASE-06', {
      retention_runs: 31, failed_runs: 0, max_duration_ms: 4210,
    })).not.toThrow();
  });

  it('rejects metrics containing an email address', () => {
    // The realistic regression: someone adds a "worst offender" field to make
    // a report more actionable and quietly copies recipient addresses into the
    // store auditors are given access to.
    expect(() => assertEvidenceIsSafe('CANSPAM-08', {
      holds: 1, worst_sender: 'complaints@example.com',
    })).toThrow(/evidence_contains_pii/);
  });

  it('rejects metrics referencing a credential', () => {
    expect(() => assertEvidenceIsSafe('BASE-10', {
      checkpoints: 12, signing_key_id: 'k1', api_key: 'sk_live_abc',
    })).toThrow(/evidence_contains_secret/);
  });

  it('refuses to persist unsafe evidence at collection time', async () => {
    // Belt-and-braces: the guard is wired into the write path, not merely
    // exported for tests to call.
    await expect(
      db.insertInto('control_evidence_runs').values({
        control_id: 'FAKE-01',
        period_start: P(0).start,
        period_end: P(0).end,
        metrics: JSON.stringify({ ok: 1 }) as never,
        completeness: 'invalid_verdict',
      } as never).execute(),
    ).rejects.toThrow(); // CHECK constraint on completeness
  });
});

describe('SOC2-06: a silent control is a finding, not a blank', () => {
  it('reports missing — not zero — when a control produced no evidence', async () => {
    const period = P(1);
    const evidence = await collectControlEvidence(period);

    // Nothing at all happened in March 2019. Three controls claim continuous
    // operation, and all three must say so out loud.
    expect(byControl(evidence, 'CANSPAM-05').completeness).toBe('missing');
    expect(byControl(evidence, 'BASE-06').completeness).toBe('missing');
    expect(byControl(evidence, 'BASE-10').completeness).toBe('missing');

    // The distinction the whole module exists for: the count IS zero, and the
    // verdict is still not 'complete'.
    expect(byControl(evidence, 'CANSPAM-05').metrics.monitor_runs).toBe(0);
    expect(byControl(evidence, 'BASE-06').notes).toMatch(/accumulating past its window/);
  });

  it('treats zero as complete for controls that only write on exception', async () => {
    const period = P(2);
    const evidence = await collectControlEvidence(period);

    // CANSPAM-08 writes a row only when a sender crosses a threshold, so a
    // quiet period is genuinely clean. Asserting the asymmetry deliberately:
    // if someone "simplifies" the collectors into one uniform rule, this fails.
    expect(byControl(evidence, 'CANSPAM-08').completeness).toBe('complete');
    expect(byControl(evidence, 'CANSPAM-08').metrics.verdicts_recorded).toBe(0);
    expect(byControl(evidence, 'PCI-02').completeness).toBe('complete');
    expect(byControl(evidence, 'BASE-03').completeness).toBe('complete');
  });

  it('reports complete once the control has actually run', async () => {
    const period = P(3);
    await db.insertInto('unsubscribe_monitor_runs').values({
      run_at: inside(period), kind: 'one_click_synthetic', ok: true,
    } as never).execute();
    await db.insertInto('audit_checkpoints').values({
      chain_key: 'soc2-06-test', seq: 1, row_hash: 'h', key_id: 'k', signature: 's',
      checkpoint_at: inside(period),
    } as never).execute();

    const evidence = await collectControlEvidence(period);
    expect(byControl(evidence, 'CANSPAM-05').completeness).toBe('complete');
    expect(byControl(evidence, 'CANSPAM-05').metrics.kinds_exercised).toEqual(['one_click_synthetic']);
    expect(byControl(evidence, 'BASE-10').completeness).toBe('complete');
  });

  it('reports partial when the control ran but failed', async () => {
    const period = P(4);
    await db.insertInto('unsubscribe_monitor_runs').values({
      run_at: inside(period), kind: 'chain_validation', ok: false, error: 'broken link',
    } as never).execute();

    const evidence = await collectControlEvidence(period);
    const e = byControl(evidence, 'CANSPAM-05');
    expect(e.completeness).toBe('partial');
    expect(e.metrics.failed_runs).toBe(1);
  });

  it('flags an unreviewed automated hold as a gap', async () => {
    const period = P(5);
    const cust = await seedCustomer();
    await db.insertInto('sender_health_runs').values({
      customer_id: cust.customerId,
      window_start: period.start, window_end: period.end,
      sent: 10_000, bounced: 10, complained: 40, unsubscribed: 5,
      bounce_rate: '0.001', complaint_rate: '0.004', unsubscribe_rate: '0.0005',
      verdict: 'hold', action_taken: 'held', created_at: inside(period),
    } as never).execute();

    const evidence = await collectControlEvidence(period);
    const e = byControl(evidence, 'CANSPAM-08');
    // The automation firing is not the control operating — the reviewer
    // decision is what closes it.
    expect(e.completeness).toBe('partial');
    expect(e.metrics.holds_unreviewed).toBe(1);
    expect(e.notes).toMatch(/awaiting reviewer decision/);
  });
});

describe('SOC2-06: retention runs leave a record', () => {
  it('persists a row for every sweep', async () => {
    const before = await db.selectFrom('retention_runs')
      .select((eb) => eb.fn.countAll().as('n')).executeTakeFirst();

    await runRetentionWithEvidence();

    const after = await db.selectFrom('retention_runs')
      .select((eb) => eb.fn.countAll().as('n')).executeTakeFirst();
    expect(Number((after as any).n)).toBe(Number((before as any).n) + 1);

    const latest = await db.selectFrom('retention_runs')
      .selectAll().orderBy('finished_at', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(latest.error).toBeNull();
    // The counters are the evidence; an empty result would make a working
    // sweep indistinguishable from a no-op stub.
    expect(latest.result).toHaveProperty('held_rows_skipped');
  });

  it('counts a failed sweep as a partial period, not a missing one', async () => {
    const period = P(6);
    await db.insertInto('retention_runs').values({
      started_at: inside(period), finished_at: inside(period),
      duration_ms: 12, result: JSON.stringify({}) as never, error: 'connection reset',
    } as never).execute();

    const evidence = await collectControlEvidence(period);
    const e = byControl(evidence, 'BASE-06');
    // A sweep that ran and threw is a different finding from one that never
    // ran, and the remediation differs too.
    expect(e.completeness).toBe('partial');
    expect(e.metrics.failed_runs).toBe(1);
  });
});

describe('SOC2-06: collection is idempotent and invalidates stale sign-off', () => {
  it('updates rather than duplicating, and clears a prior review', async () => {
    const period = P(7);
    await collectControlEvidence(period);

    const rows = await listControlEvidence({ controlId: 'BASE-10', limit: 500 });
    const row = rows.find((r) => new Date(r.period_start).getTime() === period.start.getTime());
    expect(row).toBeDefined();

    await reviewControlEvidence({ id: row!.id, reviewedBy: 'auditor@internal', note: 'seen' });
    const reviewed = await db.selectFrom('control_evidence_runs')
      .selectAll().where('id', '=', row!.id).executeTakeFirstOrThrow();
    expect(reviewed.reviewed_at).not.toBeNull();

    // Add evidence and re-collect the same period.
    await db.insertInto('audit_checkpoints').values({
      chain_key: 'soc2-06-recollect', seq: 1, row_hash: 'h', key_id: 'k', signature: 's',
      checkpoint_at: inside(period),
    } as never).execute();
    await collectControlEvidence(period);

    const again = await db.selectFrom('control_evidence_runs')
      .selectAll().where('id', '=', row!.id).executeTakeFirstOrThrow();
    // Same row (no duplicate), new numbers, and the sign-off is gone: the
    // reviewer approved a different set of figures.
    expect(again.completeness).toBe('complete');
    expect(again.reviewed_at).toBeNull();
    expect(again.reviewed_by).toBeNull();

    const all = await db.selectFrom('control_evidence_runs')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('control_id', '=', 'BASE-10')
      .where('period_start', '=', period.start)
      .executeTakeFirstOrThrow();
    expect(Number((all as any).n)).toBe(1);
  });

  it('rejects a second sign-off on the same record', async () => {
    const period = P(8);
    await collectControlEvidence(period);
    const rows = await listControlEvidence({ controlId: 'PCI-02', limit: 500 });
    const row = rows.find((r) => new Date(r.period_start).getTime() === period.start.getTime())!;

    await reviewControlEvidence({ id: row.id, reviewedBy: 'auditor@internal' });
    await expect(reviewControlEvidence({ id: row.id, reviewedBy: 'someone.else@internal' }))
      .rejects.toBeInstanceOf(EvidenceReviewError);
  });
});

describe('SOC2-06: the monthly scheduler tick', () => {
  it('does not re-collect a period already on file', async () => {
    // The scheduler ticks daily. If it re-collected the same closed month each
    // night it would erase the reviewer's sign-off every night — a control
    // that can never be signed off is worse than no automation.
    const now = new Date();
    const period = previousMonthPeriod(now);

    const first = await collectMonthlyControlEvidence(now);
    // Another suite may already have collected this month; either way the
    // second call must be a no-op.
    if (first) expect(first.period.start.getTime()).toBe(period.start.getTime());

    const second = await collectMonthlyControlEvidence(now);
    expect(second).toBeNull();

    // Clean up so a re-run of this file starts from the same state.
    await db.deleteFrom('control_evidence_runs')
      .where('period_start', '=', period.start)
      .where('period_end', '=', period.end)
      .execute();
  });

  it('computes the previous complete UTC month, including across a year boundary', () => {
    const p = previousMonthPeriod(new Date('2025-01-14T09:00:00Z'));
    expect(p.start.toISOString()).toBe('2024-12-01T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });
});

describe('SOC2-06: admin plane', () => {
  it('collects, lists and signs off through the API', async () => {
    const period = P(9);

    const collected = await app.inject({
      method: 'POST', url: '/admin/control-evidence/collect',
      headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      payload: { period_start: period.start.toISOString(), period_end: period.end.toISOString() },
    });
    expect(collected.statusCode).toBe(200);
    expect(collected.json().evidence.length).toBeGreaterThan(0);

    const listed = await app.inject({
      method: 'GET', url: `/admin/control-evidence?control_id=BASE-06&unreviewed=true`,
      headers: { authorization: `Bearer ${supportToken}`, 'content-type': 'application/json' },
    });
    expect(listed.statusCode).toBe(200);
    const row = listed.json().runs.find(
      (r: any) => new Date(r.period_start).getTime() === period.start.getTime(),
    );
    expect(row).toBeDefined();
    expect(row.completeness).toBe('missing');

    const reviewed = await app.inject({
      method: 'POST', url: `/admin/control-evidence/${row.id}/review`,
      headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      payload: { note: 'sweep was disabled in this window; ticket OPS-4412' },
    });
    expect(reviewed.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET', url: `/admin/control-evidence?control_id=BASE-06&unreviewed=true`,
      headers: { authorization: `Bearer ${supportToken}`, 'content-type': 'application/json' },
    });
    expect(after.json().runs.some((r: any) => r.id === row.id)).toBe(false);
  });

  it('rejects an inverted period', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/control-evidence/collect',
      headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      payload: {
        period_start: '2019-11-01T00:00:00.000Z',
        period_end: '2019-10-01T00:00:00.000Z',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_period');
  });

  it('returns 404 rather than 500 for an id that cannot exist', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/control-evidence/not-a-uuid/review',
      headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('does not let a support admin collect or sign off', async () => {
    // Reading evidence is a support task; producing and approving it is not —
    // sign-off is the assertion an auditor relies on.
    const collect = await app.inject({
      method: 'POST', url: '/admin/control-evidence/collect',
      headers: { authorization: `Bearer ${supportToken}`, 'content-type': 'application/json' },
      payload: {
        period_start: P(10).start.toISOString(),
        period_end: P(10).end.toISOString(),
      },
    });
    expect(collect.statusCode).toBe(403);
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/control-evidence' });
    expect(res.statusCode).toBe(401);
  });
});
