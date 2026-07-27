// E2E: mandatory privacy regression test 6 (compliance implementation plan
// §3) — "a backup restore followed by tombstone replay does not resurrect
// usable erased data."
//
// Online erasure does not rewrite backup images, so restoring from a backup
// taken BEFORE an erasure brings the erased rows back. The test therefore
// simulates a real restore: erase a recipient through the public API, capture
// what the pre-erasure database looked like, write those rows back exactly as
// a restore would, then replay the tombstones and prove nothing usable
// survives.
//
// The tombstone table deliberately holds no recipient address, so replay has
// to recover the address from the restored rows themselves — which is also why
// the mismatch case below matters.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain } from './harness.js';
import {
  db,
  replayPrivacyTombstones,
  isMessagePrivacyErased,
  erasedRecipientPseudonym,
  isErasedPseudonym,
  generateMessageId,
} from '@platform/shared';

let app: FastifyInstance;

// Replay re-queues out-of-database deletions as `pending`, which is the point
// of the control — but retryPendingBodyErasures() is global, so leaving those
// rows behind would make an unrelated suite claim and fail on this suite's
// synthetic object keys. Track the tenants created here and drop their
// deletion requests at the end (deletion_object_items cascades).
const createdCustomers: string[] = [];
async function newCustomer() {
  const cust = await seedCustomer({ scopes: ['messages'] });
  createdCustomers.push(cust.customerId);
  return cust;
}

beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => {
  if (createdCustomers.length > 0) {
    await db.deleteFrom('deletion_requests').where('customer_id', 'in', createdCustomers).execute();
  }
  await app.close();
});

const recipient = () => `restore-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

/** Seed a recipient's full footprint: message, event, tracked link, consent. */
async function seedRecipientData(customerId: string, domain: string, to: string) {
  const messageId = generateMessageId(domain);
  await db.insertInto('messages').values({
    message_id: messageId,
    customer_id: customerId,
    to_address: to,
    from_address: `sender@${domain}`,
    subject: 'Your receipt',
    status: 'delivered',
    html_body: `<p>Hello ${to}</p>`,
    text_body: `Hello ${to}`,
    body_storage: 'inline',
  } as any).execute();

  await db.insertInto('events').values({
    message_id: messageId,
    customer_id: customerId,
    event_type: 'delivered',
    occurred_at: new Date(),
  } as any).execute();

  await db.insertInto('tracked_links').values({
    message_id: messageId,
    original_url: 'https://example.com/promo',
  } as any).execute();

  await db.insertInto('consent_events').values({
    customer_id: customerId,
    email: to,
    action: 'suppress',
    reason: 'unsubscribe',
    source: 'one_click_unsubscribe',
    notes: `opted out from ${messageId}`,
  } as any).execute();

  return messageId;
}

/** Everything a restore would bring back for this recipient. */
async function snapshot(customerId: string, messageId: string) {
  const [messages, events, links, consent] = await Promise.all([
    db.selectFrom('messages').selectAll().where('message_id', '=', messageId).execute(),
    db.selectFrom('events').selectAll().where('message_id', '=', messageId).execute(),
    db.selectFrom('tracked_links').selectAll().where('message_id', '=', messageId).execute(),
    db.selectFrom('consent_events').selectAll().where('customer_id', '=', customerId).execute(),
  ]);
  return { messages, events, links, consent };
}

/** Write the snapshot back, exactly as restoring a pre-erasure backup would. */
async function restore(snap: Awaited<ReturnType<typeof snapshot>>) {
  if (snap.messages.length) {
    await db.insertInto('messages').values(snap.messages as any)
      .onConflict((oc) => oc.doNothing()).execute();
  }
  if (snap.events.length) {
    await db.insertInto('events').values(snap.events as any)
      .onConflict((oc) => oc.doNothing()).execute();
  }
  if (snap.links.length) {
    await db.insertInto('tracked_links').values(snap.links as any)
      .onConflict((oc) => oc.doNothing()).execute();
  }
  // Erasure PSEUDONYMIZES consent rows in place rather than deleting them, so
  // a restore reverts each row to its pre-erasure values — it does not add a
  // second copy. Replaying that faithfully is what makes the re-scrub
  // assertions below meaningful.
  for (const row of snap.consent as any[]) {
    await db.updateTable('consent_events')
      .set({ email: row.email, notes: row.notes, pseudonymized_at: row.pseudonymized_at })
      .where('id', '=', row.id)
      .execute();
  }
}

async function erase(apiKey: string, to: string) {
  return app.inject({
    method: 'POST', url: '/v1/privacy/delete-recipient',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    payload: { recipient: to },
  });
}

describe('restore + tombstone replay does not resurrect erased data', () => {
  it('re-deletes message, event, and link rows brought back by a restore', async () => {
    const cust = await newCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    const messageId = await seedRecipientData(cust.customerId, domain, to);

    // Snapshot the pre-erasure state — this is the backup image.
    const snap = await snapshot(cust.customerId, messageId);
    expect(snap.messages).toHaveLength(1);

    const erased = await erase(cust.apiKey, to);
    expect(erased.statusCode).toBe(200);
    expect(await isMessagePrivacyErased(messageId)).toBe(true);

    // The restore brings it all back.
    await restore(snap);
    expect(await db.selectFrom('messages').select('message_id')
      .where('message_id', '=', messageId).executeTakeFirst()).toBeTruthy();

    // Replay the tombstones, as the restore runbook requires.
    const replay = await replayPrivacyTombstones({ customerId: cust.customerId });
    expect(replay.resurrected_messages).toBeGreaterThanOrEqual(1);
    expect(replay.messages_purged).toBeGreaterThanOrEqual(1);
    expect(replay.mismatched_skipped).toBe(0);

    // Nothing usable survives.
    const [msg, events, links] = await Promise.all([
      db.selectFrom('messages').select('message_id').where('message_id', '=', messageId).executeTakeFirst(),
      db.selectFrom('events').select('message_id').where('message_id', '=', messageId).execute(),
      db.selectFrom('tracked_links').select('message_id').where('message_id', '=', messageId).execute(),
    ]);
    expect(msg).toBeUndefined();
    expect(events).toHaveLength(0);
    expect(links).toHaveLength(0);

    // The tombstone remains, so a later restore is caught the same way.
    expect(await isMessagePrivacyErased(messageId)).toBe(true);
  });

  it('re-pseudonymizes the direct identifier a restore brought back', async () => {
    const cust = await newCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    const messageId = await seedRecipientData(cust.customerId, domain, to);
    const snap = await snapshot(cust.customerId, messageId);

    expect((await erase(cust.apiKey, to)).statusCode).toBe(200);

    // After erasure the consent ledger holds only the pseudonym…
    const afterErase = await db.selectFrom('consent_events').select('email')
      .where('customer_id', '=', cust.customerId).execute();
    expect(afterErase.every((r) => isErasedPseudonym(r.email))).toBe(true);

    // …and the restore puts the plaintext address back.
    await restore(snap);
    const afterRestore = await db.selectFrom('consent_events').select('email')
      .where('customer_id', '=', cust.customerId).execute();
    expect(afterRestore.some((r) => r.email === to)).toBe(true);

    await replayPrivacyTombstones({ customerId: cust.customerId });

    // Replay scrubs it again — no plaintext address anywhere in the ledger,
    // and the surviving rows carry the same keyed pseudonym as before.
    const afterReplay = await db.selectFrom('consent_events').select(['email', 'notes'])
      .where('customer_id', '=', cust.customerId).execute();
    expect(afterReplay.some((r) => r.email === to)).toBe(false);
    expect(afterReplay.every((r) => isErasedPseudonym(r.email))).toBe(true);
    expect(afterReplay.every((r) => r.notes === null)).toBe(true);
    expect(afterReplay.every((r) => r.email === erasedRecipientPseudonym(cust.customerId, to))).toBe(true);
  });

  it('re-queues out-of-database deletions for restored offloaded bodies', async () => {
    const cust = await newCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();

    const messageId = generateMessageId(domain);
    await db.insertInto('messages').values({
      message_id: messageId, customer_id: cust.customerId, to_address: to,
      from_address: `sender@${domain}`, subject: 'Offloaded', status: 'delivered',
      body_storage: 'fs', body_object_key: `bodies/${messageId}.json`,
    } as any).execute();

    const snap = await snapshot(cust.customerId, messageId);
    // 202, not 200: the offloaded body object could not be removed inline, so
    // the erasure completes with object deletions still pending.
    expect((await erase(cust.apiKey, to)).statusCode).toBe(202);
    await restore(snap);

    const replay = await replayPrivacyTombstones({ customerId: cust.customerId });
    expect(replay.object_items_requeued).toBeGreaterThan(0);

    // The restored body object is queued for deletion through the same audited
    // retry path as the original erasure, not deleted ad hoc.
    const items = await db.selectFrom('deletion_object_items').select(['object_key', 'storage_kind', 'status'])
      .where('object_key', '=', `bodies/${messageId}.json`).execute();
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.status === 'pending')).toBe(true);

    // …and the request is pending again, not still reported complete.
    const req = await db.selectFrom('deletion_requests').select('status')
      .where('customer_id', '=', cust.customerId).executeTakeFirstOrThrow();
    expect(req.status).toBe('pending');
  });

  it('is a no-op when nothing was resurrected', async () => {
    // A tenant that has erasures but no restore: replay must do nothing.
    const cust = await newCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    await seedRecipientData(cust.customerId, domain, to);
    expect((await erase(cust.apiKey, to)).statusCode).toBe(200);

    const replay = await replayPrivacyTombstones({ customerId: cust.customerId });
    expect(replay.resurrected_messages).toBe(0);
    expect(replay.messages_purged).toBe(0);
    expect(replay.recipients_repseudonymized).toBe(0);
    expect(replay.object_items_requeued).toBe(0);
  });

  it('skips a restored row whose address does not match the recorded erasure', async () => {
    const cust = await newCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    const messageId = await seedRecipientData(cust.customerId, domain, to);
    const snap = await snapshot(cust.customerId, messageId);

    expect((await erase(cust.apiKey, to)).statusCode).toBe(200);
    await restore(snap);

    // Corrupt the restored row so its address no longer hashes to the
    // pseudonym on the deletion request — replay must refuse to act on it
    // rather than scrub the wrong recipient's records.
    await db.updateTable('messages').set({ to_address: 'someone-else@example.com' })
      .where('message_id', '=', messageId).execute();

    const replay = await replayPrivacyTombstones({ customerId: cust.customerId });
    expect(replay.mismatched_skipped).toBeGreaterThanOrEqual(1);

    // The row is left in place for an operator to review, not silently purged.
    const still = await db.selectFrom('messages').select('message_id')
      .where('message_id', '=', messageId).executeTakeFirst();
    expect(still).toBeTruthy();

    await db.deleteFrom('messages').where('message_id', '=', messageId).execute();
  });
});
