// E2E: HIPAA-07 (compliance implementation plan) — recording staff access to
// tenant data, and reviewing the access that warrants it.
//
// PHI is a prohibited workload here (BASE-15), so this is not really about
// HIPAA: SOC 2 CC6, ISO 27001 A.8.15 and GDPR Art 32 ask the same question.
// "Who looked at this customer's data, and was that appropriate?" was
// unanswerable, because mutations were audited and READS were audited only
// where a developer had remembered to add the call.
//
// The test that matters most is the polarity one: a route nobody annotated
// must still be recorded. Auditing that depends on being remembered is
// auditing that will drift, and its failure mode is silence — which reads
// exactly like "nobody looked".

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedAdminSession } from './harness.js';
import {
  db,
  DATA_ACCESS_ACTION,
  listAccessForReview,
  reviewAdminAccess,
  AccessReviewError,
  summarizeAccessAudit,
  grantElevation,
  collectControlEvidence,
  runRetention,
} from '@platform/shared';

let app: FastifyInstance;

beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

async function accessRowsFor(adminUserId: string) {
  return db.selectFrom('audit_log')
    .select(['id', 'customer_id', 'resource', 'metadata', 'actor_label'])
    .where('action', '=', DATA_ACCESS_ACTION)
    .where('actor_id', '=', adminUserId)
    .orderBy('occurred_at', 'desc')
    .execute();
}

describe('HIPAA-07: staff reads of tenant data are recorded', () => {
  it('records a read on a route that was never annotated', async () => {
    const admin = await seedAdminSession('support');
    const cust = await seedCustomer();

    // Support notes are free text about a named customer, and this route had
    // no audit call of its own. Under opt-in auditing it would leave no trace;
    // the hook is default-on precisely so it does.
    const res = await app.inject({
      method: 'GET', url: `/admin/customers/${cust.customerId}/support-notes`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);

    const rows = await accessRowsFor(admin.adminUserId);
    expect(rows.length).toBe(1);
    expect(rows[0].resource).toBe('/admin/customers/:id/support-notes');
    expect(rows[0].customer_id).toBe(cust.customerId);
    expect(rows[0].actor_label).toBe(admin.email);
    expect((rows[0].metadata as any).method).toBe('GET');
  });

  it('attributes the access to the tenant whose data was returned', async () => {
    const admin = await seedAdminSession('support');
    const cust = await seedCustomer();

    await app.inject({
      method: 'GET', url: `/admin/customers/${cust.customerId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });

    const rows = await accessRowsFor(admin.adminUserId);
    expect(rows.some((r) => r.customer_id === cust.customerId)).toBe(true);
  });

  it('does not guess a tenant when the route does not identify one', async () => {
    const admin = await seedAdminSession('support');

    // /support-tickets/:id addresses a ticket, not a customer. Treating the id
    // as a customer id would file one tenant's read under another's name —
    // worse than recording no attribution at all.
    await app.inject({
      method: 'GET', url: '/admin/support-tickets/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${admin.token}` },
    });

    const rows = await accessRowsFor(admin.adminUserId);
    for (const r of rows) {
      if (r.resource === '/admin/support-tickets/:id') expect(r.customer_id).toBeNull();
    }
  });

  it('does not record reads that returned nothing', async () => {
    const admin = await seedAdminSession('support');
    // A 404 disclosed no tenant data. Recording it would bury the accesses
    // that did behind noise.
    const res = await app.inject({
      method: 'GET', url: '/admin/customers/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(await accessRowsFor(admin.adminUserId)).toHaveLength(0);
  });

  it('honours an explicit opt-out on routes with no tenant data', async () => {
    const admin = await seedAdminSession('operator');
    const res = await app.inject({
      method: 'GET', url: '/admin/settings',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(await accessRowsFor(admin.adminUserId)).toHaveLength(0);
  });

  it('does not record unauthenticated requests', async () => {
    const before = await db.selectFrom('audit_log')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('action', '=', DATA_ACCESS_ACTION).executeTakeFirstOrThrow();
    await app.inject({ method: 'GET', url: '/admin/customers' });
    const after = await db.selectFrom('audit_log')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('action', '=', DATA_ACCESS_ACTION).executeTakeFirstOrThrow();
    expect(Number((after as any).n)).toBe(Number((before as any).n));
  });
});

describe('HIPAA-07: break-glass access reaches a reviewer', () => {
  /** Put an admin into an active break-glass elevation. */
  async function breakGlass(adminUserId: string) {
    const granted = await grantElevation({
      adminUserId, role: 'admin', reason: 'incident: paging on-call',
      grantedBy: adminUserId, breakGlass: true, ttlMinutes: 30,
    });
    expect(granted.ok).toBe(true);
  }

  it('flags emergency access and clears it only on a decision', async () => {
    const admin = await seedAdminSession('operator');
    const cust = await seedCustomer();
    await breakGlass(admin.adminUserId);

    await app.inject({
      method: 'GET', url: `/admin/customers/${cust.customerId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });

    const queue = await listAccessForReview({ adminUserId: admin.adminUserId });
    expect(queue.length).toBe(1);
    expect((queue[0].metadata as any).break_glass).toBe(true);
    expect(queue[0].review_decision).toBeNull();

    await reviewAdminAccess({
      auditId: queue[0].id as number, reviewedBy: 'security@example.com', decision: 'appropriate',
    });

    // The queue is what a reviewer works through; a decided item must leave it.
    expect(await listAccessForReview({ adminUserId: admin.adminUserId })).toHaveLength(0);
  });

  it('does not queue ordinary access taken without break-glass', async () => {
    const admin = await seedAdminSession('support');
    const cust = await seedCustomer();

    await app.inject({
      method: 'GET', url: `/admin/customers/${cust.customerId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });

    // Reviewing every read would mean reviewing none of them. The record still
    // exists — it is just not in the queue.
    expect(await listAccessForReview({ adminUserId: admin.adminUserId })).toHaveLength(0);
    expect(await accessRowsFor(admin.adminUserId)).toHaveLength(1);
  });

  it('requires a note when access is judged inappropriate', async () => {
    const admin = await seedAdminSession('operator');
    const cust = await seedCustomer();
    await breakGlass(admin.adminUserId);
    await app.inject({
      method: 'GET', url: `/admin/customers/${cust.customerId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    const [item] = await listAccessForReview({ adminUserId: admin.adminUserId });

    // A finding with no explanation is not a finding anyone can act on.
    await expect(reviewAdminAccess({
      auditId: item.id as number, reviewedBy: 'security@example.com', decision: 'inappropriate',
    })).rejects.toBeInstanceOf(AccessReviewError);

    await reviewAdminAccess({
      auditId: item.id as number, reviewedBy: 'security@example.com',
      decision: 'inappropriate', note: 'No incident ticket for this window.',
    });
  });

  it('will not let a decision be amended', async () => {
    const admin = await seedAdminSession('operator');
    const cust = await seedCustomer();
    await breakGlass(admin.adminUserId);
    await app.inject({
      method: 'GET', url: `/admin/customers/${cust.customerId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    const [item] = await listAccessForReview({ adminUserId: admin.adminUserId });

    await reviewAdminAccess({
      auditId: item.id as number, reviewedBy: 'security@example.com',
      decision: 'inappropriate', note: 'Accessed outside the incident window.',
    });

    // The review is itself evidence. A reviewer who could quietly downgrade
    // 'inappropriate' to 'appropriate' later would make the record worthless.
    await expect(reviewAdminAccess({
      auditId: item.id as number, reviewedBy: 'someone.else@example.com', decision: 'appropriate',
    })).rejects.toMatchObject({ code: 'already_reviewed' });
  });
});

describe('HIPAA-07: the admin review API', () => {
  it('lists and decides through the API, and rejects a second decision', async () => {
    const reviewer = await seedAdminSession('admin');
    const actor = await seedAdminSession('operator');
    const cust = await seedCustomer();
    await grantElevation({
      adminUserId: actor.adminUserId, role: 'admin', reason: 'incident',
      grantedBy: actor.adminUserId, breakGlass: true, ttlMinutes: 30,
    });
    await app.inject({
      method: 'GET', url: `/admin/customers/${cust.customerId}`,
      headers: { authorization: `Bearer ${actor.token}` },
    });

    const listed = await app.inject({
      method: 'GET', url: `/admin/access-review?admin_user_id=${actor.adminUserId}`,
      headers: { authorization: `Bearer ${reviewer.token}` },
    });
    expect(listed.statusCode).toBe(200);
    const [item] = listed.json().access;
    expect(item).toBeDefined();

    const decided = await app.inject({
      method: 'POST', url: `/admin/access-review/${item.id}`,
      headers: { authorization: `Bearer ${reviewer.token}`, 'content-type': 'application/json' },
      payload: { decision: 'appropriate', note: 'Matches incident INC-201.' },
    });
    expect(decided.statusCode).toBe(200);

    const again = await app.inject({
      method: 'POST', url: `/admin/access-review/${item.id}`,
      headers: { authorization: `Bearer ${reviewer.token}`, 'content-type': 'application/json' },
      payload: { decision: 'appropriate' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('keeps the queue away from the roles it watches', async () => {
    // Support and operator accounts are the ones whose access shows up here.
    // If they could clear their own entries the review would assert nothing.
    const operator = await seedAdminSession('operator');
    const res = await app.inject({
      method: 'GET', url: '/admin/access-review',
      headers: { authorization: `Bearer ${operator.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 rather than 500 for an id that cannot exist', async () => {
    const reviewer = await seedAdminSession('admin');
    const res = await app.inject({
      method: 'POST', url: '/admin/access-review/not-a-number',
      headers: { authorization: `Bearer ${reviewer.token}`, 'content-type': 'application/json' },
      payload: { decision: 'appropriate' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('HIPAA-07: a reviewed access outlives the audit window', () => {
  it('is preserved by the retention sweep and counted, not silently dropped', async () => {
    const admin = await seedAdminSession('operator');
    const cust = await seedCustomer();
    await grantElevation({
      adminUserId: admin.adminUserId, role: 'admin', reason: 'incident review',
      grantedBy: admin.adminUserId, breakGlass: true, ttlMinutes: 30,
    });
    await app.inject({
      method: 'GET', url: `/admin/customers/${cust.customerId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });

    const [item] = await listAccessForReview({ adminUserId: admin.adminUserId });
    await reviewAdminAccess({
      auditId: item.id as number, reviewedBy: 'security@example.com',
      decision: 'inappropriate', note: 'No incident ticket covering this access.',
    });

    // A judgement about a person's conduct is not ordinary audit traffic. If
    // the sweep archived it, the finding would be left pointing at nothing;
    // if the FK simply blocked the sweep, retention would stop platform-wide.
    // Neither is acceptable, so the row is held back and reported.
    const result = await runRetention({ auditRetentionDays: 0 });
    expect(result.reviewed_access_rows_skipped).toBeGreaterThanOrEqual(1);

    const survived = await db.selectFrom('audit_log').select('id')
      .where('id', '=', item.id as never).executeTakeFirst();
    expect(survived).toBeDefined();

    const review = await db.selectFrom('admin_access_reviews').selectAll()
      .where('audit_id', '=', item.id as never).executeTakeFirstOrThrow();
    expect(review.decision).toBe('inappropriate');
  });
});

describe('HIPAA-07: control evidence', () => {
  it('reports a period with unreviewed break-glass access as partial', async () => {
    const admin = await seedAdminSession('operator');
    const cust = await seedCustomer();
    await grantElevation({
      adminUserId: admin.adminUserId, role: 'admin', reason: 'incident',
      grantedBy: admin.adminUserId, breakGlass: true, ttlMinutes: 30,
    });
    await app.inject({
      method: 'GET', url: `/admin/customers/${cust.customerId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });

    const period = { start: new Date(Date.now() - 60_000), end: new Date(Date.now() + 60_000) };
    const summary = await summarizeAccessAudit(period);
    expect(summary.break_glass_unreviewed).toBeGreaterThanOrEqual(1);

    const evidence = await collectControlEvidence(period);
    const hipaa = evidence.find((e) => e.control_id === 'HIPAA-07')!;
    // Emergency access nobody went back and checked is the finding this
    // control exists for.
    expect(hipaa.completeness).toBe('partial');
    expect(hipaa.notes).toMatch(/awaiting reviewer decision/);

    await db.deleteFrom('control_evidence_runs')
      .where('period_start', '=', period.start).where('period_end', '=', period.end).execute();
  });

  it('carries no identifiers into the evidence store', async () => {
    const period = { start: new Date(Date.now() - 60_000), end: new Date(Date.now() + 60_000) };
    const evidence = await collectControlEvidence(period);
    const hipaa = evidence.find((e) => e.control_id === 'HIPAA-07')!;
    // The access records name staff and tenants; the evidence must be counts
    // only. collectControlEvidence() would have thrown otherwise, but assert
    // it here too — this is the collector most likely to tempt someone into
    // adding a "who" field.
    expect(JSON.stringify(hipaa.metrics)).not.toMatch(/@/);
    expect(Object.values(hipaa.metrics).every((v) => typeof v === 'number')).toBe(true);

    await db.deleteFrom('control_evidence_runs')
      .where('period_start', '=', period.start).where('period_end', '=', period.end).execute();
  });
});
