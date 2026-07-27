import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { db } from '@platform/shared';
import { buildTestApp, seedCustomer } from './harness.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });
const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function activate(customerId: string, mode: 'hipaa' | 'ferpa') {
  await db.insertInto('regulated_workload_posture').values({
    customer_id: customerId, mode, status: 'active', prerequisites: {},
    activated_at: new Date(), reviewed_at: new Date(), reviewed_by: 'independent-reviewer',
  }).execute();
}

describe('HIPAA and FERPA rights workflows', () => {
  it('refuses case creation until the requested mode is active', async () => {
    const tenant = await seedCustomer({ tier: 'enterprise', scopes: ['messages'] });
    const response = await app.inject({
      method: 'POST', url: '/v1/compliance/rights-cases', headers: headers(tenant.apiKey),
      payload: { mode: 'hipaa', kind: 'access', subject_ref: 'patient-123' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('mode_inactive');
  });

  it('runs a HIPAA access workflow without persisting the raw patient reference', async () => {
    const tenant = await seedCustomer({ tier: 'enterprise', scopes: ['messages'] });
    await activate(tenant.customerId, 'hipaa');
    const rawSubject = `patient-${Date.now()}-sensitive`;
    const created = await app.inject({
      method: 'POST', url: '/v1/compliance/rights-cases', headers: headers(tenant.apiKey),
      payload: { mode: 'hipaa', kind: 'access', subject_ref: rawSubject },
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.stringify(created.json())).not.toContain(rawSubject);
    const kase = created.json().case;
    const days = (new Date(kase.deadline_at).getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30.1);

    for (const status of ['identity_verified', 'in_review', 'approved', 'fulfilled']) {
      const transitioned = await app.inject({
        method: 'POST', url: `/v1/compliance/rights-cases/${kase.id}/transition`,
        headers: headers(tenant.apiKey), payload: { status },
      });
      expect(transitioned.statusCode).toBe(200);
    }
    const invalid = await app.inject({
      method: 'POST', url: `/v1/compliance/rights-cases/${kase.id}/transition`,
      headers: headers(tenant.apiKey), payload: { status: 'denied' },
    });
    expect(invalid.statusCode).toBe(409);
    const stored = await db.selectFrom('regulated_rights_cases').selectAll().where('id', '=', kase.id).executeTakeFirstOrThrow();
    expect(stored.subject_pseudonym).not.toContain(rawSubject);
    expect(JSON.stringify(stored)).not.toContain(rawSubject);
  });

  it('supports FERPA amendment/hearing and pseudonymized disclosure accounting', async () => {
    const tenant = await seedCustomer({ tier: 'enterprise', scopes: ['messages'] });
    await activate(tenant.customerId, 'ferpa');
    const subjectRef = `student-${Date.now()}-private`;
    const created = await app.inject({
      method: 'POST', url: '/v1/compliance/rights-cases', headers: headers(tenant.apiKey),
      payload: { mode: 'ferpa', kind: 'amendment', subject_ref: subjectRef },
    });
    const id = created.json().case.id;
    for (const status of ['identity_verified', 'in_review', 'denied', 'hearing_requested']) {
      const response = await app.inject({
        method: 'POST', url: `/v1/compliance/rights-cases/${id}/transition`,
        headers: headers(tenant.apiKey),
        payload: { status, ...(status === 'denied' ? { reason: 'Record was verified against source evidence.' } : {}) },
      });
      expect(response.statusCode).toBe(200);
    }
    const disclosure = await app.inject({
      method: 'POST', url: '/v1/compliance/disclosures', headers: headers(tenant.apiKey),
      payload: {
        mode: 'ferpa', subject_ref: subjectRef, recipient: 'accredited-auditor',
        purpose: 'Accreditation review', authority: 'FERPA school-official exception',
      },
    });
    expect(disclosure.statusCode).toBe(201);
    expect(JSON.stringify(disclosure.json())).not.toContain(subjectRef);
    expect(disclosure.json().disclosure.redisclosure_restricted).toBe(true);
    const statement = 'The parent disputes the accuracy of the attendance record.';
    const outcome = await app.inject({
      method: 'POST', url: `/v1/compliance/rights-cases/${id}/ferpa-amendment-outcome`,
      headers: headers(tenant.apiKey),
      payload: { hearing_offered: true, outcome: 'denied', statement },
    });
    expect(outcome.statusCode).toBe(201);
    expect(JSON.stringify(outcome.json())).not.toContain(statement);
    const storedOutcome = await db.selectFrom('ferpa_amendment_outcomes').selectAll()
      .where('case_id', '=', id).executeTakeFirstOrThrow();
    expect(storedOutcome.encrypted_statement).not.toContain(statement);
  });

  it('records an encrypted four-factor HIPAA breach assessment', async () => {
    const tenant = await seedCustomer({ tier: 'enterprise', scopes: ['messages'] });
    await activate(tenant.customerId, 'hipaa');
    const created = await app.inject({
      method: 'POST', url: '/v1/compliance/rights-cases', headers: headers(tenant.apiKey),
      payload: { mode: 'hipaa', kind: 'breach_assessment', subject_ref: 'incident-subject' },
    });
    const id = created.json().case.id;
    const analysis = 'Clinical identifiers were viewed by one unintended recipient and promptly deleted.';
    const response = await app.inject({
      method: 'POST', url: `/v1/compliance/rights-cases/${id}/hipaa-breach-assessment`,
      headers: headers(tenant.apiKey),
      payload: {
        nature_extent_risk: 'high', unauthorized_person_risk: 'low',
        acquired_or_viewed: true, mitigation_completed: true,
        breach_presumed: true, analysis,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(JSON.stringify(response.json())).not.toContain(analysis);
    const stored = await db.selectFrom('hipaa_breach_assessments').selectAll()
      .where('case_id', '=', id).executeTakeFirstOrThrow();
    expect(stored.encrypted_analysis.startsWith('v1:')).toBe(true);
    expect(stored.encrypted_analysis).not.toContain(analysis);
  });

  it('keeps one tenant from listing another tenant rights cases', async () => {
    const owner = await seedCustomer({ tier: 'enterprise', scopes: ['messages'] });
    const outsider = await seedCustomer({ tier: 'enterprise', scopes: ['messages'] });
    await activate(owner.customerId, 'hipaa');
    await app.inject({
      method: 'POST', url: '/v1/compliance/rights-cases', headers: headers(owner.apiKey),
      payload: { mode: 'hipaa', kind: 'access', subject_ref: 'isolated-patient' },
    });
    const list = await app.inject({
      method: 'GET', url: '/v1/compliance/rights-cases', headers: { authorization: `Bearer ${outsider.apiKey}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().cases).toEqual([]);
  });
});
