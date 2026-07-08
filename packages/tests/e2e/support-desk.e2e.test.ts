// End-to-end support-desk enhancements: SLA due times + first-response stamp +
// breach queue, AI suggested draft reply, canned responses (macros), and CSAT.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, seedAdminSession } from './harness.js';
import { db } from '@platform/shared';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});
afterAll(async () => {
  await app.close();
});

async function register(email: string) {
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/register', headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: 'Cust', org_name: 'Org' },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { token: string; customer_id: string };
}

function req(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as any, url, headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { payload } : {}) });
}

describe('support SLA', () => {
  it('sets SLA due times on creation and stamps first_responded_at on the first agent reply', async () => {
    const cust = await register(`sla-${Date.now()}@example.com`);
    const admin = await seedAdminSession('support');

    const created = await req(cust.token, 'POST', '/v1/support/tickets', { subject: 'urgent issue', body: 'cannot send', priority: 'urgent' });
    expect(created.statusCode).toBe(201);
    const ticketId = created.json().ticket.id;

    const row1 = await db.selectFrom('support_tickets').select(['first_response_due_at', 'resolution_due_at', 'first_responded_at']).where('id', '=', ticketId).executeTakeFirstOrThrow();
    expect(row1.first_response_due_at).toBeTruthy();
    expect(row1.resolution_due_at).toBeTruthy();
    expect(row1.first_responded_at).toBeNull();

    // Agent replies -> first_responded_at stamped
    const reply = await req(admin.token, 'POST', `/admin/support-tickets/${ticketId}/messages`, { body: 'Looking into it now.' });
    expect(reply.statusCode).toBe(201);
    const row2 = await db.selectFrom('support_tickets').select(['first_responded_at']).where('id', '=', ticketId).executeTakeFirstOrThrow();
    expect(row2.first_responded_at).toBeTruthy();
  });

  it('lists tickets past their SLA in the breach queue', async () => {
    const cust = await register(`breach-${Date.now()}@example.com`);
    const admin = await seedAdminSession('support');
    const created = await req(cust.token, 'POST', '/v1/support/tickets', { subject: 'breaching', body: 'help', priority: 'normal' });
    const ticketId = created.json().ticket.id;

    // Backdate the first-response due time to the past, leaving it unanswered.
    await db.updateTable('support_tickets').set({ first_response_due_at: new Date(Date.now() - 3600_000) } as any).where('id', '=', ticketId).execute();

    const res = await req(admin.token, 'GET', '/admin/support-tickets/sla-breaches');
    expect(res.statusCode).toBe(200);
    const ids = res.json().breaches.map((b: any) => b.id);
    expect(ids).toContain(ticketId);
    const breach = res.json().breaches.find((b: any) => b.id === ticketId);
    expect(breach.sla.firstResponseBreached).toBe(true);
  });
});

describe('support AI suggested reply', () => {
  it('returns an editable draft without sending it', async () => {
    const cust = await register(`sugg-${Date.now()}@example.com`);
    const admin = await seedAdminSession('support');
    const created = await req(cust.token, 'POST', '/v1/support/tickets', { subject: 'DKIM failing', body: 'My emails are bouncing from gmail', category: 'deliverability' });
    const ticketId = created.json().ticket.id;

    const res = await req(admin.token, 'POST', `/admin/support-tickets/${ticketId}/suggest-reply`);
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().draft).toBe('string');
    expect(res.json().draft.length).toBeGreaterThan(20);
    expect(res.json().model).toBeTruthy();

    // Draft must NOT have been posted as a message.
    const msgs = await db.selectFrom('support_ticket_messages').select((eb) => eb.fn.countAll<number>().as('c')).where('ticket_id', '=', ticketId).executeTakeFirstOrThrow();
    expect(Number(msgs.c)).toBe(1); // only the original customer message
  });
});

describe('support canned responses', () => {
  it('supports CRUD for agent macros', async () => {
    const admin = await seedAdminSession('operator');
    const created = await req(admin.token, 'POST', '/admin/support/canned-responses', { title: 'DKIM help', body: 'Please add this TXT record...', category: 'deliverability' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const list = await req(admin.token, 'GET', '/admin/support/canned-responses?category=deliverability');
    expect(list.json().canned_responses.some((c: any) => c.id === id)).toBe(true);

    const patch = await req(admin.token, 'PATCH', `/admin/support/canned-responses/${id}`, { title: 'DKIM setup help' });
    expect(patch.statusCode).toBe(200);

    const del = await req(admin.token, 'DELETE', `/admin/support/canned-responses/${id}`);
    expect(del.statusCode).toBe(200);
    const del2 = await req(admin.token, 'DELETE', `/admin/support/canned-responses/${id}`);
    expect(del2.statusCode).toBe(404);
  });
});

describe('support CSAT', () => {
  it('lets a customer rate a resolved ticket but not an open one', async () => {
    const cust = await register(`csat-${Date.now()}@example.com`);
    const admin = await seedAdminSession('support');
    const created = await req(cust.token, 'POST', '/v1/support/tickets', { subject: 'q', body: 'question' });
    const ticketId = created.json().ticket.id;

    // Cannot rate while open
    const early = await req(cust.token, 'POST', `/v1/support/tickets/${ticketId}/rate`, { rating: 5 });
    expect(early.statusCode).toBe(409);

    // Admin resolves it
    const resolve = await req(admin.token, 'PATCH', `/admin/support-tickets/${ticketId}`, { status: 'resolved' });
    expect(resolve.statusCode).toBe(200);

    // Now the customer can rate
    const rate = await req(cust.token, 'POST', `/v1/support/tickets/${ticketId}/rate`, { rating: 5, comment: 'great help' });
    expect(rate.statusCode).toBe(200);
    const row = await db.selectFrom('support_tickets').select(['satisfaction_rating', 'rated_at']).where('id', '=', ticketId).executeTakeFirstOrThrow();
    expect(Number(row.satisfaction_rating)).toBe(5);
    expect(row.rated_at).toBeTruthy();
  });
});
