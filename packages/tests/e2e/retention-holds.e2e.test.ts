// Phase 0 retention hardening (docs/DATABASE_10_10_PLAN.md):
//   1. runRetention must preserve data covered by an active legal hold —
//      tenant-wide and recipient-scoped — and purge it after release.
//   2. The previously unbounded tables (tracked_links, webhook_delivery_log,
//      blocklist_checks, messages metadata rows) now age out.
import { describe, expect, it } from 'vitest';
import {
  db,
  runRetention,
  placeLegalHold,
  releaseLegalHold,
  recipientHoldScope,
  seedCustomer,
  seedOldMessage,
  seedOldEvent,
  seedOldTrackedLink,
  seedOldWebhookDelivery,
  seedOldBlocklistCheck,
  getMessageRow,
  getEventTypes,
} from '@platform/shared';

describe('retention is legal-hold aware', () => {
  it('a customer-scope hold preserves bodies, events, and message rows; release purges them', async () => {
    const { customerId } = await seedCustomer();
    const msgId = await seedOldMessage(customerId, {
      daysAgo: 400,
      status: 'delivered',
      htmlBody: '<p>held body</p>',
    });
    await seedOldEvent(customerId, msgId, 'delivered', 400);

    const hold = await placeLegalHold({ customerId, scope: 'customer', reason: 'litigation' });

    const result = await runRetention({
      messageBodyRetentionDays: 90,
      eventRetentionDays: 90,
      messageRetentionDays: 395,
    });

    // Everything about this message survived the sweep.
    const row = await getMessageRow(msgId);
    expect(row?.html_body).toBe('<p>held body</p>');
    expect(await getEventTypes(msgId)).toContain('delivered');
    expect(result.held_rows_skipped).toBeGreaterThanOrEqual(2); // body row + event row

    // Release the hold: the next sweep purges body, event, and the row itself.
    await releaseLegalHold(customerId, hold.id);
    await runRetention({
      messageBodyRetentionDays: 90,
      eventRetentionDays: 90,
      messageRetentionDays: 395,
    });

    expect(await getMessageRow(msgId)).toBeNull();
    expect(await getEventTypes(msgId)).toEqual([]);
  });

  it('a recipient-scope hold preserves only that recipient', async () => {
    const { customerId } = await seedCustomer();
    const heldRcpt = `held-${Date.now()}@example.com`;
    const heldMsg = await seedOldMessage(customerId, {
      daysAgo: 100,
      status: 'delivered',
      htmlBody: '<p>held</p>',
      toAddress: heldRcpt,
    });
    const freeMsg = await seedOldMessage(customerId, {
      daysAgo: 100,
      status: 'delivered',
      htmlBody: '<p>free</p>',
    });
    await seedOldEvent(customerId, heldMsg, 'delivered', 100);
    await seedOldEvent(customerId, freeMsg, 'delivered', 100);

    await placeLegalHold({ customerId, scope: recipientHoldScope(heldRcpt), reason: 'dispute' });

    await runRetention({ messageBodyRetentionDays: 90, eventRetentionDays: 90 });

    expect((await getMessageRow(heldMsg))?.html_body).toBe('<p>held</p>');
    expect(await getEventTypes(heldMsg)).toContain('delivered');

    expect((await getMessageRow(freeMsg))?.html_body).toBeNull();
    expect(await getEventTypes(freeMsg)).toEqual([]);
  });

  it('a hold preserves tracked links for the held message', async () => {
    const { customerId: heldCustomer } = await seedCustomer();
    const { customerId: freeCustomer } = await seedCustomer();
    const heldMsg = await seedOldMessage(heldCustomer, { daysAgo: 100, status: 'delivered' });
    const freeMsg = await seedOldMessage(freeCustomer, { daysAgo: 100, status: 'delivered' });
    const heldLink = await seedOldTrackedLink(heldMsg, 100);
    const freeLink = await seedOldTrackedLink(freeMsg, 100);

    await placeLegalHold({ customerId: heldCustomer, scope: 'customer', reason: 'litigation' });

    const result = await runRetention({ messageBodyRetentionDays: 90 });
    expect(result.tracked_links_purged).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .selectFrom('tracked_links')
      .select('id')
      .where('id', 'in', [heldLink, freeLink] as any)
      .execute();
    const remainingIds = remaining.map((r) => String(r.id));
    expect(remainingIds).toContain(heldLink);
    expect(remainingIds).not.toContain(freeLink);
  });
});

describe('previously unbounded tables now age out', () => {
  it('purges old message metadata rows but keeps recent ones', async () => {
    const { customerId } = await seedCustomer();
    const oldMsg = await seedOldMessage(customerId, { daysAgo: 400, status: 'delivered' });
    const recentMsg = await seedOldMessage(customerId, { daysAgo: 5, status: 'delivered' });

    const result = await runRetention({ messageRetentionDays: 395 });

    expect(await getMessageRow(oldMsg)).toBeNull();
    expect(await getMessageRow(recentMsg)).not.toBeNull();
    expect(result.messages_purged).toBeGreaterThanOrEqual(1);
  });

  it('does not purge old non-terminal message rows', async () => {
    const { customerId } = await seedCustomer();
    const queuedMsg = await seedOldMessage(customerId, { daysAgo: 400, status: 'queued' });

    await runRetention({ messageRetentionDays: 395 });

    expect(await getMessageRow(queuedMsg)).not.toBeNull();
  });

  it('purges old webhook delivery log rows but keeps recent ones', async () => {
    const { customerId } = await seedCustomer();
    const oldRow = await seedOldWebhookDelivery(customerId, 60);
    const recentRow = await seedOldWebhookDelivery(customerId, 5);

    const result = await runRetention({ webhookLogRetentionDays: 30 });

    const remaining = await db
      .selectFrom('webhook_delivery_log')
      .select('id')
      .where('id', 'in', [oldRow.logId, recentRow.logId] as any)
      .execute();
    const ids = remaining.map((r) => Number(r.id));
    expect(ids).not.toContain(oldRow.logId);
    expect(ids).toContain(recentRow.logId);
    expect(result.webhook_log_purged).toBeGreaterThanOrEqual(1);
  });

  it('purges old blocklist checks', async () => {
    const oldId = await seedOldBlocklistCheck(200);
    const recentId = await seedOldBlocklistCheck(5);

    const result = await runRetention({ blocklistRetentionDays: 180 });

    const remaining = await db
      .selectFrom('blocklist_checks')
      .select('id')
      .where('id', 'in', [oldId, recentId] as any)
      .execute();
    const ids = remaining.map((r) => Number(r.id));
    expect(ids).not.toContain(oldId);
    expect(ids).toContain(recentId);
    expect(result.blocklist_checks_purged).toBeGreaterThanOrEqual(1);
  });

  it('drains more rows than one batch (batched delete loop)', async () => {
    const { customerId } = await seedCustomer();
    const msgId = await seedOldMessage(customerId, { daysAgo: 100, status: 'delivered' });
    for (let i = 0; i < 7; i++) await seedOldEvent(customerId, msgId, 'opened', 100);

    // batchSize far below the row count forces multiple drain iterations.
    const result = await runRetention({ eventRetentionDays: 90, batchSize: 2 });

    expect(await getEventTypes(msgId)).toEqual([]);
    expect(result.events_purged).toBeGreaterThanOrEqual(7);
  });
});
