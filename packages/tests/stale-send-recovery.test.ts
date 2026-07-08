// Integration tests for:
//   1. Stale sending recovery — messages left in status='sending' after a
//      worker crash must be reset to 'queued' by the scheduler job.
//   2. CAN-SPAM physical address — PATCH /profile stores the address and
//      GET /profile returns it.
//
// These tests require a live Postgres + Redis (DATABASE_URL + REDIS_URL).

import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { db } from '@platform/shared';
import { buildTestApp, seedCustomer } from './e2e/harness.js';

describe.runIf(!!process.env.DATABASE_URL)('stale send recovery', () => {
  it('resets messages stuck in sending state older than 10 minutes to queued', async () => {
    const c = await seedCustomer();

    // Insert a message pinned at status='sending' with sending_at 15 minutes ago
    // to simulate a worker crash mid-send. sending_at is a plain timestamp (NOT
    // trigger-managed), so we can set it directly to back-date the stranding.
    const staleAt = new Date(Date.now() - 15 * 60_000);
    const msgId = `msg_stale_${Date.now()}`;
    await db.insertInto('messages').values({
      message_id: msgId,
      customer_id: c.customerId,
      from_address: 'sender@example.com',
      to_address: 'recipient@example.com',
      subject: 'Stale test',
      status: 'sending' as any,
      sending_at: staleAt as any,
    }).execute();

    // Run the recovery query (same logic as the scheduler job).
    const recovered = await db
      .updateTable('messages')
      .set({ status: 'queued', failure_reason: 'stale_sending_reset', sending_at: null })
      .where('status', '=', 'sending')
      .where((eb) =>
        eb.or([
          eb('sending_at', 'is', null),
          sql<boolean>`messages.sending_at < NOW() - INTERVAL '10 minutes'`,
        ]),
      )
      .returning(['message_id'])
      .execute();

    expect(recovered.some((r) => r.message_id === msgId)).toBe(true);

    // Confirm it's back in queued.
    const row = await db.selectFrom('messages').select('status').where('message_id', '=', msgId).executeTakeFirst();
    expect(row?.status).toBe('queued');

    // Clean up
    await db.deleteFrom('messages').where('message_id', '=', msgId).execute();
  });

  it('does not reset messages in sending state that are still within the 10-minute window', async () => {
    const c = await seedCustomer();

    const recentAt = new Date(Date.now() - 2 * 60_000); // 2 minutes ago — still within window
    const msgId = `msg_fresh_${Date.now()}`;
    await db.insertInto('messages').values({
      message_id: msgId,
      customer_id: c.customerId,
      from_address: 'sender@example.com',
      to_address: 'recipient@example.com',
      subject: 'Fresh test',
      status: 'sending' as any,
      sending_at: recentAt as any,
    }).execute();

    const recovered = await db
      .updateTable('messages')
      .set({ status: 'queued', failure_reason: 'stale_sending_reset', sending_at: null })
      .where('status', '=', 'sending')
      .where((eb) =>
        eb.or([
          eb('sending_at', 'is', null),
          sql<boolean>`messages.sending_at < NOW() - INTERVAL '10 minutes'`,
        ]),
      )
      .returning(['message_id'])
      .execute();

    expect(recovered.some((r) => r.message_id === msgId)).toBe(false);

    const row = await db.selectFrom('messages').select('status').where('message_id', '=', msgId).executeTakeFirst();
    expect(row?.status).toBe('sending'); // unchanged

    await db.deleteFrom('messages').where('message_id', '=', msgId).execute();
  });
});

describe.runIf(!!process.env.DATABASE_URL)('CAN-SPAM physical address', () => {
  it('PATCH /v1/profile stores a physical address and GET /v1/profile returns it', async () => {
    const app = await buildTestApp();
    const c = await seedCustomer();

    const address = '123 Main St, Springfield, IL 62701, USA';

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/v1/profile',
      headers: { authorization: `Bearer ${c.apiKey}` },
      payload: { physical_address: address },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json()).toEqual({ ok: true });

    const getRes = await app.inject({
      method: 'GET',
      url: '/v1/profile',
      headers: { authorization: `Bearer ${c.apiKey}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().customer.physical_address).toBe(address);

    await app.close();
  });

  it('PATCH /v1/profile can clear the physical address', async () => {
    const app = await buildTestApp();
    const c = await seedCustomer();

    // First set it
    await app.inject({
      method: 'PATCH',
      url: '/v1/profile',
      headers: { authorization: `Bearer ${c.apiKey}` },
      payload: { physical_address: '1 Test Lane, Boston, MA 02101' },
    });

    // Then clear it
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/v1/profile',
      headers: { authorization: `Bearer ${c.apiKey}` },
      payload: { physical_address: null },
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes = await app.inject({
      method: 'GET',
      url: '/v1/profile',
      headers: { authorization: `Bearer ${c.apiKey}` },
    });
    expect(getRes.json().customer.physical_address).toBeNull();

    await app.close();
  });
});
