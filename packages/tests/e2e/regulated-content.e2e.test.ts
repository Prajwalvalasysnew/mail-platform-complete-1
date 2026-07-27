import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { classifyRegulatedContent, db } from '@platform/shared';
import { buildTestApp, seedCustomer, seedVerifiedDomain } from './harness.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

describe('value-free regulated content classification', () => {
  it('requires identity and regulated context signals', () => {
    expect(classifyRegulatedContent({ text: 'The grade of this service is excellent.' })).toEqual([]);
    expect(classifyRegulatedContent({ text: 'Patient date of birth is on the medical record.' })).toMatchObject([
      { category: 'phi', field: 'text' },
    ]);
    expect(classifyRegulatedContent({ text: 'Student ID is shown on the transcript.' })).toMatchObject([
      { category: 'education_record', field: 'text' },
    ]);
    expect(classifyRegulatedContent({ text: 'Client account number appears on this trade confirmation.' })).toMatchObject([
      { category: 'broker_dealer_record', field: 'text' },
    ]);
  });

  it('blocks regulated content when its mode is not active and stores no content', async () => {
    const tenant = await seedCustomer({ tier: 'enterprise', scopes: ['send'] });
    const domain = await seedVerifiedDomain(tenant.customerId);
    const sensitive = 'Patient date of birth is listed in this medical record.';
    const res = await app.inject({
      method: 'POST', url: '/v1/send', headers: headers(tenant.apiKey),
      payload: { from: `sender@${domain}`, to: 'recipient@example.com', subject: 'Record', text: sensitive },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: 'regulated_content_detected', categories: ['phi'], required_modes: ['hipaa'],
    });
    expect(JSON.stringify(res.json())).not.toContain('date of birth');
    const messages = await db.selectFrom('messages').select('id').where('customer_id', '=', tenant.customerId).execute();
    expect(messages).toHaveLength(0);
    const audit = await db.selectFrom('audit_log').select('metadata')
      .where('customer_id', '=', tenant.customerId).where('action', '=', 'regulated_content_blocked').executeTakeFirstOrThrow();
    expect(JSON.stringify(audit.metadata)).not.toContain(sensitive);
  });

  it('requires the secure portal even after the matching HIPAA/FERPA mode is active', async () => {
    const tenant = await seedCustomer({ tier: 'enterprise', scopes: ['send'] });
    const domain = await seedVerifiedDomain(tenant.customerId);
    await db.updateTable('customers').set({ physical_address: '1 Compliance Way, Test City' })
      .where('id', '=', tenant.customerId).execute();
    await db.insertInto('regulated_workload_posture').values({
      customer_id: tenant.customerId,
      mode: 'ferpa',
      status: 'active',
      prerequisites: {},
      activated_at: new Date(),
      reviewed_at: new Date(),
      reviewed_by: 'test-reviewer',
    }).execute();
    const res = await app.inject({
      method: 'POST', url: '/v1/send', headers: headers(tenant.apiKey),
      payload: {
        from: `sender@${domain}`, to: 'recipient@example.com', subject: 'Education record',
        text: 'Student ID is shown on the transcript.',
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('secure_portal_required');
  });
});
