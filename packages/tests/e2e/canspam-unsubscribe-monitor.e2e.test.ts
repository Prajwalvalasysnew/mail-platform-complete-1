// E2E: CANSPAM-05 (compliance implementation plan) — synthetic unsubscribe
// monitoring.
//
// The scheduled monitor must: validate the unsubscribe chain for sampled
// commercial messages (including the oldest in the 30-day window), exercise
// the real one-click suppression write with a synthetic recipient and clean
// up after itself, flag opt-outs that lack an enforced suppression as SLA
// violations, persist evidence rows, and expose an aggregated admin report.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain, seedAdminSession } from './harness.js';
import { db, runUnsubscribeMonitor, unsubscribeMonitorReport, SYNTHETIC_UNSUB_DOMAIN } from '@platform/shared';
import { sql } from 'kysely';

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildTestApp();
  // The shared test DB accumulates ledger rows from other suites. Repair any
  // pre-existing orphan opt-outs (consent 'suppress' without a suppression
  // row) so this suite's SLA assertions start from a clean baseline — exactly
  // the remediation the monitor is designed to drive in production.
  await sql`
    INSERT INTO suppressions (customer_id, email, reason, notes)
    SELECT DISTINCT ce.customer_id, ce.email, 'unsubscribe', 'sla-baseline-repair'
    FROM consent_events ce
    WHERE ce.action = 'suppress' AND ce.reason = 'unsubscribe' AND ce.pseudonymized_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.customer_id = ce.customer_id AND s.email = ce.email)
      AND NOT EXISTS (SELECT 1 FROM consent_events later WHERE later.customer_id = ce.customer_id
                        AND later.email = ce.email AND later.action = 'unsuppress' AND later.created_at >= ce.created_at)
    ON CONFLICT (customer_id, email) DO NOTHING
  `.execute(db);
});
afterAll(async () => { await app.close(); });

const headers = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });

async function sendCommercial(cust: { apiKey: string }, domain: string, to: string) {
  const res = await app.inject({
    method: 'POST', url: '/v1/send', headers: headers(cust.apiKey),
    payload: { from: `promo@${domain}`, to, subject: 'sale', text: 'big sale' },
  });
  expect(res.statusCode).toBe(202);
  return res.json().message_ids[0] as string;
}

describe('CAN-SPAM synthetic unsubscribe monitoring', () => {
  it('validates sampled commercial chains, probes one-click, and records evidence', async () => {
    const cust = await seedCustomer({ scopes: ['send', 'messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const mid = await sendCommercial(cust, domain, `monitor-a-${Date.now()}@example.com`);
    // Age one message ~29 days back so the sample provably covers old links.
    await db.updateTable('messages')
      .set({ queued_at: new Date(Date.now() - 29 * 86_400_000) as never })
      .where('message_id', '=', mid).execute();
    await sendCommercial(cust, domain, `monitor-b-${Date.now()}@example.com`);

    const result = await runUnsubscribeMonitor();
    expect(result.failures).toBe(0);
    expect(result.chainChecks).toBeGreaterThanOrEqual(2);
    expect(result.oldestMessageAgeDays).toBeGreaterThanOrEqual(28);
    expect(result.slaViolations).toBe(0);

    // Evidence rows persisted for every check kind.
    const kinds = await db.selectFrom('unsubscribe_monitor_runs').select('kind')
      .orderBy('run_at', 'desc').limit(20).execute();
    const kindSet = new Set(kinds.map((k) => k.kind));
    expect(kindSet.has('chain_validation')).toBe(true);
    expect(kindSet.has('one_click_synthetic')).toBe(true);
    expect(kindSet.has('sla_scan')).toBe(true);

    // The synthetic probe cleaned up after itself: no suppression, no ledger
    // rows, for any monitor-domain address.
    const leftovers = await db.selectFrom('suppressions').select('email')
      .where('email', 'like', `%@${SYNTHETIC_UNSUB_DOMAIN}`).execute();
    expect(leftovers).toHaveLength(0);
    const ledger = await db.selectFrom('consent_events').select('id')
      .where('email', 'like', `%@${SYNTHETIC_UNSUB_DOMAIN}`).execute();
    expect(ledger).toHaveLength(0);
  });

  it('flags an opt-out without an enforced suppression as an SLA violation', async () => {
    const cust = await seedCustomer({ scopes: ['send', 'messages'] });
    const victim = `sla-violation-${Date.now()}@example.com`;
    // Simulate a broken honor path: ledger says the recipient unsubscribed,
    // but no suppression row exists.
    await db.insertInto('consent_events').values({
      customer_id: cust.customerId, email: victim, action: 'suppress',
      reason: 'unsubscribe', source: 'one_click_unsubscribe', notes: null, message_id: null,
    }).execute();

    const result = await runUnsubscribeMonitor();
    expect(result.slaViolations).toBeGreaterThanOrEqual(1);

    // Repair (suppress for real) and the violation clears.
    await db.insertInto('suppressions').values({
      customer_id: cust.customerId, email: victim, reason: 'unsubscribe', notes: null,
    }).execute();
    const after = await runUnsubscribeMonitor();
    expect(after.slaViolations).toBe(0);
  });

  it('serves the aggregated admin report and the on-demand run endpoint', async () => {
    const support = await seedAdminSession('support');
    const operator = await seedAdminSession('operator');

    const run = await app.inject({
      method: 'POST', url: '/admin/canspam/unsubscribe-monitor/run',
      headers: { authorization: `Bearer ${operator.token}` },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().runs).toBeGreaterThanOrEqual(1);

    // support role can read the report but not trigger runs.
    const forbidden = await app.inject({
      method: 'POST', url: '/admin/canspam/unsubscribe-monitor/run',
      headers: { authorization: `Bearer ${support.token}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const report = await app.inject({
      method: 'GET', url: '/admin/canspam/unsubscribe-monitor?days=30',
      headers: { authorization: `Bearer ${support.token}` },
    });
    expect(report.statusCode).toBe(200);
    const body = report.json();
    expect(body.runs).toBeGreaterThanOrEqual(1);
    expect(body.availability_pct).not.toBeNull();
    expect(body.days_with_checks).toBeGreaterThanOrEqual(1);
    expect(body.last_run_at).toBeTruthy();

    // The report function mirrors the endpoint (used by ops tooling).
    const direct = await unsubscribeMonitorReport(30);
    expect(direct.runs).toBe(body.runs);
  });
});
