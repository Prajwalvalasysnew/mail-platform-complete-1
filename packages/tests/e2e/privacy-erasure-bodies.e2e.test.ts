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
import { db, setBodyStore, FilesystemStore, getBodyStore, retryPendingBodyErasures, erasedRecipientPseudonym } from '@platform/shared';

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
    const row = await db.selectFrom('messages').select(['message_id', 'body_object_key', 'body_storage'])
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
    const tombstone = await db.selectFrom('privacy_message_tombstones').select('message_id')
      .where('customer_id', '=', cust.customerId).where('message_id', '=', row.message_id).executeTakeFirst();
    expect(tombstone?.message_id).toBe(row.message_id);
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

  it('keeps the erasure pending when object storage deletion fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gdpr-failure-'));
    const backing = new FilesystemStore(dir);
    setBodyStore({
      kind: 'fs',
      put: (body) => backing.put(body),
      get: (key) => backing.get(key),
      delete: async () => { throw new Error('simulated_object_store_outage'); },
    });
    const cust = await seedCustomer({ scopes: ['send', 'messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const victim = `erase-failure-${Date.now()}@example.com`;
    const sent = await app.inject({
      method: 'POST', url: '/v1/send',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { from: `s@${domain}`, to: victim, subject: 'secret', text: 'PII' },
    });
    expect(sent.statusCode).toBe(202);

    const del = await app.inject({
      method: 'POST', url: '/v1/privacy/delete-recipient',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { recipient: victim },
    });
    expect(del.statusCode).toBe(202);
    expect(del.json()).toMatchObject({ status: 'pending', objects_pending: 1, bodies_deleted: 0 });
    // BASE-03: the evidence row stores the keyed pseudonym, never the
    // plaintext recipient.
    const request = await db.selectFrom('deletion_requests').select(['id', 'status'])
      .where('customer_id', '=', cust.customerId)
      .where('recipient', '=', erasedRecipientPseudonym(cust.customerId, victim))
      .executeTakeFirstOrThrow();
    expect(request.status).toBe('pending');
    const item = await db.selectFrom('deletion_object_items').select(['status', 'attempts', 'last_error'])
      .where('deletion_request_id', '=', request.id).where('storage_kind', '=', 'fs').executeTakeFirstOrThrow();
    expect(item.status).toBe('failed');
    expect(item.attempts).toBe(1);
    expect(item.last_error).toContain('simulated_object_store_outage');

    setBodyStore(backing);
    const retried = await retryPendingBodyErasures({ limit: 10, maxAttempts: 3 });
    expect(retried.claimed).toBeGreaterThanOrEqual(1);
    expect(retried.completed).toBeGreaterThanOrEqual(1);
    expect(retried.failed).toBe(0);
    expect(retried.requestsCompleted).toBeGreaterThanOrEqual(1);
    const repairedRequest = await db.selectFrom('deletion_requests').select('status')
      .where('id', '=', request.id).executeTakeFirstOrThrow();
    expect(repairedRequest.status).toBe('completed');
    const repairedItem = await db.selectFrom('deletion_object_items').select(['status', 'attempts', 'last_error'])
      .where('deletion_request_id', '=', request.id).where('storage_kind', '=', 'fs').executeTakeFirstOrThrow();
    expect(repairedItem).toMatchObject({ status: 'completed', attempts: 2, last_error: null });
  });
});
