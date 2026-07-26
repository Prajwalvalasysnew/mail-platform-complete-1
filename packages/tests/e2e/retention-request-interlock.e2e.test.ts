// E2E: FERPA-07 (compliance implementation plan) — no destruction while an
// eligible access request is outstanding.
//
// The failure this prevents: a data subject asks for their records, and the
// retention sweep deletes them while the request is still in flight. The
// controller then has to answer a statutory request with data it destroyed
// AFTER receiving the request. FERPA says this explicitly; the same reasoning
// applies to GDPR Art 15 access and portability.
//
// The load-bearing negative test is the erasure one: an open ERASURE request
// must NOT pin, because deletion is the outcome the subject asked for.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain } from './harness.js';
import { db, runRetention, generateMessageId, createPrivacyCase, transitionPrivacyCase } from '@platform/shared';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

const recipient = () => `interlock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

/** A terminal message old enough that the retention sweep would purge it. */
async function seedExpiredMessage(customerId: string, domain: string, to: string) {
  const messageId = generateMessageId(domain);
  await db.insertInto('messages').values({
    message_id: messageId,
    customer_id: customerId,
    to_address: to,
    from_address: `sender@${domain}`,
    subject: 'Old record',
    status: 'delivered',
    body_storage: 'inline',
    html_body: '<p>records</p>',
    text_body: 'records',
    queued_at: new Date(Date.now() - 400 * 86_400_000),
  } as any).execute();
  return messageId;
}

async function bodyStillPresent(messageId: string): Promise<boolean> {
  const row = await db.selectFrom('messages').select(['html_body', 'text_body'])
    .where('message_id', '=', messageId).executeTakeFirst();
  return !!(row && (row.html_body !== null || row.text_body !== null));
}

async function openCase(customerId: string, subject: string, types: string[]) {
  return createPrivacyCase({
    customerId,
    subjectKind: 'recipient',
    subjectIdentifier: subject,
    intakeSource: 'api',
    requestTypes: types as never,
    jurisdiction: 'gdpr',
    createdBy: 'e2e',
  }, db);
}

describe('FERPA-07: an open access request pins the data it covers', () => {
  it('does not purge bodies while an access request is open', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    const messageId = await seedExpiredMessage(cust.customerId, domain, to);

    await openCase(cust.customerId, to, ['access']);

    const result = await runRetention({ messageBodyRetentionDays: 90 });
    expect(result.request_pinned_rows_skipped).toBeGreaterThanOrEqual(1);
    expect(await bodyStillPresent(messageId)).toBe(true);
  });

  it('pins for portability and rectification requests too', async () => {
    for (const type of ['portability', 'rectification']) {
      const cust = await seedCustomer({ scopes: ['messages'] });
      const domain = await seedVerifiedDomain(cust.customerId);
      const to = recipient();
      const messageId = await seedExpiredMessage(cust.customerId, domain, to);

      await openCase(cust.customerId, to, [type]);
      await runRetention({ messageBodyRetentionDays: 90 });
      expect(await bodyStillPresent(messageId), type).toBe(true);
    }
  });

  it('AN OPEN ERASURE REQUEST DOES NOT PIN — deletion is what was asked for', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    const messageId = await seedExpiredMessage(cust.customerId, domain, to);

    await openCase(cust.customerId, to, ['erasure']);

    await runRetention({ messageBodyRetentionDays: 90 });
    // Letting the sweep get there first FULFILS the request rather than
    // frustrating it. Pinning here would also be self-defeating: the case
    // could never complete through the ordinary lifecycle.
    expect(await bodyStillPresent(messageId)).toBe(false);
  });

  it('releases the pin once the case is fulfilled', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    const messageId = await seedExpiredMessage(cust.customerId, domain, to);

    const row = await openCase(cust.customerId, to, ['access']);
    await runRetention({ messageBodyRetentionDays: 90 });
    expect(await bodyStillPresent(messageId)).toBe(true);

    // Walk the real lifecycle: the state machine has no shortcut to
    // 'fulfilled', and fulfilment requires verified identity.
    await db.updateTable('privacy_cases')
      .set({ identity_verified_at: new Date() } as any)
      .where('id', '=', row.id).execute();
    await transitionPrivacyCase(cust.customerId, row.id, 'in_progress', { actor: 'e2e' }, db);
    await transitionPrivacyCase(cust.customerId, row.id, 'fulfilled', { actor: 'e2e' }, db);

    await runRetention({ messageBodyRetentionDays: 90 });
    expect(await bodyStillPresent(messageId)).toBe(false);
  });

  it('a closed or denied case does not pin', async () => {
    for (const finalStatus of ['denied', 'closed'] as const) {
      const cust = await seedCustomer({ scopes: ['messages'] });
      const domain = await seedVerifiedDomain(cust.customerId);
      const to = recipient();
      const messageId = await seedExpiredMessage(cust.customerId, domain, to);

      const row = await openCase(cust.customerId, to, ['access']);
      await db.updateTable('privacy_cases').set({ status: finalStatus } as any)
        .where('id', '=', row.id).execute();

      await runRetention({ messageBodyRetentionDays: 90 });
      expect(await bodyStillPresent(messageId), finalStatus).toBe(false);
    }
  });

  it('pins only the subject of the request, not the whole tenant', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const subject = recipient();
    const bystander = recipient();
    const subjectMsg = await seedExpiredMessage(cust.customerId, domain, subject);
    const bystanderMsg = await seedExpiredMessage(cust.customerId, domain, bystander);

    await openCase(cust.customerId, subject, ['access']);
    await runRetention({ messageBodyRetentionDays: 90 });

    expect(await bodyStillPresent(subjectMsg)).toBe(true);
    // An access request is not a tenant-wide freeze — over-preserving would
    // quietly defeat the retention policy for everyone else.
    expect(await bodyStillPresent(bystanderMsg)).toBe(false);
  });

  it('does not pin across tenants sharing a recipient address', async () => {
    const a = await seedCustomer({ scopes: ['messages'] });
    const b = await seedCustomer({ scopes: ['messages'] });
    const domainA = await seedVerifiedDomain(a.customerId);
    const domainB = await seedVerifiedDomain(b.customerId);
    const shared = recipient();

    const msgA = await seedExpiredMessage(a.customerId, domainA, shared);
    const msgB = await seedExpiredMessage(b.customerId, domainB, shared);

    await openCase(a.customerId, shared, ['access']);
    await runRetention({ messageBodyRetentionDays: 90 });

    expect(await bodyStillPresent(msgA)).toBe(true);
    expect(await bodyStillPresent(msgB)).toBe(false);
  });

  it('matches the subject case-insensitively', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    const messageId = await seedExpiredMessage(cust.customerId, domain, to);

    await openCase(cust.customerId, to.toUpperCase(), ['access']);
    await runRetention({ messageBodyRetentionDays: 90 });
    expect(await bodyStillPresent(messageId)).toBe(true);
  });
});
