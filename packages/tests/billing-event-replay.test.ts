// DB integration tests for billing event replay tooling (gap analysis 2.3.2:
// "Add billing event replay admin tool"). Covers: raw payload is persisted on
// ingest, events are listable, a stored event is fetchable with its payload,
// replay bookkeeping increments, and events without a payload (pre-migration
// rows) are correctly reported as not replayable.

import { describe, it, expect } from 'vitest';
import {
  applySubscriptionState,
  listBillingEvents,
  getBillingEvent,
  replayBillingEvent,
  seedCustomer,
  db,
} from '@platform/shared';

const evId = (p: string) => `evt_${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

describe('billing event replay tooling', () => {
  it('persists the raw payload on ingest so the event is replayable', async () => {
    const c = await seedCustomer();
    // Give the customer a provider customer id the event can resolve against.
    await db.updateTable('customers')
      .set({ stripe_customer_id: `cus_${c.customerId.slice(0, 8)}`, billing_provider: 'stripe' })
      .where('id', '=', c.customerId).execute();

    const id = evId('paid');
    const rawPayload = { id, type: 'customer.subscription.updated', foo: 'bar' };
    await applySubscriptionState({
      type: 'customer.subscription.updated',
      provider: 'stripe',
      provider_event_id: id,
      provider_customer_id: `cus_${c.customerId.slice(0, 8)}`,
      status: 'active',
      raw_payload: rawPayload,
    });

    const stored = await getBillingEvent(id);
    expect(stored).not.toBeNull();
    expect(stored!.replayable).toBe(true);
    expect(stored!.provider).toBe('stripe');
    expect(stored!.payload).toMatchObject({ foo: 'bar' });
  });

  it('lists events newest-first and marks payloadless events not replayable', async () => {
    // Insert a legacy-style row with no payload directly.
    const legacyId = evId('legacy');
    await db.insertInto('billing_events')
      .values({ provider_event_id: legacyId, type: 'legacy.event' })
      .execute();

    const events = await listBillingEvents({ limit: 100 });
    const legacy = events.find((e) => e.provider_event_id === legacyId);
    expect(legacy).toBeTruthy();
    expect(legacy!.replayable).toBe(false);
  });

  it('replay bookkeeping increments replay_count and sets replayed_at', async () => {
    const id = evId('replayme');
    await db.insertInto('billing_events')
      .values({ provider_event_id: id, type: 'customer.subscription.updated', provider: 'stripe', payload: { id, ok: true } as any })
      .execute();

    const before = await getBillingEvent(id);
    expect(before!.replay_count).toBe(0);
    expect(before!.replayed_at).toBeNull();

    const res = await replayBillingEvent(id);
    expect(res.status).toBe('replayed');

    const after = await getBillingEvent(id);
    expect(after!.replay_count).toBe(1);
    expect(after!.replayed_at).not.toBeNull();
  });

  it('replay of a non-existent event returns not_found', async () => {
    const res = await replayBillingEvent('evt_does_not_exist');
    expect(res.status).toBe('not_found');
  });

  it('replay of a payloadless event returns not_replayable', async () => {
    const id = evId('nopayload');
    await db.insertInto('billing_events').values({ provider_event_id: id, type: 'x.y' }).execute();
    const res = await replayBillingEvent(id);
    expect(res.status).toBe('not_replayable');
  });
});
