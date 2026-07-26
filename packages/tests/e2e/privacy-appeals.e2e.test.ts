// E2E: CCPA-07 (compliance implementation plan) — appeals and escalation for
// denied data-subject requests.
//
// A denial with no route to challenge it is not a complete rights process.
// CPRA §7304 requires an appeal path, and the state laws that followed all
// mandate one with its own response deadline.
//
// Three things this asserts that are easy to get wrong:
//   * the appeal runs on ITS OWN clock, not the expired original deadline
//   * upholding a denial requires recording the regulator-escalation notice
//   * overturning REOPENS the case — and that is the ONLY way to un-deny one

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer } from './harness.js';
import { db, createPrivacyCase, transitionPrivacyCase } from '@platform/shared';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

const subject = () => `appeal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
const hdr = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });

/** A case that has been denied with a documented reason. */
async function deniedCase(customerId: string, jurisdiction: 'ccpa' | 'gdpr' = 'ccpa') {
  const row = await createPrivacyCase({
    customerId, subjectKind: 'recipient', subjectIdentifier: subject(),
    intakeSource: 'web_form', requestTypes: ['access'], jurisdiction, createdBy: 'e2e',
  }, db);
  await transitionPrivacyCase(customerId, row.id, 'denied',
    { actor: 'e2e', denialReason: 'could not verify identity' }, db);
  return row;
}

describe('CCPA-07: submitting an appeal', () => {
  it('accepts an appeal against a denied case and gives it its own deadline', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const kase = await deniedCase(cust.customerId, 'ccpa');

    const res = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${kase.id}/appeal`, headers: hdr(cust.apiKey),
      payload: { reason: 'I sent the ID you asked for', submitted_by: 'subject' },
    });

    expect(res.statusCode).toBe(201);
    const appeal = res.json().appeal;
    expect(appeal.status).toBe('received');

    // The original request's deadline has already expired by now; reusing it
    // would make the appeal born overdue. It runs on its own clock.
    const due = new Date(appeal.due_at).getTime();
    const submitted = new Date(appeal.submitted_at).getTime();
    const days = Math.round((due - submitted) / 86_400_000);
    expect(days).toBe(45); // CCPA window
    expect(due).toBeGreaterThan(new Date(kase.due_at as unknown as string).getTime());
  });

  it('uses the GDPR window for a GDPR case', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const kase = await deniedCase(cust.customerId, 'gdpr');
    const res = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${kase.id}/appeal`, headers: hdr(cust.apiKey),
      payload: { reason: 'disagree' },
    });
    const appeal = res.json().appeal;
    const days = Math.round(
      (new Date(appeal.due_at).getTime() - new Date(appeal.submitted_at).getTime()) / 86_400_000,
    );
    expect(days).toBe(30);
  });

  it('refuses an appeal against a case that was never denied', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const row = await createPrivacyCase({
      customerId: cust.customerId, subjectIdentifier: subject(),
      intakeSource: 'api', requestTypes: ['access'], jurisdiction: 'ccpa', createdBy: 'e2e',
    }, db);

    const res = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${row.id}/appeal`, headers: hdr(cust.apiKey),
      payload: { reason: 'nothing to appeal' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('invalid_transition');
  });

  it('allows an appeal after the case was denied AND closed', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const kase = await deniedCase(cust.customerId);
    await transitionPrivacyCase(cust.customerId, kase.id, 'closed', { actor: 'e2e' }, db);

    // The right to challenge does not evaporate because the controller filed
    // the case away.
    const res = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${kase.id}/appeal`, headers: hdr(cust.apiKey),
      payload: { reason: 'still disagree' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('refuses a second appeal while the first is undecided', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const kase = await deniedCase(cust.customerId);
    await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${kase.id}/appeal`, headers: hdr(cust.apiKey),
      payload: { reason: 'first' },
    });
    const second = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${kase.id}/appeal`, headers: hdr(cust.apiKey),
      payload: { reason: 'second' },
    });
    expect(second.statusCode).toBe(422);
  });
});

describe('CCPA-07: deciding an appeal', () => {
  async function openAppeal(cust: { customerId: string; apiKey: string }) {
    const kase = await deniedCase(cust.customerId);
    const res = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${kase.id}/appeal`, headers: hdr(cust.apiKey),
      payload: { reason: 'please reconsider' },
    });
    return { kase, appealId: res.json().appeal.id as string };
  }

  it('UPHOLDING REQUIRES THE REGULATOR-ESCALATION NOTICE', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const { appealId } = await openAppeal(cust);

    const noNotice = await app.inject({
      method: 'POST', url: `/v1/privacy/appeals/${appealId}/decide`, headers: hdr(cust.apiKey),
      payload: { decision: 'upheld', decided_by: 'dpo@example.com', reason: 'still unverified' },
    });
    // Where the denial stands, the consumer must be told how to complain to
    // the regulator; recording what they were told is what makes it evidence.
    expect(noNotice.statusCode).toBe(422);

    const withNotice = await app.inject({
      method: 'POST', url: `/v1/privacy/appeals/${appealId}/decide`, headers: hdr(cust.apiKey),
      payload: {
        decision: 'upheld', decided_by: 'dpo@example.com', reason: 'still unverified',
        escalation_notice: 'Informed the consumer they may complain to the CPPA at cppa.ca.gov/complaints.',
      },
    });
    expect(withNotice.statusCode).toBe(200);
    expect(withNotice.json().appeal.status).toBe('upheld');
    expect(withNotice.json().appeal.escalation_notice).toContain('cppa.ca.gov');
  });

  it('an upheld appeal leaves the case denied', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const { kase, appealId } = await openAppeal(cust);

    await app.inject({
      method: 'POST', url: `/v1/privacy/appeals/${appealId}/decide`, headers: hdr(cust.apiKey),
      payload: {
        decision: 'upheld', decided_by: 'dpo@example.com', reason: 'unchanged',
        escalation_notice: 'Regulator complaint route provided.',
      },
    });

    const row = await db.selectFrom('privacy_cases').select('status')
      .where('id', '=', kase.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('denied');
  });

  it('OVERTURNING REOPENS THE CASE, auditably', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const { kase, appealId } = await openAppeal(cust);

    const res = await app.inject({
      method: 'POST', url: `/v1/privacy/appeals/${appealId}/decide`, headers: hdr(cust.apiKey),
      payload: { decision: 'overturned', decided_by: 'dpo@example.com', reason: 'ID was in fact valid' },
    });
    expect(res.statusCode).toBe(200);

    const row = await db.selectFrom('privacy_cases').select(['status', 'closed_at'])
      .where('id', '=', kase.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('in_progress');
    expect(row.closed_at).toBeNull();

    // A reopen must be as auditable as the denial that preceded it.
    const events = await db.selectFrom('privacy_case_events').select('event')
      .where('case_id', '=', kase.id).execute();
    const names = events.map((e) => e.event);
    expect(names).toContain('denied');
    expect(names).toContain('appeal_submitted');
    expect(names).toContain('appeal_decided');
    expect(names).toContain('reopened');
  });

  it('AN APPEAL IS THE ONLY WAY TO UN-DENY A CASE', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const kase = await deniedCase(cust.customerId);

    // The ordinary transition endpoint must not reverse a denial — otherwise
    // the appeal process is decorative. 409 specifically: the request is
    // well-formed and the transition is refused on its merits, not rejected
    // as malformed (which would pass this test for the wrong reason).
    const res = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${kase.id}/transition`, headers: hdr(cust.apiKey),
      payload: { status: 'in_progress' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('invalid_transition');
  });

  it('refuses to decide an already-decided appeal', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const { appealId } = await openAppeal(cust);
    await app.inject({
      method: 'POST', url: `/v1/privacy/appeals/${appealId}/decide`, headers: hdr(cust.apiKey),
      payload: { decision: 'overturned', decided_by: 'a@example.com', reason: 'ok' },
    });
    const again = await app.inject({
      method: 'POST', url: `/v1/privacy/appeals/${appealId}/decide`, headers: hdr(cust.apiKey),
      payload: { decision: 'upheld', decided_by: 'a@example.com', reason: 'x', escalation_notice: 'y' },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe('CCPA-07: appeal queue and tenant isolation', () => {
  it('lists open and overdue appeals', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const kase = await deniedCase(cust.customerId);
    const created = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${kase.id}/appeal`, headers: hdr(cust.apiKey),
      payload: { reason: 'reconsider' },
    });
    const appealId = created.json().appeal.id;

    const open = await app.inject({
      method: 'GET', url: '/v1/privacy/appeals?open=true', headers: hdr(cust.apiKey),
    });
    expect(open.json().appeals.map((a: any) => a.id)).toContain(appealId);

    // Age it past its deadline — this is the metric that matters for CCPA-07.
    await db.updateTable('privacy_case_appeals')
      .set({ due_at: new Date(Date.now() - 86_400_000) } as any)
      .where('id', '=', appealId).execute();

    const overdue = await app.inject({
      method: 'GET', url: '/v1/privacy/appeals?overdue=true', headers: hdr(cust.apiKey),
    });
    expect(overdue.json().appeals.map((a: any) => a.id)).toContain(appealId);
  });

  it('does not leak appeals across tenants', async () => {
    const a = await seedCustomer({ scopes: ['messages'] });
    const b = await seedCustomer({ scopes: ['messages'] });
    const kase = await deniedCase(a.customerId);
    await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${kase.id}/appeal`, headers: hdr(a.apiKey),
      payload: { reason: 'mine' },
    });

    const list = await app.inject({ method: 'GET', url: '/v1/privacy/appeals', headers: hdr(b.apiKey) });
    expect(list.json().appeals).toHaveLength(0);
  });
});
