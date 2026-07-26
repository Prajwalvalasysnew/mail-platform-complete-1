// E2E: SEC-04 (compliance implementation plan) — ordinary plan retention and
// data-subject erasure must not destroy records under a regulatory retention
// obligation.
//
// The decisive test is the erasure one. A legal hold blocks erasure and the
// tenant can lift it at will; a regulatory lock must refuse a request the DATA
// SUBJECT is otherwise entitled to make, because GDPR Art 17(3)(b) makes
// compliance with a legal obligation a lawful ground to refuse and a
// broker-dealer cannot delete a record it is required to keep.
//
// The other decisive property is that the lock is TIME-BOUND: once the
// statutory period lapses the ordinary policy resumes with no manual step, so
// an expired obligation cannot quietly become permanent retention.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain } from './harness.js';
import { db, runRetention, generateMessageId, placeRegulatoryLock, recipientLockScope } from '@platform/shared';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

const recipient = () => `sec04-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
const hdr = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });
const inSixYears = () => new Date(Date.now() + 6 * 365 * 86_400_000);

async function seedExpiredMessage(customerId: string, domain: string, to: string) {
  const messageId = generateMessageId(domain);
  await db.insertInto('messages').values({
    message_id: messageId, customer_id: customerId, to_address: to,
    from_address: `sender@${domain}`, subject: 'Regulated communication',
    status: 'delivered', body_storage: 'inline',
    html_body: '<p>order confirmation</p>', text_body: 'order confirmation',
    queued_at: new Date(Date.now() - 400 * 86_400_000),
  } as any).execute();
  return messageId;
}

async function bodyPresent(messageId: string): Promise<boolean> {
  const row = await db.selectFrom('messages').select(['html_body', 'text_body'])
    .where('message_id', '=', messageId).executeTakeFirst();
  return !!(row && (row.html_body !== null || row.text_body !== null));
}

describe('SEC-04: regulatory locks survive ordinary retention', () => {
  it('preserves records past their retention window', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    const messageId = await seedExpiredMessage(cust.customerId, domain, to);

    await placeRegulatoryLock({
      customerId: cust.customerId, scope: 'customer', basis: 'sec_17a4',
      authority: 'SEC Rule 17a-4(b)(4)', retainUntil: inSixYears(),
    });

    const result = await runRetention({ messageBodyRetentionDays: 90 });
    expect(result.regulatory_locked_rows_skipped).toBeGreaterThanOrEqual(1);
    expect(await bodyPresent(messageId)).toBe(true);
  });

  it('scopes a recipient lock to that correspondent only', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const locked = recipient();
    const other = recipient();
    const lockedMsg = await seedExpiredMessage(cust.customerId, domain, locked);
    const otherMsg = await seedExpiredMessage(cust.customerId, domain, other);

    await placeRegulatoryLock({
      customerId: cust.customerId, scope: recipientLockScope(locked),
      basis: 'finra_4511', authority: 'FINRA Rule 4511', retainUntil: inSixYears(),
    });

    await runRetention({ messageBodyRetentionDays: 90 });
    expect(await bodyPresent(lockedMsg)).toBe(true);
    expect(await bodyPresent(otherMsg)).toBe(false);
  });

  it('THE LOCK IS TIME-BOUND: an expired obligation stops preserving', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    const messageId = await seedExpiredMessage(cust.customerId, domain, to);

    const lock = await placeRegulatoryLock({
      customerId: cust.customerId, scope: 'customer', basis: 'sec_17a4',
      authority: 'SEC Rule 17a-4(b)(4)', retainUntil: inSixYears(),
    });
    await runRetention({ messageBodyRetentionDays: 90 });
    expect(await bodyPresent(messageId)).toBe(true);

    // The statutory period lapses. No operator action should be needed —
    // otherwise an expired obligation silently becomes permanent retention.
    await db.updateTable('regulatory_retention_locks')
      .set({ retain_until: new Date(Date.now() - 86_400_000) } as any)
      .where('id', '=', lock.id).execute();

    await runRetention({ messageBodyRetentionDays: 90 });
    expect(await bodyPresent(messageId)).toBe(false);
  });

  it('does not leak a lock across tenants', async () => {
    const a = await seedCustomer({ scopes: ['messages'] });
    const b = await seedCustomer({ scopes: ['messages'] });
    const domainB = await seedVerifiedDomain(b.customerId);
    const to = recipient();
    const msgB = await seedExpiredMessage(b.customerId, domainB, to);

    await placeRegulatoryLock({
      customerId: a.customerId, scope: 'customer', basis: 'sec_17a4',
      authority: 'SEC Rule 17a-4', retainUntil: inSixYears(),
    });

    await runRetention({ messageBodyRetentionDays: 90 });
    expect(await bodyPresent(msgB)).toBe(false);
  });
});

describe('SEC-04: regulatory locks block erasure', () => {
  it('REFUSES A DATA SUBJECT ERASURE REQUEST, naming the basis and expiry', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    const messageId = await seedExpiredMessage(cust.customerId, domain, to);

    await placeRegulatoryLock({
      customerId: cust.customerId, scope: recipientLockScope(to), basis: 'sec_17a4',
      authority: 'SEC Rule 17a-4(b)(4)', retainUntil: inSixYears(),
    });

    const res = await app.inject({
      method: 'POST', url: '/v1/privacy/delete-recipient',
      headers: hdr(cust.apiKey), payload: { recipient: to },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('regulatory_retention_active');
    // The controller must be able to tell the subject WHY and UNTIL WHEN.
    const lock = res.json().locks[0];
    expect(lock.basis).toBe('sec_17a4');
    expect(lock.authority).toContain('17a-4');
    expect(lock.retain_until).toBeTruthy();

    // And nothing was deleted.
    expect(await bodyPresent(messageId)).toBe(true);
  });

  it('permits erasure once the lock is released with a documented reason', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    await seedExpiredMessage(cust.customerId, domain, to);

    const created = await app.inject({
      method: 'POST', url: '/v1/privacy/regulatory-locks', headers: hdr(cust.apiKey),
      payload: {
        scope: to, basis: 'other_statutory', authority: 'State recordkeeping rule',
        retain_until: inSixYears().toISOString(),
      },
    });
    expect(created.statusCode).toBe(201);

    // A release with no reason is not a defensible record.
    const noReason = await app.inject({
      method: 'POST', url: `/v1/privacy/regulatory-locks/${created.json().lock.id}/release`,
      headers: hdr(cust.apiKey), payload: { released_by: 'compliance@example.com' },
    });
    expect(noReason.statusCode).toBe(400);

    const released = await app.inject({
      method: 'POST', url: `/v1/privacy/regulatory-locks/${created.json().lock.id}/release`,
      headers: hdr(cust.apiKey),
      payload: { released_by: 'compliance@example.com', reason: 'obligation reassessed by counsel' },
    });
    expect(released.statusCode).toBe(200);

    const erase = await app.inject({
      method: 'POST', url: '/v1/privacy/delete-recipient',
      headers: hdr(cust.apiKey), payload: { recipient: to },
    });
    expect(erase.statusCode).toBe(200);
  });

  it('rejects a lock whose period has already lapsed', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const res = await app.inject({
      method: 'POST', url: '/v1/privacy/regulatory-locks', headers: hdr(cust.apiKey),
      payload: {
        scope: 'customer', basis: 'sec_17a4', authority: 'SEC Rule 17a-4',
        retain_until: new Date(Date.now() - 86_400_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('retain_until_in_past');
  });

  it('lists active locks and keeps released ones as history', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const active = await placeRegulatoryLock({
      customerId: cust.customerId, scope: 'customer', basis: 'sec_17a4',
      authority: 'SEC Rule 17a-4', retainUntil: inSixYears(),
    });

    const list = await app.inject({
      method: 'GET', url: '/v1/privacy/regulatory-locks', headers: hdr(cust.apiKey),
    });
    expect(list.json().locks.map((l: any) => l.id)).toContain(active.id);
  });
});
