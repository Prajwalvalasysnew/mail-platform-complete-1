// Phase 2.1 (docs/DATABASE_10_10_PLAN.md): per-plan / per-tenant retention.
//
// Covers window resolution (override → plan → platform default), per-tenant
// body purge in the sweep, the "no explicit window → platform behavior"
// guarantee, and logical read visibility on the messages API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer } from './harness.js';
import {
  db,
  runRetention,
  resolveTenantRetention,
  clearRetentionPolicyCache,
  seedOldMessage,
  seedOldEvent,
  getMessageRow,
  getEventTypes,
} from '@platform/shared';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

const DEFAULTS = { eventsDays: 90, bodyDays: 90, messageDays: 395 };

async function setOverride(customerId: string, fields: Record<string, number | null>) {
  await db.updateTable('customers').set(fields as any).where('id', '=', customerId).execute();
  clearRetentionPolicyCache();
}

describe('tenant retention window resolution', () => {
  it('no plan, no override → platform defaults, not explicit', async () => {
    const { customerId } = await seedCustomer();
    const w = await resolveTenantRetention(customerId, db, DEFAULTS);
    expect(w).toEqual({ eventsDays: 90, bodyDays: 90, explicit: false });
  });

  it('customer override wins and is explicit; events clamp to the platform ceiling', async () => {
    const { customerId } = await seedCustomer();
    await setOverride(customerId, { events_retention_days: 7, body_retention_days: 365 });

    const w = await resolveTenantRetention(customerId, db, DEFAULTS);
    expect(w.explicit).toBe(true);
    expect(w.eventsDays).toBe(7); // tighter than ceiling → allowed
    expect(w.bodyDays).toBe(365); // may extend up to messageDays (395)

    await setOverride(customerId, { events_retention_days: 999 });
    const clamped = await resolveTenantRetention(customerId, db, DEFAULTS);
    expect(clamped.eventsDays).toBe(90); // physical partition ceiling
  });

  it('active subscription plan supplies the window when no override', async () => {
    const { customerId } = await seedCustomer();
    await db.insertInto('subscriptions').values({
      customer_id: customerId,
      plan: 'free',
      status: 'active',
    } as any).execute();
    clearRetentionPolicyCache();

    const w = await resolveTenantRetention(customerId, db, DEFAULTS);
    expect(w.explicit).toBe(true);
    expect(w.eventsDays).toBe(7); // free plan seeds 7/7 in migration 065
    expect(w.bodyDays).toBe(7);
  });

  it.each([
    { plan: 'pro', expectedEvents: 90, expectedBody: 90 },
    // Enterprise requests 365 days of event history, but the deployment's
    // 90-day physical event ceiling remains fail-closed until operators raise
    // RETENTION_EVENT_DAYS and provision matching partitions/storage.
    { plan: 'enterprise', expectedEvents: 90, expectedBody: 90 },
  ])(
    '$plan plan resolves its catalog entitlement within deployment ceilings',
    async ({ plan, expectedEvents, expectedBody }) => {
      const { customerId } = await seedCustomer({
        tier: plan === 'enterprise' ? 'enterprise' : 'paid',
      });
      await db.insertInto('subscriptions').values({
        customer_id: customerId,
        plan,
        status: 'active',
      } as any).execute();
      clearRetentionPolicyCache();

      const w = await resolveTenantRetention(customerId, db, DEFAULTS);
      expect(w).toEqual({
        eventsDays: expectedEvents,
        bodyDays: expectedBody,
        explicit: true,
      });
    },
  );

  it('Enterprise receives the full 365-day event entitlement when the deployment ceiling supports it', async () => {
    const { customerId } = await seedCustomer({ tier: 'enterprise' });
    await db.insertInto('subscriptions').values({
      customer_id: customerId,
      plan: 'enterprise',
      status: 'active',
    } as any).execute();
    clearRetentionPolicyCache();

    const w = await resolveTenantRetention(customerId, db, {
      eventsDays: 365,
      bodyDays: 90,
      messageDays: 395,
    });
    expect(w).toEqual({ eventsDays: 365, bodyDays: 90, explicit: true });
  });
});

describe('per-tenant retention enforcement in the sweep', () => {
  it('a tight tenant window purges bodies/events earlier than the platform default', async () => {
    const { customerId: tightCustomer } = await seedCustomer();
    const { customerId: defaultCustomer } = await seedCustomer();
    await setOverride(tightCustomer, { events_retention_days: 7, body_retention_days: 7 });

    // 30-day-old data: inside the platform 90d window, outside the 7d window.
    const tightMsg = await seedOldMessage(tightCustomer, {
      daysAgo: 30, status: 'delivered', htmlBody: '<p>tight</p>',
    });
    const defaultMsg = await seedOldMessage(defaultCustomer, {
      daysAgo: 30, status: 'delivered', htmlBody: '<p>default</p>',
    });
    await seedOldEvent(tightCustomer, tightMsg, 'delivered', 30);
    await seedOldEvent(defaultCustomer, defaultMsg, 'delivered', 30);

    await runRetention({ messageBodyRetentionDays: 90, eventRetentionDays: 90 });

    expect((await getMessageRow(tightMsg))?.html_body).toBeNull();
    expect(await getEventTypes(tightMsg)).toEqual([]);

    expect((await getMessageRow(defaultMsg))?.html_body).toBe('<p>default</p>');
    expect(await getEventTypes(defaultMsg)).toContain('delivered');
  });

  it('an extended body window keeps bodies past the platform default', async () => {
    const { customerId } = await seedCustomer();
    await setOverride(customerId, { body_retention_days: 365 });

    const msg = await seedOldMessage(customerId, {
      daysAgo: 100, status: 'delivered', htmlBody: '<p>extended</p>',
    });

    await runRetention({ messageBodyRetentionDays: 90 });

    expect((await getMessageRow(msg))?.html_body).toBe('<p>extended</p>');
  });
});

describe('logical read visibility (messages API)', () => {
  it('an explicit window hides older history from list and single-get', async () => {
    const seeded = await seedCustomer();
    await setOverride(seeded.customerId, { events_retention_days: 7 });

    const oldMsg = await seedOldMessage(seeded.customerId, { daysAgo: 30, status: 'delivered' });
    const newMsg = await seedOldMessage(seeded.customerId, { daysAgo: 1, status: 'delivered' });

    const list = await app.inject({
      method: 'GET', url: '/v1/messages',
      headers: { authorization: `Bearer ${seeded.apiKey}` },
    });
    expect(list.statusCode).toBe(200);
    const ids = list.json().messages.map((m: any) => m.message_id);
    expect(ids).toContain(newMsg);
    expect(ids).not.toContain(oldMsg);

    const single = await app.inject({
      method: 'GET', url: `/v1/messages/${oldMsg}`,
      headers: { authorization: `Bearer ${seeded.apiKey}` },
    });
    expect(single.statusCode).toBe(404);
  });

  it('no explicit window keeps the full physically-retained history visible', async () => {
    const seeded = await seedCustomer();
    const oldMsg = await seedOldMessage(seeded.customerId, { daysAgo: 30, status: 'delivered' });

    const list = await app.inject({
      method: 'GET', url: '/v1/messages',
      headers: { authorization: `Bearer ${seeded.apiKey}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().messages.map((m: any) => m.message_id)).toContain(oldMsg);
  });
});
