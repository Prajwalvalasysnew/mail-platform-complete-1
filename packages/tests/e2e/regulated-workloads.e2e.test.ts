import { describe, expect, it } from 'vitest';
import {
  REQUIRED_PREREQUISITES, db, submitPrerequisiteEvidence, reviewPrerequisiteEvidence,
  type RegulatedWorkloadMode,
} from '@platform/shared';
import { buildTestApp, seedAdminSession, seedCustomer } from './harness.js';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function approveEvidence(customerId: string, mode: RegulatedWorkloadMode, reviewer: string) {
  for (const prerequisite of REQUIRED_PREREQUISITES[mode]) {
    const evidence = await submitPrerequisiteEvidence({
      customerId, mode, prerequisite,
      artifactUri: `https://evidence.example/${customerId}/${mode}/${prerequisite}`,
      artifactSha256: 'a'.repeat(64),
      submittedBy: `customer:${customerId}`,
      expiresAt: new Date(Date.now() + 365 * 86400_000),
    });
    await reviewPrerequisiteEvidence({ id: evidence.id, decision: 'approved', reviewedBy: reviewer });
  }
}

describe('regulated workload activation is fail-closed', () => {
  it('requires HTTPS, a real checksum shape, future expiry, and reviewer separation', async () => {
    const tenant = await seedCustomer({ tier: 'enterprise' });
    await expect(submitPrerequisiteEvidence({
      customerId: tenant.customerId, mode: 'hipaa', prerequisite: 'applicability_approved',
      artifactUri: 'http://evidence.example/report', artifactSha256: 'a'.repeat(64),
      submittedBy: 'same@example.com',
    })).rejects.toMatchObject({ code: 'invalid_state' });
    const evidence = await submitPrerequisiteEvidence({
      customerId: tenant.customerId, mode: 'hipaa', prerequisite: 'applicability_approved',
      artifactUri: 'https://evidence.example/report', artifactSha256: 'a'.repeat(64),
      submittedBy: 'same@example.com', expiresAt: new Date(Date.now() + 86400_000),
    });
    await expect(reviewPrerequisiteEvidence({
      id: evidence.id, decision: 'approved', reviewedBy: 'same@example.com',
    })).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('lets Enterprise request HIPAA but not activate it', async () => {
    const app = await buildTestApp();
    const tenant = await seedCustomer({ tier: 'enterprise' });
    const requested = await app.inject({
      method: 'POST',
      url: '/v1/compliance/workloads/hipaa/request',
      headers: bearer(tenant.apiKey),
    });
    expect(requested.statusCode).toBe(202);
    expect(requested.json().posture.status).toBe('pending');

    const listed = await app.inject({
      method: 'GET', url: '/v1/compliance/workloads', headers: bearer(tenant.apiKey),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().modes.find((m: any) => m.mode === 'hipaa').status).toBe('pending');
    await app.close();
  });

  it.each([
    ...(['free', 'paid'] as const).flatMap((tier) =>
      (['hipaa', 'ferpa', 'sec_finra'] as const).map((mode) => ({ tier, mode })),
    ),
  ])('refuses $tier requests for $mode', async ({ tier, mode }) => {
    const app = await buildTestApp();
    const tenant = await seedCustomer({ tier });
    const res = await app.inject({
      method: 'POST', url: `/v1/compliance/workloads/${mode}/request`, headers: bearer(tenant.apiKey),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('enterprise_required');
    await app.close();
  });

  it('requires every prerequisite and an admin decision before activation', async () => {
    const app = await buildTestApp();
    const tenant = await seedCustomer({ tier: 'enterprise' });
    const admin = await seedAdminSession('admin');
    await app.inject({
      method: 'POST', url: '/v1/compliance/workloads/sec_finra/request', headers: bearer(tenant.apiKey),
    });

    const incomplete = await app.inject({
      method: 'POST',
      url: `/admin/regulated-workloads/${tenant.customerId}/sec_finra/review`,
      headers: bearer(admin.token),
      payload: { decision: 'activate', prerequisites: { applicability_approved: true } },
    });
    expect(incomplete.statusCode).toBe(409);
    expect(incomplete.json().error).toBe('prerequisites_incomplete');

    await approveEvidence(tenant.customerId, 'sec_finra', admin.email);
    const activated = await app.inject({
      method: 'POST',
      url: `/admin/regulated-workloads/${tenant.customerId}/sec_finra/review`,
      headers: bearer(admin.token),
      payload: { decision: 'activate', note: 'All external and technical evidence reviewed.' },
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().posture.status).toBe('active');

    const audit = await db.selectFrom('audit_log').select(['action', 'metadata'])
      .where('action', '=', 'admin:regulated_workload_activate')
      .orderBy('id', 'desc').executeTakeFirst();
    expect(audit?.metadata).toMatchObject({ customer_id: tenant.customerId, mode: 'sec_finra' });
    expect(JSON.stringify(audit?.metadata)).not.toContain('independent_assessment_approved":true');
    await app.close();
  });

  it('requires a reason to suspend an active mode', async () => {
    const app = await buildTestApp();
    const tenant = await seedCustomer({ tier: 'enterprise' });
    const admin = await seedAdminSession('admin');
    await app.inject({
      method: 'POST', url: '/v1/compliance/workloads/ferpa/request', headers: bearer(tenant.apiKey),
    });
    await approveEvidence(tenant.customerId, 'ferpa', admin.email);
    await app.inject({
      method: 'POST',
      url: `/admin/regulated-workloads/${tenant.customerId}/ferpa/review`,
      headers: bearer(admin.token),
      payload: { decision: 'activate' },
    });
    const noReason = await app.inject({
      method: 'POST',
      url: `/admin/regulated-workloads/${tenant.customerId}/ferpa/review`,
      headers: bearer(admin.token),
      payload: { decision: 'suspend' },
    });
    expect(noReason.statusCode).toBe(409);
    const suspended = await app.inject({
      method: 'POST',
      url: `/admin/regulated-workloads/${tenant.customerId}/ferpa/review`,
      headers: bearer(admin.token),
      payload: { decision: 'suspend', note: 'Annual assessment expired.' },
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json().posture.status).toBe('suspended');
    await app.close();
  });
});
