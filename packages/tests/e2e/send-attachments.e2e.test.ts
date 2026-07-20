// Attachment support on /v1/send: validation, storage, and delivery loading.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain, type SeededCustomer } from './harness.js';
import { db, loadMessageBody } from '@platform/shared';

let app: FastifyInstance;
let cust: SeededCustomer;
let domain: string;

// "%PDF-1.4 fake invoice" — small but realistic payload.
const PDF_B64 = Buffer.from('%PDF-1.4\nfake invoice body for testing\n%%EOF').toString('base64');

beforeAll(async () => {
  app = await buildTestApp();
  cust = await seedCustomer();
  domain = await seedVerifiedDomain(cust.customerId);
});

afterAll(async () => {
  await app.close();
});

function send(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/v1/send',
    headers: { authorization: `Bearer ${cust.apiKey}` },
    payload: {
      from: `billing@${domain}`,
      to: `recipient-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      subject: 'Invoice attached',
      text: 'See attached invoice.',
      ...payload,
    },
  });
}

describe('send with attachments', () => {
  it('accepts a PDF, stores metadata + inline content, and loads it for delivery', async () => {
    const res = await send({
      attachments: [{ filename: 'invoice-1001.pdf', content: PDF_B64 }],
    });
    expect(res.statusCode).toBe(202);
    const messageId = res.json().message_ids[0];

    const row = await db
      .selectFrom('messages')
      .selectAll()
      .where('message_id', '=', messageId)
      .executeTakeFirstOrThrow();
    expect(row.attachments).toHaveLength(1);
    expect(row.attachments![0]!.filename).toBe('invoice-1001.pdf');
    expect(row.attachments![0]!.content_type).toBe('application/pdf');
    expect(row.attachments![0]!.size).toBeGreaterThan(0);

    // What the send worker hands to the transport (inline store in tests).
    const loaded = await loadMessageBody(row);
    expect(loaded.attachments).toHaveLength(1);
    expect(Buffer.from(loaded.attachments![0]!.content_b64, 'base64').toString()).toContain('fake invoice');
  });

  it('strips attachment content from the message-detail API (metadata only)', async () => {
    const sent = await send({ attachments: [{ filename: 'report.pdf', content: PDF_B64 }] });
    const messageId = sent.json().message_ids[0];

    const detail = await app.inject({
      method: 'GET', url: `/v1/messages/${encodeURIComponent(messageId)}`,
      headers: { authorization: `Bearer ${cust.apiKey}` },
    });
    expect(detail.statusCode).toBe(200);
    const att = detail.json().message.attachments;
    expect(att).toEqual([{ filename: 'report.pdf', content_type: 'application/pdf', size: expect.any(Number) }]);
    expect(JSON.stringify(detail.json())).not.toContain(PDF_B64);
  });

  it('refuses executable attachments', async () => {
    const res = await send({
      attachments: [{ filename: 'totally-safe.exe', content: PDF_B64 }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('attachment_rejected');
  });

  it('refuses invalid base64 and sanitizes hostile filenames', async () => {
    const bad = await send({ attachments: [{ filename: 'x.pdf', content: 'not base64 !!!' }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toBe('attachment_rejected');

    const hostile = await send({
      attachments: [{ filename: '../../etc/passwd\r\nX-Injected: 1.pdf', content: PDF_B64 }],
    });
    expect(hostile.statusCode).toBe(202);
    const row = await db
      .selectFrom('messages')
      .select('attachments')
      .where('message_id', '=', hostile.json().message_ids[0])
      .executeTakeFirstOrThrow();
    const name = row.attachments![0]!.filename;
    expect(name).not.toContain('/');
    expect(name).not.toContain('\r');
    expect(name).not.toContain('\n');
  });

  it('enforces the per-attachment size cap', async () => {
    // ~6 MB decoded (> 5 MB default cap) but under the zod b64 length cap.
    const big = Buffer.alloc(6 * 1024 * 1024, 65).toString('base64');
    const res = await send({ attachments: [{ filename: 'big.pdf', content: big }] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('attachment_too_large');
  });

  it('keeps sends without attachments untouched (null column)', async () => {
    const res = await send({});
    expect(res.statusCode).toBe(202);
    const row = await db
      .selectFrom('messages')
      .select('attachments')
      .where('message_id', '=', res.json().message_ids[0])
      .executeTakeFirstOrThrow();
    expect(row.attachments).toBeNull();
  });
});
