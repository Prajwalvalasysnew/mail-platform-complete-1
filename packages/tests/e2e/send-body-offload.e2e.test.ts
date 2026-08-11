// Proves the send path actually offloads the message body when a non-inline
// store is active: the message row carries a pointer (not the inline body), and
// the body is retrievable from the store. Uses the filesystem backend — the
// zero-cost, no-external-dependency option — so it's fully verifiable here.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { buildTestApp } from './harness.js';
import { db, seedCustomer, setBodyStore, FilesystemStore, loadMessageBody } from '@platform/shared';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});
afterAll(async () => {
  setBodyStore(null);
  await app.close();
});
afterEach(() => setBodyStore(null));

describe('send body offload', () => {
  it('offloads the body to the configured store and keeps only a pointer inline', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'send-bodies-'));
    setBodyStore(new FilesystemStore(dir));

    const cust = await seedCustomer({ scopes: ['send'] });
    const domain = `mail-${Date.now()}.test.example`;
    await db.insertInto('sending_domains').values({
      customer_id: cust.customerId, domain,
      dkim_public_key: 'k', dkim_private_key: 'k', verified_at: new Date(), dkim_verified: true, spf_verified: true,
    } as any).execute();

    const res = await app.inject({
      method: 'POST', url: '/v1/send',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { from: `hi@${domain}`, to: 'rcpt@example.com', subject: 'Offloaded', html: '<h1>Body</h1>', text: 'Body' },
    });
    expect(res.statusCode).toBe(202);
    const messageId = res.json().message_ids[0];

    const row = await db
      .selectFrom('messages')
      .select(['html_body', 'text_body', 'body_storage', 'body_object_key', 'body_size', 'body_hash'])
      .where('message_id', '=', messageId)
      .executeTakeFirstOrThrow();

    // Inline columns cleared; pointer populated.
    expect(row.html_body).toBeNull();
    expect(row.text_body).toBeNull();
    expect(row.body_storage).toBe('fs');
    expect(row.body_object_key).toBeTruthy();
    expect(Number(row.body_size)).toBeGreaterThan(0);

    // The body is retrievable exactly as sent (what the worker would read).
    const loaded = await loadMessageBody(row);
    expect(loaded).toEqual({ html: '<h1>Body</h1>', text: 'Body' });
  });

  it('keeps bodies inline by default (no store configured)', async () => {
    setBodyStore(null);
    delete process.env.BODY_STORAGE;
    const cust = await seedCustomer({ scopes: ['send'] });
    const domain = `mail2-${Date.now()}.test.example`;
    await db.insertInto('sending_domains').values({
      customer_id: cust.customerId, domain,
      dkim_public_key: 'k', dkim_private_key: 'k', verified_at: new Date(), dkim_verified: true, spf_verified: true,
    } as any).execute();

    const res = await app.inject({
      method: 'POST', url: '/v1/send',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { from: `hi@${domain}`, to: 'rcpt@example.com', subject: 'Inline', html: '<h1>Inline</h1>' },
    });
    expect(res.statusCode).toBe(202);
    const row = await db.selectFrom('messages').select(['html_body', 'body_storage']).where('message_id', '=', res.json().message_ids[0]).executeTakeFirstOrThrow();
    expect(row.body_storage).toBe('inline');
    expect(row.html_body).toBe('<h1>Inline</h1>');
  });

  it.each(['free', 'paid', 'enterprise'] as const)(
    'offloads BATCH bodies for the %s tier (regression: batch path silently dropped bodies)',
    async (tier) => {
    // Regression guard. The /send/batch path previously hard-coded
    // body_storage:'inline' and null'd the body WITHOUT calling bodyStore.put()
    // when a non-inline store was active — so every batch message delivered an
    // empty email. This proves each batch entry is offloaded and round-trips.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-bodies-'));
    setBodyStore(new FilesystemStore(dir));

    const cust = await seedCustomer({ tier, scopes: ['send'] });
    const domain = `mailb-${Date.now()}.test.example`;
    await db.insertInto('sending_domains').values({
      customer_id: cust.customerId, domain,
      dkim_public_key: 'k', dkim_private_key: 'k', verified_at: new Date(), dkim_verified: true, spf_verified: true,
    } as any).execute();

    const res = await app.inject({
      method: 'POST', url: '/v1/send/batch',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: {
        messages: [
          { from: `hi@${domain}`, to: 'a@example.com', subject: 'B1', html: '<h1>One</h1>', text: 'One' },
          { from: `hi@${domain}`, to: 'b@example.com', subject: 'B2', html: '<h1>Two</h1>', text: 'Two' },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.accepted).toBe(2);

    const ids = body.results.filter((r: any) => r.accepted).map((r: any) => r.message_id);
    expect(ids).toHaveLength(2);

    const rows = await db
      .selectFrom('messages')
      .select(['message_id', 'subject', 'html_body', 'text_body', 'body_storage', 'body_object_key'])
      .where('message_id', 'in', ids)
      .execute();

    for (const row of rows) {
      // Body must be offloaded, not silently dropped.
      expect(row.html_body).toBeNull();
      expect(row.body_storage).toBe('fs');
      expect(row.body_object_key).toBeTruthy();
      const loaded = await loadMessageBody(row);
      // The body round-trips and is non-empty (the bug delivered {} / empty).
      expect(loaded.html).toBeTruthy();
      expect(loaded.text).toBeTruthy();
    }
    },
  );
});
