import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  seedAdminSession,
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

async function register(email: string) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: {
      email,
      password: 'correct-horse-battery',
      name: 'Customer User',
      org_name: 'Customer Org',
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { token: string; customer_id: string; user: { id: string; email: string } };
}

function userReq(token: string, method: string, url: string, payload?: unknown) {
  return h.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  });
}

function adminReq(token: string, method: string, url: string, payload?: unknown) {
  return h.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { payload } : {}),
  });
}

describe('E2E customer support tickets', () => {
  it('lets a customer open and reply to a ticket while hiding internal admin notes', async () => {
    const customer = await register(`support-${Date.now()}@example.com`);
    const admin = await seedAdminSession('support');

    const created = await userReq(customer.token, 'POST', '/v1/support/tickets', {
      subject: 'Webhook issue',
      body: 'Our webhook endpoint is returning timeout errors.',
      priority: 'high',
      category: 'technical',
    });
    expect(created.statusCode).toBe(201);
    const ticketId = created.json().ticket.id;
    expect(created.json().ticket.customer_id).toBe(customer.customer_id);
    expect(created.json().ticket.created_by_user_id).toBe(customer.user.id);

    const unreadAfterOwnCreate = await userReq(customer.token, 'GET', '/v1/support/tickets/unread-count');
    expect(unreadAfterOwnCreate.statusCode).toBe(200);
    expect(unreadAfterOwnCreate.json().unread).toBe(0);

    const adminInternal = await adminReq(admin.token, 'POST', `/admin/support-tickets/${ticketId}/messages`, {
      body: 'Internal: ask deliverability team if needed.',
      internal: true,
    });
    expect(adminInternal.statusCode).toBe(201);

    const adminPublic = await adminReq(admin.token, 'POST', `/admin/support-tickets/${ticketId}/messages`, {
      body: 'Please send us the latest webhook response body.',
    });
    expect(adminPublic.statusCode).toBe(201);

    const unreadAfterAdminReply = await userReq(customer.token, 'GET', '/v1/support/tickets/unread-count');
    expect(unreadAfterAdminReply.statusCode).toBe(200);
    expect(unreadAfterAdminReply.json().unread).toBe(1);

    const customerReply = await userReq(customer.token, 'POST', `/v1/support/tickets/${ticketId}/messages`, {
      body: 'We also see retries from your webhook worker.',
    });
    expect(customerReply.statusCode).toBe(201);
    expect(customerReply.json().message.author_type).toBe('customer_user');
    expect(customerReply.json().message.internal).toBe(false);

    const detail = await userReq(customer.token, 'GET', `/v1/support/tickets/${ticketId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().messages.map((m: any) => m.body)).toContain('Our webhook endpoint is returning timeout errors.');
    expect(detail.json().messages.map((m: any) => m.body)).toContain('Please send us the latest webhook response body.');
    expect(detail.json().messages.map((m: any) => m.body)).toContain('We also see retries from your webhook worker.');
    expect(detail.json().messages.map((m: any) => m.body)).not.toContain('Internal: ask deliverability team if needed.');

    const markRead = await userReq(customer.token, 'POST', `/v1/support/tickets/${ticketId}/read`);
    expect(markRead.statusCode).toBe(200);
    const unreadAfterRead = await userReq(customer.token, 'GET', '/v1/support/tickets/unread-count');
    expect(unreadAfterRead.json().unread).toBe(0);

    const list = await userReq(customer.token, 'GET', '/v1/support/tickets?status=open');
    expect(list.statusCode).toBe(200);
    expect(list.json().tickets.map((t: any) => t.id)).toContain(ticketId);
  });

  it('does not allow one customer to read or reply to another customer ticket', async () => {
    const a = await register(`support-a-${Date.now()}@example.com`);
    const b = await register(`support-b-${Date.now()}@example.com`);

    const created = await userReq(a.token, 'POST', '/v1/support/tickets', {
      subject: 'Billing question',
      body: 'Can you explain this invoice?',
      category: 'billing',
    });
    expect(created.statusCode).toBe(201);
    const ticketId = created.json().ticket.id;

    const read = await userReq(b.token, 'GET', `/v1/support/tickets/${ticketId}`);
    expect(read.statusCode).toBe(404);

    const reply = await userReq(b.token, 'POST', `/v1/support/tickets/${ticketId}/messages`, {
      body: 'Trying to reply across orgs',
    });
    expect(reply.statusCode).toBe(404);
  });
});
