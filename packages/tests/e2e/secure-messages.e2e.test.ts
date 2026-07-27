import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { db } from '@platform/shared';
import { buildTestApp, seedCustomer } from './harness.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

describe('secure-message portal', () => {
  it('requires an active HIPAA or FERPA mode', async () => {
    const tenant = await seedCustomer({ tier: 'enterprise', scopes: ['send'] });
    const res = await app.inject({
      method: 'POST', url: '/v1/secure-messages', headers: bearer(tenant.apiKey),
      payload: {
        to: 'patient@example.com', mode: 'hipaa', subject: 'Private record',
        text: 'Patient date of birth is listed in this medical record.',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('mode_inactive');
  });

  it('encrypts content, requires both credentials, audits access, and supports revocation', async () => {
    const tenant = await seedCustomer({ tier: 'enterprise', scopes: ['send'] });
    await db.insertInto('regulated_workload_posture').values({
      customer_id: tenant.customerId, mode: 'hipaa', status: 'active',
      prerequisites: {}, activated_at: new Date(), reviewed_at: new Date(), reviewed_by: 'test-reviewer',
    }).execute();
    const sensitive = 'Patient date of birth is listed in this medical record.';
    const created = await app.inject({
      method: 'POST', url: '/v1/secure-messages', headers: bearer(tenant.apiKey),
      payload: {
        to: 'patient@example.com', mode: 'hipaa', subject: 'Private record',
        text: sensitive, expires_hours: 1,
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.portal_token).toBeTruthy();
    expect(body.access_code).toBeTruthy();
    expect(body.secure_message).not.toHaveProperty('encrypted_payload');

    const stored = await db.selectFrom('secure_messages').selectAll()
      .where('id', '=', body.secure_message.id).executeTakeFirstOrThrow();
    expect(stored.encrypted_payload.startsWith('v1:')).toBe(true);
    expect(stored.encrypted_payload).not.toContain(sensitive);
    expect(stored.portal_token_hash).not.toContain(body.portal_token);
    expect(stored.access_code_hash).not.toContain(body.access_code);

    const wrong = await app.inject({
      method: 'POST', url: '/v1/secure-portal/access',
      payload: { portal_token: body.portal_token, access_code: `${body.access_code}x` },
    });
    expect(wrong.statusCode).toBe(404);
    const accessed = await app.inject({
      method: 'POST', url: '/v1/secure-portal/access',
      payload: { portal_token: body.portal_token, access_code: body.access_code },
    });
    expect(accessed.statusCode).toBe(200);
    expect(accessed.headers['cache-control']).toContain('no-store');
    expect(accessed.json().message.payload.text).toBe(sensitive);
    const audit = await db.selectFrom('audit_log').select('metadata')
      .where('action', '=', 'secure_message_accessed').where('customer_id', '=', tenant.customerId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(audit.metadata)).not.toContain(sensitive);

    const revoked = await app.inject({
      method: 'POST', url: `/v1/secure-messages/${body.secure_message.id}/revoke`,
      headers: { authorization: `Bearer ${tenant.apiKey}` },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const afterRevoke = await app.inject({
      method: 'POST', url: '/v1/secure-portal/access',
      payload: { portal_token: body.portal_token, access_code: body.access_code },
    });
    expect(afterRevoke.statusCode).toBe(404);
  });
});
