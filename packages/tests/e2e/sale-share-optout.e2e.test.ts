// E2E: CCPA-04 (opt-out of sale/sharing, Global Privacy Control) and
// CANSPAM-09 (no sale or transfer of opted-out addresses).
//
// The load-bearing distinction: a sale/share opt-out is NOT an unsubscribe.
// A consumer may want to keep receiving mail while refusing to be sold, so
// recording one must not silently stop delivery. Over-enforcing here would be
// as wrong as ignoring the signal.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { app as tracker } from '@platform/tracker/app';
import { buildTestApp, seedCustomer, seedVerifiedDomain } from './harness.js';
import {
  db,
  isGpcSignal,
  hasSaleShareOptOut,
  isSuppressed,
  addSuppression,
  encodeMessageIdForUrl,
  generateMessageId,
  resolveTransferPurpose,
  ProhibitedTransferError,
} from '@platform/shared';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); await tracker.ready(); });
afterAll(async () => { await app.close(); await tracker.close(); });

const recipient = () => `sale-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
const hdr = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });

async function seedMessage(customerId: string, domain: string, to: string) {
  const messageId = generateMessageId(domain);
  await db.insertInto('messages').values({
    message_id: messageId, customer_id: customerId, to_address: to,
    from_address: `sender@${domain}`, subject: 'promo', status: 'delivered',
    body_storage: 'inline',
  } as any).execute();
  return { messageId, encoded: encodeMessageIdForUrl(messageId) };
}

describe('isGpcSignal', () => {
  it('accepts only the single truthy value the spec defines', () => {
    expect(isGpcSignal({ 'sec-gpc': '1' })).toBe(true);
    expect(isGpcSignal({ 'Sec-GPC': '1' })).toBe(true);
  });

  it('treats "0" as NOT a signal — honouring it would be as wrong as ignoring "1"', () => {
    expect(isGpcSignal({ 'sec-gpc': '0' })).toBe(false);
    expect(isGpcSignal({ 'sec-gpc': 'true' })).toBe(false);
    expect(isGpcSignal({ 'sec-gpc': '' })).toBe(false);
    expect(isGpcSignal({})).toBe(false);
    expect(isGpcSignal(undefined)).toBe(false);
  });
});

describe('CCPA-04: Global Privacy Control at recipient-facing surfaces', () => {
  it('records an opt-out from a GPC header on the unsubscribe page', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    const { encoded } = await seedMessage(cust.customerId, domain, to);

    const res = await tracker.inject({
      method: 'GET', url: `/u/${encoded}`, headers: { 'sec-gpc': '1' },
    });

    expect(res.statusCode).toBe(200);
    expect(await hasSaleShareOptOut(cust.customerId, to)).toBe(true);
  });

  it('records an opt-out from a GPC header on a tracked click', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    const { messageId, encoded } = await seedMessage(cust.customerId, domain, to);

    const link = await db.insertInto('tracked_links').values({
      message_id: messageId, original_url: 'https://example.com/promo',
    } as any).returning('id').executeTakeFirstOrThrow();

    const res = await tracker.inject({
      method: 'GET', url: `/c/${encoded}/${link.id}`, headers: { 'sec-gpc': '1' },
    });

    // The redirect still happens — the recipient is entitled to reach the page.
    expect(res.statusCode).toBe(302);
    expect(await hasSaleShareOptOut(cust.customerId, to)).toBe(true);
  });

  it('does NOT record anything without the signal', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    const { encoded } = await seedMessage(cust.customerId, domain, to);

    await tracker.inject({ method: 'GET', url: `/u/${encoded}` });
    await tracker.inject({ method: 'GET', url: `/u/${encoded}`, headers: { 'sec-gpc': '0' } });

    expect(await hasSaleShareOptOut(cust.customerId, to)).toBe(false);
  });

  it('is idempotent — a consenting browser sends GPC on every request', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    const { encoded } = await seedMessage(cust.customerId, domain, to);

    for (let i = 0; i < 3; i++) {
      await tracker.inject({ method: 'GET', url: `/u/${encoded}`, headers: { 'sec-gpc': '1' } });
    }

    const rows = await db.selectFrom('sale_share_optouts').select('id')
      .where('customer_id', '=', cust.customerId).where('email', '=', to).execute();
    expect(rows).toHaveLength(1);
  });

  it('A SALE OPT-OUT IS NOT AN UNSUBSCRIBE: delivery continues', async () => {
    const cust = await seedCustomer({ scopes: ['messages', 'send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    const { encoded } = await seedMessage(cust.customerId, domain, to);

    await tracker.inject({ method: 'GET', url: `/u/${encoded}`, headers: { 'sec-gpc': '1' } });
    expect(await hasSaleShareOptOut(cust.customerId, to)).toBe(true);

    // The consumer refused to be SOLD, not to be emailed. Silently
    // unsubscribing them would be over-enforcement.
    expect(await isSuppressed(cust.customerId, to)).toBe(false);
    const send = await app.inject({
      method: 'POST', url: '/v1/send', headers: hdr(cust.apiKey),
      payload: { from: `s@${domain}`, to, subject: 'still allowed', text: 'x' },
    });
    expect(send.statusCode).toBe(202);
  });
});

describe('CCPA-04: submitted opt-out requests', () => {
  it('records and lists a submitted opt-out', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const to = recipient();

    const res = await app.inject({
      method: 'POST', url: '/v1/privacy/opt-out-sale', headers: hdr(cust.apiKey),
      payload: { recipient: to, source: 'authorized_agent' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().newly_recorded).toBe(true);

    const again = await app.inject({
      method: 'POST', url: '/v1/privacy/opt-out-sale', headers: hdr(cust.apiKey),
      payload: { recipient: to },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().newly_recorded).toBe(false);

    const list = await app.inject({
      method: 'GET', url: '/v1/privacy/sale-share-optouts', headers: hdr(cust.apiKey),
    });
    const entry = list.json().optouts.find((o: any) => o.email === to);
    expect(entry.source).toBe('authorized_agent');
  });

  it('does not leak opt-outs across tenants', async () => {
    const a = await seedCustomer({ scopes: ['messages'] });
    const b = await seedCustomer({ scopes: ['messages'] });
    const to = recipient();
    await app.inject({
      method: 'POST', url: '/v1/privacy/opt-out-sale', headers: hdr(a.apiKey), payload: { recipient: to },
    });

    expect(await hasSaleShareOptOut(b.customerId, to)).toBe(false);
    const list = await app.inject({
      method: 'GET', url: '/v1/privacy/sale-share-optouts', headers: hdr(b.apiKey),
    });
    expect(list.json().optouts).toHaveLength(0);
  });
});

describe('CANSPAM-09: transfer of opted-out addresses', () => {
  it('permits the lawful purposes and refuses anything else', () => {
    expect(resolveTransferPurpose(undefined)).toBe('compliance');
    expect(resolveTransferPurpose('provider_transfer')).toBe('provider_transfer');
    expect(resolveTransferPurpose('migration')).toBe('migration');
    expect(() => resolveTransferPurpose('sale')).toThrow(ProhibitedTransferError);
    expect(() => resolveTransferPurpose('list_rental')).toThrow(ProhibitedTransferError);
  });

  it('exports the suppression list under a declared purpose and records it', async () => {
    const cust = await seedCustomer({ scopes: ['suppressions'] });
    const to = recipient();
    await addSuppression(cust.customerId, to, 'unsubscribe', 'opted out');

    const res = await app.inject({
      method: 'GET', url: '/v1/suppressions/export?purpose=provider_transfer',
      headers: { authorization: `Bearer ${cust.apiKey}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-transfer-purpose']).toBe('provider_transfer');
    expect(res.body).toContain(to);

    // The declaration is the accountability record that makes §5(a)(4)
    // enforceable against the account that made the transfer.
    const audit = await db.selectFrom('audit_log').select(['resource', 'metadata'])
      .where('customer_id', '=', cust.customerId)
      .where('action', '=', 'suppression_list_exported')
      .executeTakeFirstOrThrow();
    expect(audit.resource).toBe('provider_transfer');
    expect((audit.metadata as any).rows).toBeGreaterThanOrEqual(1);
  });

  it('refuses an export declared for sale', async () => {
    const cust = await seedCustomer({ scopes: ['suppressions'] });
    await addSuppression(cust.customerId, recipient(), 'unsubscribe', 'opted out');

    const res = await app.inject({
      method: 'GET', url: '/v1/suppressions/export?purpose=sale',
      headers: { authorization: `Bearer ${cust.apiKey}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('transfer_purpose_prohibited');
    expect(res.json().message).toContain('5(a)(4)');
  });

  it('still works without a declared purpose, defaulting to own compliance use', async () => {
    // Breaking existing integrations would push people to scrape the list
    // endpoint instead — the same transfer with no record at all.
    const cust = await seedCustomer({ scopes: ['suppressions'] });
    await addSuppression(cust.customerId, recipient(), 'unsubscribe', 'opted out');

    const res = await app.inject({
      method: 'GET', url: '/v1/suppressions/export',
      headers: { authorization: `Bearer ${cust.apiKey}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-transfer-purpose']).toBe('compliance');
  });
});
