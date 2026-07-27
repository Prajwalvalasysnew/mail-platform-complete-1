// E2E: CANSPAM-08 (compliance implementation plan) — per-sender complaint,
// bounce and unsubscribe monitoring with automated holds and reviewer
// evidence.
//
// The three tests that matter most are the ones guarding the judgement calls:
//   * a low-volume sender is NOT judged on statistically meaningless rates
//   * unsubscribes never trigger a hold (honouring opt-outs is required)
//   * upholding a hold does not silently lift it

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain, seedAdminSession } from './harness.js';
import {
  db,
  evaluateSenderHealth,
  sweepSenderHealth,
  isSenderOnHold,
  reviewSenderHealth,
  listSenderHealthRuns,
} from '@platform/shared';

let app: FastifyInstance;
let operatorToken: string;

beforeAll(async () => {
  app = await buildTestApp();
  operatorToken = (await seedAdminSession('operator')).token;
});
afterAll(async () => { await app.close(); });

/** Give a tenant a usage history with the given totals over the window. */
async function seedUsage(customerId: string, totals: { sent: number; bounced?: number; complained?: number }) {
  await db.insertInto('usage_daily').values({
    customer_id: customerId,
    usage_date: new Date().toISOString().slice(0, 10),
    sent: totals.sent,
    delivered: totals.sent - (totals.bounced ?? 0),
    bounced: totals.bounced ?? 0,
    complained: totals.complained ?? 0,
  } as any).onConflict((oc) => oc.columns(['customer_id', 'usage_date']).doUpdateSet({
    sent: totals.sent, bounced: totals.bounced ?? 0, complained: totals.complained ?? 0,
  } as any)).execute();
}

describe('CANSPAM-08: sender health verdicts', () => {
  it('is ok for a clean sender', async () => {
    const cust = await seedCustomer();
    await seedUsage(cust.customerId, { sent: 10_000, bounced: 50, complained: 2 });

    const health = await evaluateSenderHealth(cust.customerId);
    expect(health.verdict).toBe('ok');
    expect(health.triggered_by).toEqual([]);
  });

  it('holds a sender over the complaint threshold', async () => {
    const cust = await seedCustomer();
    // 0.4% complaint rate — above the 0.3% hard limit the mailbox providers
    // publish, and above our hold threshold.
    await seedUsage(cust.customerId, { sent: 10_000, complained: 40 });

    const health = await evaluateSenderHealth(cust.customerId);
    expect(health.verdict).toBe('hold');
    expect(health.triggered_by).toContain('complaint_rate');
    expect(health.complaint_rate).toBeCloseTo(0.004, 5);
  });

  it('watches a sender between the warning and hold lines', async () => {
    const cust = await seedCustomer();
    // 0.2% — over the 0.1% warning line, under the 0.3% hold line.
    await seedUsage(cust.customerId, { sent: 10_000, complained: 20 });

    const health = await evaluateSenderHealth(cust.customerId);
    expect(health.verdict).toBe('watch');
    expect(health.triggered_by).toContain('complaint_rate');
  });

  it('holds a sender over the bounce threshold', async () => {
    const cust = await seedCustomer();
    await seedUsage(cust.customerId, { sent: 10_000, bounced: 600 }); // 6%

    const health = await evaluateSenderHealth(cust.customerId);
    expect(health.verdict).toBe('hold');
    expect(health.triggered_by).toContain('bounce_rate');
  });

  it('DOES NOT judge a low-volume sender on meaningless rates', async () => {
    const cust = await seedCustomer();
    // 1 complaint out of 10 messages is a 10% complaint rate. Judging that
    // would hold every new legitimate sender on their first small campaign.
    await seedUsage(cust.customerId, { sent: 10, complained: 1, bounced: 3 });

    const health = await evaluateSenderHealth(cust.customerId);
    expect(health.complaint_rate).toBeCloseTo(0.1, 5);
    expect(health.verdict).toBe('ok');
    expect(health.triggered_by).toEqual([]);
  });

  it('UNSUBSCRIBES NEVER TRIGGER A HOLD — honouring opt-outs is required behaviour', async () => {
    const cust = await seedCustomer();
    await seedUsage(cust.customerId, { sent: 10_000 });

    // A very high unsubscribe rate: 5% of recipients opted out.
    const rows = Array.from({ length: 500 }, (_, i) => ({
      customer_id: cust.customerId,
      email: `unsub-${i}-${Date.now()}@example.com`,
      action: 'suppress' as const,
      reason: 'unsubscribe',
      source: 'one_click_unsubscribe',
      notes: null,
      message_id: null,
    }));
    await db.insertInto('consent_events').values(rows as any).execute();

    const health = await evaluateSenderHealth(cust.customerId);
    expect(health.unsubscribe_rate).toBeGreaterThan(0.01);
    expect(health.triggered_by).toContain('unsubscribe_rate');
    // Surfaced as a list-quality signal, never escalated to enforcement.
    expect(health.verdict).toBe('watch');
  });
});

describe('CANSPAM-08: automated hold and send enforcement', () => {
  it('records a hold in the sweep and blocks sending', async () => {
    const cust = await seedCustomer({ scopes: ['send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    await seedUsage(cust.customerId, { sent: 10_000, complained: 40 });

    const result = await sweepSenderHealth();
    expect(result.held).toBeGreaterThanOrEqual(1);
    expect(await isSenderOnHold(cust.customerId)).toBe(true);

    const send = await app.inject({
      method: 'POST', url: '/v1/send',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { from: `s@${domain}`, to: 'a@example.com', subject: 'x', text: 'x' },
    });
    expect(send.statusCode).toBe(403);
    expect(send.json().error).toBe('sender_on_hold');
  });

  it('does not re-record a duplicate hold for an unresolved case', async () => {
    const cust = await seedCustomer();
    await seedUsage(cust.customerId, { sent: 10_000, complained: 40 });

    await sweepSenderHealth();
    const second = await sweepSenderHealth();
    expect(second.already_held).toBeGreaterThanOrEqual(1);

    const runs = await listSenderHealthRuns({ customerId: cust.customerId });
    expect(runs.filter((r: any) => r.verdict === 'hold')).toHaveLength(1);
  });

  it('a clean sender is never held', async () => {
    const cust = await seedCustomer({ scopes: ['send'] });
    await seedUsage(cust.customerId, { sent: 10_000, bounced: 20, complained: 1 });
    await sweepSenderHealth();
    expect(await isSenderOnHold(cust.customerId)).toBe(false);
  });
});

describe('CANSPAM-08: reviewer decisions close the control', () => {
  it('releasing a hold lets the sender resume', async () => {
    // Quota headroom: the seeded usage below is what drives the complaint
    // rate, and without a larger quota it would also exhaust the daily
    // allowance, so the send would 429 before the hold check proved anything.
    const cust = await seedCustomer({ scopes: ['send'], dailyQuota: 200_000, monthlyQuota: 2_000_000 });
    const domain = await seedVerifiedDomain(cust.customerId);
    await seedUsage(cust.customerId, { sent: 10_000, complained: 40 });
    await sweepSenderHealth();

    const [run] = await listSenderHealthRuns({ customerId: cust.customerId, openHoldsOnly: true });
    await reviewSenderHealth({ runId: run.id, decision: 'released', reviewedBy: 'dpo@example.com', notes: 'list cleaned' });

    expect(await isSenderOnHold(cust.customerId)).toBe(false);
    const send = await app.inject({
      method: 'POST', url: '/v1/send',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { from: `s@${domain}`, to: 'a@example.com', subject: 'x', text: 'x' },
    });
    expect(send.statusCode).toBe(202);
  });

  it('UPHOLDING A HOLD DOES NOT LIFT IT', async () => {
    const cust = await seedCustomer();
    await seedUsage(cust.customerId, { sent: 10_000, complained: 40 });
    await sweepSenderHealth();

    const [run] = await listSenderHealthRuns({ customerId: cust.customerId, openHoldsOnly: true });
    await reviewSenderHealth({ runId: run.id, decision: 'upheld', reviewedBy: 'dpo@example.com' });

    // Reviewing is not resolving. Confirming a hold must keep the sender
    // blocked, not silently unblock them.
    expect(await isSenderOnHold(cust.customerId)).toBe(true);
  });

  it('escalating also keeps the sender blocked', async () => {
    const cust = await seedCustomer();
    await seedUsage(cust.customerId, { sent: 10_000, complained: 40 });
    await sweepSenderHealth();

    const [run] = await listSenderHealthRuns({ customerId: cust.customerId, openHoldsOnly: true });
    await reviewSenderHealth({ runId: run.id, decision: 'escalated', reviewedBy: 'dpo@example.com' });
    expect(await isSenderOnHold(cust.customerId)).toBe(true);
  });

  it('retains the reviewer evidence', async () => {
    const cust = await seedCustomer();
    await seedUsage(cust.customerId, { sent: 10_000, complained: 40 });
    await sweepSenderHealth();

    const [run] = await listSenderHealthRuns({ customerId: cust.customerId, openHoldsOnly: true });
    await reviewSenderHealth({
      runId: run.id, decision: 'upheld', reviewedBy: 'reviewer@example.com', notes: 'confirmed purchased list',
    });

    const [after] = await listSenderHealthRuns({ customerId: cust.customerId });
    expect(after.reviewed_by).toBe('reviewer@example.com');
    expect(after.review_decision).toBe('upheld');
    expect(after.review_notes).toBe('confirmed purchased list');
    expect(after.reviewed_at).toBeTruthy();
    // The rates that drove the decision stay attached to it.
    expect(Number(after.complaint_rate)).toBeCloseTo(0.004, 4);
    expect(after.triggered_by).toContain('complaint_rate');
  });

  it('reviewing an already-reviewed run is a 404', async () => {
    const cust = await seedCustomer();
    await seedUsage(cust.customerId, { sent: 10_000, complained: 40 });
    await sweepSenderHealth();

    const [run] = await listSenderHealthRuns({ customerId: cust.customerId, openHoldsOnly: true });
    await reviewSenderHealth({ runId: run.id, decision: 'released', reviewedBy: 'a@example.com' });

    const res = await app.inject({
      method: 'POST', url: `/admin/sender-health/${run.id}/review`,
      headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
      payload: { decision: 'upheld' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('exposes the reviewer queue over the admin API', async () => {
    const cust = await seedCustomer();
    await seedUsage(cust.customerId, { sent: 10_000, complained: 40 });
    await sweepSenderHealth();

    const res = await app.inject({
      method: 'GET', url: '/admin/sender-health?open_holds=true',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs.some((r: any) => r.customer_id === cust.customerId)).toBe(true);
  });
});
