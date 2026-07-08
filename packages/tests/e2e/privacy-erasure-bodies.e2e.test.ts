// Regression: GDPR erasure (POST /v1/privacy/delete-recipient) must also remove
// the recipient's OFFLOADED body objects from the store, not just the DB rows.
// Previously it deleted the messages row but orphaned the PII-bearing body in
// fs/s3 indefinitely — a right-to-erasure violation that still reported
// "completed". The fix deletes orphaned (no-longer-referenced) body objects.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildTestApp, seedCustomer, seedVerifiedDomain } from './harness.js';
import { db, setBodyStore, FilesystemStore, getBodyStore } from '@platform/shared';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); setBodyStore(null); });

describe('GDPR erasure removes offloaded body objects', () => {
  it('deletes the body object for an erased recipient and reports bodies_deleted', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gdpr-bodies-'));
    setBodyStore(new FilesystemStore(dir));
    const store = getBodyStore();

    const cust = await seedCustomer({ scopes: ['send', 'messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);

    // Send a message with an offloaded body to a recipient we'll then erase.
    const victim = `erase-me-${Date.now()}@example.com`;
    const res = await app.inject({
      method: 'POST', url: '/v1/send',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { from: `s@${domain}`, to: victim, subject: 'secret', html: '<p>PII body content</p>', text: 'PII body content' },
    });
    expect(res.statusCode).toBe(202);

    // Grab the stored object key and confirm the body is retrievable pre-erasure.
    const row = await db.selectFrom('messages').select(['body_object_key', 'body_storage'])
      .where('customer_id', '=', cust.customerId).where('to_address', '=', victim).executeTakeFirstOrThrow();
    expect(row.body_storage).toBe('fs');
    const key = row.body_object_key as string;
    expect(key).toBeTruthy();
    const before = await store.get(key);
    expect(before.html ?? before.text).toBeTruthy();

    // Erase the recipient.
    const del = await app.inject({
      method: 'POST', url: '/v1/privacy/delete-recipient',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { recipient: victim },
    });
    expect(del.statusCode).toBe(200);
    const body = del.json();
    expect(body.status).toBe('completed');
    expect(body.messages_deleted).toBeGreaterThanOrEqual(1);
    expect(body.bodies_deleted).toBeGreaterThanOrEqual(1);
    // Internal storage keys must not leak in the response.
    expect(body.orphanKeys).toBeUndefined();

    // The body object must be GONE from the store (PII actually erased).
    await expect(store.get(key)).rejects.toBeTruthy();
  });

  it('does NOT delete a shared body object still referenced by another recipient', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gdpr-shared-'));
    setBodyStore(new FilesystemStore(dir));
    const store = getBodyStore();

    const cust = await seedCustomer({ scopes: ['send', 'messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);

    // Two recipients receive the IDENTICAL body — content-addressed storage
    // dedupes them to ONE object. Erasing one must not destroy the other's body.
    const html = '<p>shared identical content</p>';
    const victim = `shared-victim-${Date.now()}@example.com`;
    const keep = `shared-keep-${Date.now()}@example.com`;
    for (const to of [victim, keep]) {
      const r = await app.inject({
        method: 'POST', url: '/v1/send',
        headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
        payload: { from: `s@${domain}`, to, subject: 'same', html, text: 'shared identical content' },
      });
      expect(r.statusCode).toBe(202);
    }

    const keepRow = await db.selectFrom('messages').select('body_object_key')
      .where('customer_id', '=', cust.customerId).where('to_address', '=', keep).executeTakeFirstOrThrow();
    const sharedKey = keepRow.body_object_key as string;

    // Erase the victim.
    const del = await app.inject({
      method: 'POST', url: '/v1/privacy/delete-recipient',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { recipient: victim },
    });
    expect(del.statusCode).toBe(200);

    // The shared object must SURVIVE because `keep` still references it.
    const still = await store.get(sharedKey);
    expect(still.html ?? still.text).toBeTruthy();
  });
});
