// E2E: BASE-05 (compliance implementation plan) — privacy case management.
//
// Data-subject requests are tracked cases with statutory deadlines, identity
// verification, one statutory extension, denial with documented reason,
// artifacts, closure evidence, and PI minimization at closure of erasure
// cases. Tenant-scoped via RLS like every other privacy surface.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer } from './harness.js';
import { erasedRecipientPseudonym } from '@platform/shared';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

const headers = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });

async function createCase(apiKey: string, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST', url: '/v1/privacy/cases', headers: headers(apiKey),
    payload: {
      subject_identifier: `subject-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      intake_source: 'email',
      request_types: ['access'],
      jurisdiction: 'gdpr',
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().case;
}

describe('privacy case management', () => {
  it('creates a case with the GDPR one-month deadline and a created event', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const c = await createCase(cust.apiKey);
    expect(c.status).toBe('received');
    const days = (new Date(c.due_at).getTime() - new Date(c.received_at).getTime()) / 86400000;
    expect(Math.round(days)).toBe(30);

    const got = await app.inject({ method: 'GET', url: `/v1/privacy/cases/${c.id}`, headers: headers(cust.apiKey) });
    expect(got.statusCode).toBe(200);
    expect(got.json().case.events.map((e: any) => e.event)).toEqual(['created']);
  });

  it('uses the CCPA 45-day deadline and 45-day extension', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const c = await createCase(cust.apiKey, { jurisdiction: 'ccpa' });
    const days = (new Date(c.due_at).getTime() - new Date(c.received_at).getTime()) / 86400000;
    expect(Math.round(days)).toBe(45);

    const ext = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${c.id}/extend`, headers: headers(cust.apiKey),
      payload: { reason: 'Complex request across multiple stores' },
    });
    expect(ext.statusCode).toBe(200);
    const extDays = (new Date(ext.json().case.extended_until).getTime() - new Date(c.due_at).getTime()) / 86400000;
    expect(Math.round(extDays)).toBe(45);

    // Only one statutory extension.
    const again = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${c.id}/extend`, headers: headers(cust.apiKey),
      payload: { reason: 'again' },
    });
    expect(again.statusCode).toBe(422);
    expect(again.json().error).toBe('already_extended');
  });

  it('walks the full lifecycle and pseudonymizes the subject at closure of an erasure case', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const subject = `lifecycle-${Date.now()}@example.com`;
    const c = await createCase(cust.apiKey, { subject_identifier: subject, request_types: ['access', 'erasure'] });

    // Cannot fulfill before identity verification.
    let res = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${c.id}/transition`, headers: headers(cust.apiKey),
      payload: { status: 'in_progress' },
    });
    expect(res.statusCode).toBe(200);
    res = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${c.id}/transition`, headers: headers(cust.apiKey),
      payload: { status: 'fulfilled' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('verification_required');

    // Verify, attach artifact + communication, fulfill, close.
    expect((await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${c.id}/verify`, headers: headers(cust.apiKey),
      payload: { method: 'signed-in account email challenge' },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${c.id}/artifacts`, headers: headers(cust.apiKey),
      payload: { kind: 'deletion_request', ref: '00000000-0000-0000-0000-000000000001' },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${c.id}/communications`, headers: headers(cust.apiKey),
      payload: { direction: 'outbound', channel: 'email', summary: 'confirmation sent' },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${c.id}/transition`, headers: headers(cust.apiKey),
      payload: { status: 'fulfilled', approved_by: 'privacy-officer' },
    })).statusCode).toBe(200);
    const closed = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${c.id}/transition`, headers: headers(cust.apiKey),
      payload: { status: 'closed' },
    });
    expect(closed.statusCode).toBe(200);

    // Closure evidence: full event trail; erasure case retains only pseudonym.
    const body = closed.json().case;
    expect(body.subject_identifier).toBe(erasedRecipientPseudonym(cust.customerId, subject));
    expect(body.subject_pseudonymized_at).toBeTruthy();
    expect(body.approved_by).toBe('privacy-officer');
    expect(body.closed_at).toBeTruthy();
    const trail = (await app.inject({
      method: 'GET', url: `/v1/privacy/cases/${c.id}`, headers: headers(cust.apiKey),
    })).json().case.events.map((e: any) => e.event);
    expect(trail).toEqual(['created', 'status_changed', 'verified', 'artifact_attached', 'communication', 'status_changed', 'closed']);
  });

  it('rejects illegal transitions and requires a denial reason', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const c = await createCase(cust.apiKey);

    const bad = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${c.id}/transition`, headers: headers(cust.apiKey),
      payload: { status: 'closed' },
    });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error).toBe('invalid_transition');

    const deny = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${c.id}/transition`, headers: headers(cust.apiKey),
      payload: { status: 'denied' },
    });
    expect(deny.statusCode).toBe(422);
    expect(deny.json().error).toBe('denial_reason_required');

    const denied = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${c.id}/transition`, headers: headers(cust.apiKey),
      payload: { status: 'denied', denial_reason: 'Identity could not be verified after two attempts' },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json().case.denial_reason).toContain('Identity could not be verified');
  });

  it('is tenant-scoped: another customer cannot see or touch the case', async () => {
    const a = await seedCustomer({ scopes: ['messages'] });
    const b = await seedCustomer({ scopes: ['messages'] });
    const c = await createCase(a.apiKey);

    expect((await app.inject({ method: 'GET', url: `/v1/privacy/cases/${c.id}`, headers: headers(b.apiKey) })).statusCode).toBe(404);
    const foreign = await app.inject({
      method: 'POST', url: `/v1/privacy/cases/${c.id}/verify`, headers: headers(b.apiKey),
      payload: { method: 'x' },
    });
    expect(foreign.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/v1/privacy/cases', headers: headers(b.apiKey) });
    expect(list.json().cases.map((x: any) => x.id)).not.toContain(c.id);
  });
});
