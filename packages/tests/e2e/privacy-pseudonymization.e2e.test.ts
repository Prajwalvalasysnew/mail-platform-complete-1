// BASE-02 / BASE-03 (compliance implementation plan) regression coverage.
//
// BASE-03: GDPR/CCPA erasure must not leave the recipient's plaintext email in
// consent_events (consent ledger), deletion_requests (erasure evidence), or
// unsubscribe_group_members — those survive erasure and previously retained
// the direct identifier forever. They must instead hold a keyed pseudonym
// ('erased:<hex>') or be deleted.
//
// BASE-02: the right-to-access export must return every recipient-linked
// record class: consent history, unsubscribe-group memberships, tracked
// links, workflow runs, soft-bounce state, and retained erasure evidence.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain } from './harness.js';
import { db, erasedRecipientPseudonym } from '@platform/shared';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

async function seedRecipientFootprint(customerId: string, email: string) {
  // Consent ledger entry + group membership + soft-bounce state, the record
  // classes erasure previously missed and export previously omitted.
  await db.insertInto('consent_events').values({
    customer_id: customerId, email, action: 'suppress', reason: 'unsubscribe',
    source: 'one_click_unsubscribe', notes: `unsubscribed by ${email}`, message_id: null,
  }).execute();
  // A real one-click unsub writes ledger + suppression together; keep the
  // fixture consistent so the CAN-SPAM SLA scan sees an honored opt-out.
  await db.insertInto('suppressions').values({
    customer_id: customerId, email, reason: 'unsubscribe', notes: null,
  }).onConflict((oc) => oc.columns(['customer_id', 'email']).doNothing()).execute();
  const group = await db.insertInto('unsubscribe_groups')
    .values({ customer_id: customerId, name: 'Newsletter' })
    .returning('id').executeTakeFirstOrThrow();
  await db.insertInto('unsubscribe_group_members')
    .values({ group_id: group.id, customer_id: customerId, email }).execute();
  await db.insertInto('soft_bounce_tracker')
    .values({ customer_id: customerId, email, count: 2 })
    .onConflict((oc) => oc.columns(['customer_id', 'email']).doNothing()).execute();
  return group.id;
}

describe('privacy export completeness and erasure pseudonymization', () => {
  it('export returns consent history, group memberships, soft-bounce and erasure evidence', async () => {
    const cust = await seedCustomer({ scopes: ['send', 'messages'] });
    const victim = `export-full-${Date.now()}@example.com`;
    await seedRecipientFootprint(cust.customerId, victim);

    const res = await app.inject({
      method: 'GET', url: `/v1/privacy/export-recipient?email=${encodeURIComponent(victim)}`,
      headers: { authorization: `Bearer ${cust.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.consent_history.length).toBeGreaterThanOrEqual(1);
    expect(body.consent_history[0].action).toBe('suppress');
    expect(body.unsubscribe_group_memberships).toHaveLength(1);
    expect(body.unsubscribe_group_memberships[0].group_name).toBe('Newsletter');
    expect(body.soft_bounce?.count).toBe(2);
    expect(body.workflow_runs).toEqual([]);
    expect(body.tracked_links).toEqual([]);
    expect(body.erasure_requests).toEqual([]);
  });

  it('erasure pseudonymizes consent ledger + deletion request and removes group membership', async () => {
    const cust = await seedCustomer({ scopes: ['send', 'messages'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const victim = `erase-pseudo-${Date.now()}@example.com`;

    const send = await app.inject({
      method: 'POST', url: '/v1/send',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { from: `s@${domain}`, to: victim, subject: 'x', text: 'body' },
    });
    expect(send.statusCode).toBe(202);
    // Footprint (incl. suppression) seeded after the send, as a real one-click
    // opt-out would occur.
    await seedRecipientFootprint(cust.customerId, victim);

    const del = await app.inject({
      method: 'POST', url: '/v1/privacy/delete-recipient',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { recipient: victim },
    });
    expect([200, 202]).toContain(del.statusCode);
    const body = del.json();
    expect(body.consent_events_pseudonymized).toBeGreaterThanOrEqual(1);
    expect(body.group_memberships_deleted).toBe(1);

    // No surviving store may hold the plaintext identifier.
    const plaintextConsent = await db.selectFrom('consent_events').select('id')
      .where('customer_id', '=', cust.customerId).where('email', '=', victim).execute();
    expect(plaintextConsent).toHaveLength(0);
    const plaintextRequests = await db.selectFrom('deletion_requests').select('id')
      .where('customer_id', '=', cust.customerId).where('recipient', '=', victim).execute();
    expect(plaintextRequests).toHaveLength(0);
    const members = await db.selectFrom('unsubscribe_group_members').select('id')
      .where('customer_id', '=', cust.customerId).where('email', '=', victim).execute();
    expect(members).toHaveLength(0);

    // The evidence survives under the keyed pseudonym, with notes cleared.
    const pseudonym = erasedRecipientPseudonym(cust.customerId, victim);
    const pseudoConsent = await db.selectFrom('consent_events').select(['notes', 'pseudonymized_at'])
      .where('customer_id', '=', cust.customerId).where('email', '=', pseudonym).execute();
    expect(pseudoConsent.length).toBeGreaterThanOrEqual(1);
    for (const row of pseudoConsent) {
      expect(row.notes).toBeNull();
      expect(row.pseudonymized_at).toBeTruthy();
    }
    const request = await db.selectFrom('deletion_requests').select(['id', 'pseudonymized_at'])
      .where('customer_id', '=', cust.customerId).where('recipient', '=', pseudonym).executeTakeFirstOrThrow();
    expect(request.pseudonymized_at).toBeTruthy();

    // Export still surfaces the erasure evidence by recomputing the pseudonym.
    const exp = await app.inject({
      method: 'GET', url: `/v1/privacy/export-recipient?email=${encodeURIComponent(victim)}`,
      headers: { authorization: `Bearer ${cust.apiKey}` },
    });
    expect(exp.statusCode).toBe(200);
    expect(exp.json().erasure_requests.length).toBeGreaterThanOrEqual(1);
  });

  it('does not touch another tenant or another recipient in the same tenant', async () => {
    const cust = await seedCustomer({ scopes: ['send', 'messages'] });
    const other = await seedCustomer({ scopes: ['send', 'messages'] });
    const victim = `erase-scope-${Date.now()}@example.com`;
    const bystander = `bystander-${Date.now()}@example.com`;
    await seedRecipientFootprint(cust.customerId, victim);
    await seedRecipientFootprint(cust.customerId, bystander);
    await seedRecipientFootprint(other.customerId, victim);

    const del = await app.inject({
      method: 'POST', url: '/v1/privacy/delete-recipient',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
      payload: { recipient: victim },
    });
    expect([200, 202]).toContain(del.statusCode);

    // Same tenant, different recipient: untouched.
    const bystanderConsent = await db.selectFrom('consent_events').select('id')
      .where('customer_id', '=', cust.customerId).where('email', '=', bystander).execute();
    expect(bystanderConsent.length).toBeGreaterThanOrEqual(1);
    // Same recipient, different tenant: untouched.
    const otherConsent = await db.selectFrom('consent_events').select('id')
      .where('customer_id', '=', other.customerId).where('email', '=', victim).execute();
    expect(otherConsent.length).toBeGreaterThanOrEqual(1);
    const otherMembers = await db.selectFrom('unsubscribe_group_members').select('id')
      .where('customer_id', '=', other.customerId).where('email', '=', victim).execute();
    expect(otherMembers).toHaveLength(1);
  });
});
