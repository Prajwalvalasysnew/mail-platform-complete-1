import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedAdminSession } from './harness.js';
import {
  runRetention,
  seedOldMessage,
  seedOldEvent,
  seedOldAuditEntry,
  getMessageRow,
  getEventTypes,
  countAuditEntries,
  InMemoryObjectClient,
  S3Store,
  setBodyStore,
  getBillingEvent,
  replayBillingEvent,
  db,
} from '@platform/shared';

let app: FastifyInstance;
let operatorToken: string;
let supportToken: string;

beforeAll(async () => {
  app = await buildTestApp();
  operatorToken = (await seedAdminSession('operator')).token;
  supportToken = (await seedAdminSession('support')).token;
});

afterAll(async () => {
  setBodyStore(null); // reset to env-default store
  await app.close();
});

function adminReq(method: string, url: string, payload?: unknown, token = operatorToken) {
  return app.inject({
    method: method as any,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { payload } : {}),
  });
}

describe('T4 retention / cleanup jobs', () => {
  describe('inline body purge', () => {
    it('nulls out html_body and text_body on old terminal messages', async () => {
      const { customerId } = await seedCustomer();
      const msgId = await seedOldMessage(customerId, {
        daysAgo: 100,
        status: 'delivered',
        htmlBody: '<p>stale body</p>',
        textBody: 'stale body',
      });

      const result = await runRetention({ messageBodyRetentionDays: 90 });

      const row = await getMessageRow(msgId);
      expect(row?.html_body).toBeNull();
      expect(row?.text_body).toBeNull();
      expect(row?.message_id).toBe(msgId); // row is kept
      expect(result.messages_body_purged).toBeGreaterThanOrEqual(1);
    });

    it('does not touch bodies for messages within the retention window', async () => {
      const { customerId } = await seedCustomer();
      const recentId = await seedOldMessage(customerId, {
        daysAgo: 10,
        status: 'delivered',
        htmlBody: '<p>recent</p>',
      });

      await runRetention({ messageBodyRetentionDays: 90 });

      const row = await getMessageRow(recentId);
      expect(row?.html_body).toBe('<p>recent</p>');
    });

    it('does not touch bodies for non-terminal messages even if old', async () => {
      const { customerId } = await seedCustomer();
      const queuedId = await seedOldMessage(customerId, {
        daysAgo: 100,
        status: 'queued',
        htmlBody: '<p>queued</p>',
      });

      await runRetention({ messageBodyRetentionDays: 90 });

      const row = await getMessageRow(queuedId);
      expect(row?.html_body).toBe('<p>queued</p>');
    });
  });

  describe('offloaded body purge', () => {
    it('deletes object store entry and clears pointer when all referencing messages are past retention', async () => {
      const memClient = new InMemoryObjectClient();
      const store = new S3Store(memClient);
      setBodyStore(store);

      const { storage, object_key, size, hash } = await store.put({ html: '<p>offloaded</p>' });
      const { customerId } = await seedCustomer();
      const msgId = await seedOldMessage(customerId, {
        daysAgo: 100,
        status: 'hard_bounced',
        bodyStorage: 'fs',
        bodyObjectKey: object_key,
      });

      expect(memClient.store.has(object_key!)).toBe(true);

      const result = await runRetention({ messageBodyRetentionDays: 90 });

      expect(memClient.store.has(object_key!)).toBe(false);
      const row = await getMessageRow(msgId);
      expect(row?.body_object_key).toBeNull();
      expect(result.messages_body_purged).toBeGreaterThanOrEqual(1);

      setBodyStore(null);
    });

    it('preserves object store entry when a live message still references the same key', async () => {
      const memClient = new InMemoryObjectClient();
      const store = new S3Store(memClient);
      setBodyStore(store);

      const { object_key } = await store.put({ html: '<p>shared</p>' });
      const { customerId } = await seedCustomer();

      // old terminal message (past retention)
      await seedOldMessage(customerId, {
        daysAgo: 100,
        status: 'delivered',
        bodyStorage: 'fs',
        bodyObjectKey: object_key,
      });
      // recent message still referencing the same key
      await seedOldMessage(customerId, {
        daysAgo: 5,
        status: 'delivered',
        bodyStorage: 'fs',
        bodyObjectKey: object_key,
      });

      await runRetention({ messageBodyRetentionDays: 90 });

      // Object must survive because the recent message still needs it.
      expect(memClient.store.has(object_key!)).toBe(true);

      setBodyStore(null);
    });
  });

  describe('event purge', () => {
    it('removes old event rows', async () => {
      const { customerId } = await seedCustomer();
      const msgId = await seedOldMessage(customerId, { daysAgo: 100, status: 'delivered' });
      await seedOldEvent(customerId, msgId, 'delivered', 100);

      const result = await runRetention({ eventRetentionDays: 90 });

      const events = await getEventTypes(msgId);
      expect(events).not.toContain('delivered');
      expect(result.events_purged).toBeGreaterThanOrEqual(1);
    });

    it('keeps events within the retention window', async () => {
      const { customerId } = await seedCustomer();
      const msgId = await seedOldMessage(customerId, { daysAgo: 10, status: 'delivered' });
      await seedOldEvent(customerId, msgId, 'opened', 10);

      await runRetention({ eventRetentionDays: 90 });

      const events = await getEventTypes(msgId);
      expect(events).toContain('opened');
    });
  });

  describe('audit log purge', () => {
    it('removes old audit entries', async () => {
      const { customerId } = await seedCustomer();
      await seedOldAuditEntry(customerId, 'test:old_action', 400);

      const before = await countAuditEntries(customerId, 'test:old_action');
      expect(before).toBeGreaterThanOrEqual(1);

      const result = await runRetention({ auditRetentionDays: 365 });

      const after = await countAuditEntries(customerId, 'test:old_action');
      expect(after).toBe(0);
      expect(result.audit_purged).toBeGreaterThanOrEqual(1);
    });

    it('keeps audit entries within the retention window', async () => {
      const { customerId } = await seedCustomer();
      await seedOldAuditEntry(customerId, 'test:recent_action', 30);

      await runRetention({ auditRetentionDays: 365 });

      const after = await countAuditEntries(customerId, 'test:recent_action');
      expect(after).toBeGreaterThanOrEqual(1);
    });
  });

  describe('admin endpoint POST /admin/retention/run', () => {
    it('runs retention and returns structured result', async () => {
      const { customerId } = await seedCustomer();
      await seedOldMessage(customerId, { daysAgo: 100, status: 'failed', htmlBody: '<p>x</p>' });

      const res = await adminReq('POST', '/admin/retention/run', {
        message_body_retention_days: 90,
        event_retention_days: 90,
        audit_retention_days: 365,
        review_queue_retention_days: 30,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      const result = res.json().result;
      expect(typeof result.messages_body_purged).toBe('number');
      expect(typeof result.events_purged).toBe('number');
      expect(typeof result.audit_purged).toBe('number');
      expect(typeof result.review_queue_purged).toBe('number');
    });

    it('accepts an empty body (uses env defaults)', async () => {
      const res = await adminReq('POST', '/admin/retention/run', {});
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });

    it('enforces operator role', async () => {
      const noAuth = await app.inject({ method: 'POST', url: '/admin/retention/run' });
      expect(noAuth.statusCode).toBe(401);

      const support = await adminReq('POST', '/admin/retention/run', {}, supportToken);
      expect(support.statusCode).toBe(403);
      expect(support.json().error).toBe('insufficient_role');
    });
  });

  // PCI-03 / BASE-06: a stored billing payload has value only while replay is
  // plausible. After its window the payload column is cleared, but the row —
  // the idempotency marker that stops a provider retry from double-applying —
  // must survive.
  describe('billing payload expiry', () => {
    const evId = (p: string) => `evt_ret_${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    it('nulls payloads past the window and keeps the idempotency row', async () => {
      const oldId = evId('old');
      await db.insertInto('billing_events').values({
        provider_event_id: oldId,
        type: 'customer.subscription.updated',
        provider: 'stripe',
        payload: { id: oldId, type: 'customer.subscription.updated' } as any,
        processed_at: new Date(Date.now() - 120 * 86_400_000),
      }).execute();

      const result = await runRetention({ billingPayloadRetentionDays: 90 });
      expect(result.billing_payloads_purged).toBeGreaterThanOrEqual(1);

      const row = await db.selectFrom('billing_events')
        .select(['provider_event_id', 'payload', 'type'])
        .where('provider_event_id', '=', oldId).executeTakeFirst();
      expect(row).toBeTruthy();          // row kept: still the dedupe marker
      expect(row!.payload).toBeNull();   // payload gone
      expect(row!.type).toBe('customer.subscription.updated');

      // The admin API now reports it exactly like a pre-035 row.
      const stored = await getBillingEvent(oldId);
      expect(stored!.replayable).toBe(false);
      expect((await replayBillingEvent(oldId)).status).toBe('not_replayable');
    });

    it('keeps payloads inside the window', async () => {
      const freshId = evId('fresh');
      await db.insertInto('billing_events').values({
        provider_event_id: freshId,
        type: 'customer.subscription.updated',
        provider: 'stripe',
        payload: { id: freshId } as any,
        processed_at: new Date(),
      }).execute();

      await runRetention({ billingPayloadRetentionDays: 90 });

      const row = await db.selectFrom('billing_events').select('payload')
        .where('provider_event_id', '=', freshId).executeTakeFirst();
      expect(row!.payload).not.toBeNull();
    });
  });
});
