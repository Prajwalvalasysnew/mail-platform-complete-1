// Phase 2.2 (docs/DATABASE_10_10_PLAN.md): self-serve data exports.
//
// The worker execution path (runDataExport) is invoked directly, mirroring how
// retention tests call runRetention — queue delivery itself is BullMQ plumbing
// covered elsewhere.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer } from './harness.js';
import {
  db,
  runDataExport,
  runRetention,
  clearRetentionPolicyCache,
  seedOldMessage,
  seedOldEvent,
} from '@platform/shared';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

async function createExport(apiKey: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/exports',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    payload: body,
  });
}

describe('self-serve data exports', () => {
  it('exports events as NDJSON end-to-end (create → run → download)', async () => {
    const seeded = await seedCustomer();
    const msg = await seedOldMessage(seeded.customerId, { daysAgo: 5, status: 'delivered' });
    await seedOldEvent(seeded.customerId, msg, 'delivered', 5);
    await seedOldEvent(seeded.customerId, msg, 'opened', 4);

    const created = await createExport(seeded.apiKey, { kind: 'events', from: iso(10), to: iso(0) });
    expect(created.statusCode).toBe(202);
    const exportId = created.json().export.id;
    expect(created.json().export.status).toBe('pending');

    const result = await runDataExport(exportId);
    expect(result?.status).toBe('completed');
    expect(result?.row_count).toBeGreaterThanOrEqual(2);

    const download = await app.inject({
      method: 'GET',
      url: `/v1/exports/${exportId}/download`,
      headers: { authorization: `Bearer ${seeded.apiKey}` },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/x-ndjson');
    const lines = download.body.trim().split('\n').map((l) => JSON.parse(l));
    const forMsg = lines.filter((l) => l.message_id === msg);
    expect(forMsg.map((l) => l.event_type).sort()).toEqual(['delivered', 'opened']);
  });

  it('exports message metadata without bodies', async () => {
    const seeded = await seedCustomer();
    const msg = await seedOldMessage(seeded.customerId, {
      daysAgo: 3, status: 'delivered', htmlBody: '<p>secret body</p>',
    });

    const created = await createExport(seeded.apiKey, { kind: 'messages', from: iso(10), to: iso(0) });
    const exportId = created.json().export.id;
    const result = await runDataExport(exportId);
    expect(result?.status).toBe('completed');

    const download = await app.inject({
      method: 'GET',
      url: `/v1/exports/${exportId}/download`,
      headers: { authorization: `Bearer ${seeded.apiKey}` },
    });
    const lines = download.body.trim().split('\n').map((l) => JSON.parse(l));
    const row = lines.find((l) => l.message_id === msg);
    expect(row).toBeDefined();
    expect(row.subject).toBe('old message seed');
    expect(download.body).not.toContain('secret body');
  });

  it('is tenant-isolated: exports never include another customer\'s data, or their listings', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    const msgB = await seedOldMessage(b.customerId, { daysAgo: 2, status: 'delivered' });
    await seedOldEvent(b.customerId, msgB, 'delivered', 2);

    const created = await createExport(a.apiKey, { kind: 'events', from: iso(10), to: iso(0) });
    const exportId = created.json().export.id;
    const result = await runDataExport(exportId);
    expect(result?.status).toBe('completed');

    const download = await app.inject({
      method: 'GET',
      url: `/v1/exports/${exportId}/download`,
      headers: { authorization: `Bearer ${a.apiKey}` },
    });
    expect(download.body).not.toContain(msgB);

    // Customer B cannot see or download A's export.
    const crossGet = await app.inject({
      method: 'GET',
      url: `/v1/exports/${exportId}`,
      headers: { authorization: `Bearer ${b.apiKey}` },
    });
    expect(crossGet.statusCode).toBe(404);
    const crossDl = await app.inject({
      method: 'GET',
      url: `/v1/exports/${exportId}/download`,
      headers: { authorization: `Bearer ${b.apiKey}` },
    });
    expect(crossDl.statusCode).toBe(404);
  });

  it('rejects invalid ranges and clamps to the plan retention window', async () => {
    const seeded = await seedCustomer();

    const backwards = await createExport(seeded.apiKey, { kind: 'events', from: iso(0), to: iso(5) });
    expect(backwards.statusCode).toBe(400);

    const tooLarge = await createExport(seeded.apiKey, { kind: 'events', from: iso(400), to: iso(0) });
    expect(tooLarge.statusCode).toBe(400);

    // Tenant with a 7-day plan window: a range fully outside it is rejected.
    await db.updateTable('customers')
      .set({ events_retention_days: 7 } as any)
      .where('id', '=', seeded.customerId)
      .execute();
    clearRetentionPolicyCache();
    const outside = await createExport(seeded.apiKey, { kind: 'events', from: iso(40), to: iso(20) });
    expect(outside.statusCode).toBe(400);
    expect(outside.json().message).toContain('retention window');
  });

  it('download of an unfinished export returns 409; expired exports purge via retention', async () => {
    const seeded = await seedCustomer();
    const created = await createExport(seeded.apiKey, { kind: 'events', from: iso(5), to: iso(0) });
    const exportId = created.json().export.id;

    const early = await app.inject({
      method: 'GET',
      url: `/v1/exports/${exportId}/download`,
      headers: { authorization: `Bearer ${seeded.apiKey}` },
    });
    expect(early.statusCode).toBe(409);

    await runDataExport(exportId);
    // Backdate and purge.
    await db.updateTable('data_exports')
      .set({ created_at: new Date(Date.now() - 30 * 86_400_000) as any })
      .where('id', '=', exportId)
      .execute();
    const result = await runRetention({ exportRetentionDays: 7 });
    expect(result.exports_purged).toBeGreaterThanOrEqual(1);

    const gone = await app.inject({
      method: 'GET',
      url: `/v1/exports/${exportId}`,
      headers: { authorization: `Bearer ${seeded.apiKey}` },
    });
    expect(gone.statusCode).toBe(404);
  });
});
