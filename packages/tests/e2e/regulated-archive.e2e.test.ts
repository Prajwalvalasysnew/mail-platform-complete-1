import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  db, resetRegulatedArchiveProvider, setRegulatedArchiveProvider,
  type ArchiveCommunication,
} from '@platform/shared';
import { buildTestApp, seedCustomer, seedVerifiedDomain } from './harness.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterEach(() => resetRegulatedArchiveProvider());
afterAll(async () => { await app.close(); });
const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function tenant() {
  const value = await seedCustomer({ tier: 'enterprise', scopes: ['send', 'messages'] });
  const domain = await seedVerifiedDomain(value.customerId);
  await db.updateTable('customers').set({ physical_address: '1 Archive Way, Test City' })
    .where('id', '=', value.customerId).execute();
  await db.insertInto('regulated_workload_posture').values({
    customer_id: value.customerId, mode: 'sec_finra', status: 'active', prerequisites: {},
    activated_at: new Date(), reviewed_at: new Date(), reviewed_by: 'independent-reviewer',
  }).execute();
  return { ...value, domain };
}

describe('SEC/FINRA specialist communications archive', () => {
  it('archives first and stores an integrity receipt before accepting delivery', async () => {
    const value = await tenant();
    const captured: ArchiveCommunication[] = [];
    setRegulatedArchiveProvider({
      async archive(record) {
        captured.push(record);
        return {
          provider: 'specialist-archive.example', externalId: `receipt-${record.messageId}`,
          archivedAt: new Date().toISOString(),
          immutableUntil: new Date(Date.now() + 6 * 365 * 86400_000).toISOString(),
          contentSha256: 'a'.repeat(64),
        };
      },
    });
    const response = await app.inject({
      method: 'POST', url: '/v1/send', headers: headers(value.apiKey),
      payload: {
        from: `broker@${value.domain}`, to: 'client@example.com',
        subject: 'Trade confirmation', text: 'Client account number appears on this trade confirmation.',
      },
    });
    expect(response.statusCode).toBe(202);
    expect(captured).toHaveLength(1);
    const receipt = await db.selectFrom('regulated_archive_records').selectAll()
      .where('message_id', '=', response.json().message_ids[0]).executeTakeFirstOrThrow();
    expect(receipt.reconciliation_status).toBe('verified');
    expect(receipt.external_id).toContain(response.json().message_ids[0]);
    const list = await app.inject({
      method: 'GET', url: '/v1/compliance/archive-records',
      headers: { authorization: `Bearer ${value.apiKey}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().records[0].content_sha256).toBe('a'.repeat(64));
  });

  it('fails closed with zero stored messages when the archive is unavailable', async () => {
    const value = await tenant();
    setRegulatedArchiveProvider({ async archive() { throw new Error('provider unavailable'); } });
    const response = await app.inject({
      method: 'POST', url: '/v1/send', headers: headers(value.apiKey),
      payload: {
        from: `broker@${value.domain}`, to: 'client@example.com',
        subject: 'Ordinary correspondence', text: 'Please call us tomorrow.',
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('regulated_archive_unavailable');
    const count = await db.selectFrom('messages').select(db.fn.countAll().as('count'))
      .where('customer_id', '=', value.customerId).executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(0);
  });
});
