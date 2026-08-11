import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  seedAdminSession,
  seedCustomer,
  seedQueuedMessage,
  seedMessageEvent,
  type Harness,
} from './harness.js';

let h: Pick<Harness, 'app' | 'close'>;

beforeAll(async () => {
  const app = await buildTestApp();
  h = { app, close: () => app.close() };
});

afterAll(async () => {
  await h.close();
});

function adminReq(token: string, method: string, url: string, payload?: unknown) {
  return h.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  });
}

describe('E2E admin support console', () => {
  it('searches customers and returns support overview without exposing API key hashes', async () => {
    const admin = await seedAdminSession('support');
    const cust = await seedCustomer({ tier: 'enterprise' });
    const msg = await seedQueuedMessage(cust.customerId, { to: 'vip@example.com', status: 'delivered' });
    await seedMessageEvent(cust.customerId, msg, 'delivered');

    const list = await adminReq(admin.token, 'GET', `/admin/customers?q=${encodeURIComponent(cust.customerId)}&limit=5`);
    expect(list.statusCode).toBe(200);
    expect(list.json().customers.map((c: any) => c.id)).toContain(cust.customerId);

    const overview = await adminReq(admin.token, 'GET', `/admin/customers/${cust.customerId}`);
    expect(overview.statusCode).toBe(200);
    const body = overview.json();
    expect(body.customer.id).toBe(cust.customerId);
    expect(body.recent_messages.map((m: any) => m.message_id)).toContain(msg);
    expect(body.api_keys[0].key_prefix).toBeTruthy();
    expect(body.api_keys[0].key_hash).toBeUndefined();
  });

  it('creates and lists internal support notes', async () => {
    const admin = await seedAdminSession('support');
    const cust = await seedCustomer();

    const created = await adminReq(admin.token, 'POST', `/admin/customers/${cust.customerId}/support-notes`, {
      body: 'Customer asked about warmup limits.',
      visibility: 'escalation',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().note.visibility).toBe('escalation');

    const notes = await adminReq(admin.token, 'GET', `/admin/customers/${cust.customerId}/support-notes`);
    expect(notes.statusCode).toBe(200);
    expect(notes.json().notes.map((n: any) => n.body)).toContain('Customer asked about warmup limits.');
    expect(notes.json().notes[0].admin_email).toBe(admin.email);
  });

  it('keeps dangerous customer actions restricted above support', async () => {
    const support = await seedAdminSession('support');
    const admin = await seedAdminSession('admin');
    const cust = await seedCustomer();

    const denied = await adminReq(support.token, 'POST', '/admin/customers/suspend', {
      customer_id: cust.customerId,
      reason: 'test',
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await adminReq(admin.token, 'POST', '/admin/customers/suspend', {
      customer_id: cust.customerId,
      reason: 'test',
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('manages support ticket conversations end to end', async () => {
    const admin = await seedAdminSession('support');
    const cust = await seedCustomer();

    const created = await adminReq(admin.token, 'POST', '/admin/support-tickets', {
      customer_id: cust.customerId,
      subject: 'Delivery issue',
      body: 'Customer reports Gmail deferrals.',
      priority: 'high',
      category: 'deliverability',
      assign_to_me: true,
    });
    expect(created.statusCode).toBe(201);
    const ticketId = created.json().ticket.id;
    expect(created.json().ticket.assigned_admin_user_id).toBe(admin.adminUserId);

    const list = await adminReq(admin.token, 'GET', '/admin/support-tickets?assigned=me&status=open');
    expect(list.statusCode).toBe(200);
    expect(list.json().tickets.map((t: any) => t.id)).toContain(ticketId);

    const reply = await adminReq(admin.token, 'POST', `/admin/support-tickets/${ticketId}/messages`, {
      body: 'We are checking the pool health now.',
    });
    expect(reply.statusCode).toBe(201);
    expect(reply.json().message.internal).toBe(false);

    const internal = await adminReq(admin.token, 'POST', `/admin/support-tickets/${ticketId}/messages`, {
      body: 'Internal: verify blocklist scan before replying again.',
      internal: true,
    });
    expect(internal.statusCode).toBe(201);
    expect(internal.json().message.internal).toBe(true);

    const resolved = await adminReq(admin.token, 'PATCH', `/admin/support-tickets/${ticketId}`, {
      status: 'resolved',
      priority: 'normal',
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().ticket.status).toBe('resolved');
    expect(resolved.json().ticket.resolved_at).toBeTruthy();
    expect(resolved.json().ticket.assigned_admin_user_id).toBe(admin.adminUserId);

    const detail = await adminReq(admin.token, 'GET', `/admin/support-tickets/${ticketId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().messages).toHaveLength(3);
    expect(detail.json().messages.map((m: any) => m.body)).toContain('Customer reports Gmail deferrals.');

    const triage = await adminReq(admin.token, 'POST', `/admin/support-tickets/${ticketId}/triage`);
    expect(triage.statusCode).toBe(200);
    expect(triage.json().triage.suggested_category).toBe('deliverability');
    expect(triage.json().ticket.ai_summary).toBeTruthy();
    expect(triage.json().ticket.ai_model).toBe('local-heuristic-v1');
  });

  it('marks the same ticket read concurrently without a unique-index race', async () => {
    const admin = await seedAdminSession('support');
    const cust = await seedCustomer();
    const created = await adminReq(admin.token, 'POST', '/admin/support-tickets', {
      customer_id: cust.customerId,
      subject: 'Concurrent read marker',
      body: 'The browser may issue overlapping read effects.',
    });
    expect(created.statusCode).toBe(201);
    const ticketId = created.json().ticket.id;

    const reads = await Promise.all(
      Array.from({ length: 12 }, () =>
        adminReq(admin.token, 'POST', `/admin/support-tickets/${ticketId}/read`)
      ),
    );
    expect(reads.map((response) => response.statusCode)).toEqual(Array(12).fill(200));
    expect(new Set(reads.map((response) => response.json().last_read_at)).size).toBeGreaterThan(0);
  });
});
