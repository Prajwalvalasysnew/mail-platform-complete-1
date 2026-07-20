// SendGrid v3 shim: existing SendGrid client code works after swapping the
// base URL and key.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain, seedSuppression, type SeededCustomer } from './harness.js';
import { db } from '@platform/shared';

let app: FastifyInstance;
let cust: SeededCustomer;
let domain: string;

beforeAll(async () => {
  app = await buildTestApp();
  cust = await seedCustomer();
  domain = await seedVerifiedDomain(cust.customerId);
});

afterAll(async () => {
  await app.close();
});

function sgSend(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/v3/mail/send',
    headers: { authorization: `Bearer ${cust.apiKey}` },
    payload,
  });
}

describe('SendGrid v3 compatibility shim', () => {
  it('accepts a canonical SendGrid payload and delivers through the native pipeline', async () => {
    const to = `sg-user-${Date.now()}@example.com`;
    const res = await sgSend({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: `notify@${domain}`, name: 'Acme Notifications' },
      subject: 'Your order shipped',
      content: [
        { type: 'text/plain', value: 'Order 1001 shipped.' },
        { type: 'text/html', value: '<p>Order <b>1001</b> shipped.</p>' },
      ],
      categories: ['shipping'],
      custom_args: { order_id: '1001' },
      tracking_settings: { open_tracking: { enable: true }, click_tracking: { enable: false } },
    });

    // SendGrid contract: 202, empty body, X-Message-Id header.
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
    const messageId = res.headers['x-message-id'] as string;
    expect(messageId).toBeTruthy();

    const row = await db
      .selectFrom('messages')
      .select(['to_address', 'from_name', 'subject', 'tags', 'metadata', 'tracking_opens', 'tracking_clicks'])
      .where('message_id', '=', messageId)
      .executeTakeFirstOrThrow();
    expect(row.to_address).toBe(to);
    expect(row.from_name).toBe('Acme Notifications');
    expect(row.tags).toEqual(['shipping']);
    expect((row.metadata as any).order_id).toBe('1001');
    expect(row.tracking_opens).toBe(true);
    expect(row.tracking_clicks).toBe(false);
  });

  it('maps multiple personalizations to separate sends with their own subjects', async () => {
    const a = `sg-a-${Date.now()}@example.com`;
    const b = `sg-b-${Date.now()}@example.com`;
    const res = await sgSend({
      personalizations: [
        { to: [{ email: a }], subject: 'Hello A' },
        { to: [{ email: b }], subject: 'Hello B' },
      ],
      from: { email: `notify@${domain}` },
      content: [{ type: 'text/plain', value: 'hi' }],
    });
    expect(res.statusCode).toBe(202);

    const rows = await db
      .selectFrom('messages')
      .select(['to_address', 'subject'])
      .where('to_address', 'in', [a, b])
      .execute();
    const byTo = new Map(rows.map((r) => [r.to_address, r.subject]));
    expect(byTo.get(a)).toBe('Hello A');
    expect(byTo.get(b)).toBe('Hello B');
  });

  it('carries attachments through the shim', async () => {
    const to = `sg-att-${Date.now()}@example.com`;
    const res = await sgSend({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: `notify@${domain}` },
      subject: 'Invoice',
      content: [{ type: 'text/plain', value: 'attached' }],
      attachments: [
        { content: Buffer.from('%PDF-1.4 test').toString('base64'), filename: 'inv.pdf', type: 'application/pdf' },
      ],
    });
    expect(res.statusCode).toBe(202);
    const row = await db
      .selectFrom('messages')
      .select('attachments')
      .where('message_id', '=', res.headers['x-message-id'] as string)
      .executeTakeFirstOrThrow();
    expect(row.attachments![0]!.filename).toBe('inv.pdf');
  });

  it('rejects SendGrid dynamic template ids with a migration pointer', async () => {
    const res = await sgSend({
      personalizations: [{ to: [{ email: 'x@example.com' }] }],
      from: { email: `notify@${domain}` },
      template_id: 'd-8f4c2b1a9e7d4f56',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].message).toContain('Migrate the template');
  });

  it('surfaces native-pipeline failures in SendGrid error shape', async () => {
    const res = await sgSend({
      personalizations: [{ to: [{ email: 'x@example.com' }] }],
      from: { email: 'notify@unregistered-domain.example' },
      subject: 'x',
      content: [{ type: 'text/plain', value: 'x' }],
    });
    expect(res.statusCode).toBe(403); // domain_not_registered upstream
    expect(res.json().errors[0].message).toBeTruthy();
  });

  it('still enforces suppressions through the native pipeline', async () => {
    const suppressed = `sg-supp-${Date.now()}@example.com`;
    await seedSuppression(cust.customerId, suppressed);
    const res = await sgSend({
      personalizations: [{ to: [{ email: suppressed }] }],
      from: { email: `notify@${domain}` },
      subject: 'x',
      content: [{ type: 'text/plain', value: 'x' }],
    });
    expect(res.statusCode).toBe(202); // accepted, zero delivered — SendGrid semantics
    const count = await db
      .selectFrom('messages')
      .select(db.fn.countAll().as('c'))
      .where('to_address', '=', suppressed)
      .executeTakeFirst();
    expect(Number((count as any).c)).toBe(0);
  });
});
