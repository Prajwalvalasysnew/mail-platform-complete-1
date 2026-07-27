// E2E: GDPR-02 / CCPA-02 (compliance implementation plan) — data-subject
// rights beyond access and erasure.
//
// The platform already had export (Art 15 / 20) and erasure (Art 17). These
// cover the three that were missing:
//
//   restriction   (Art 18)  store it, do not use it
//   rectification (Art 16 / CCPA right to correct)
//   objection     (Art 21)  stop direct marketing
//
// The load-bearing test is "restriction is not suppression": if the two were
// merged, a recipient resubscribing would silently lift a legal restriction,
// which is precisely what Article 18 exists to prevent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain } from './harness.js';
import {
  db,
  isProcessingRestricted,
  isSuppressed,
  addSuppression,
  removeSuppression,
  getConsentHistory,
} from '@platform/shared';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

const recipient = () => `rights-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
const hdr = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });

function post(key: string, url: string, payload: unknown) {
  return app.inject({ method: 'POST', url, headers: hdr(key), payload });
}

describe('GDPR-02: restriction of processing (Article 18)', () => {
  it('restricts a recipient and reports the basis', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const to = recipient();

    const res = await post(cust.apiKey, '/v1/privacy/restrict-recipient', {
      recipient: to, basis: 'accuracy_contested', reason: 'subject disputes the address',
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().restriction.basis).toBe('accuracy_contested');
    expect(res.json().already_restricted).toBe(false);
    expect(await isProcessingRestricted(cust.customerId, to)).toBe(true);
  });

  it('is idempotent and preserves the original restriction date', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const to = recipient();

    const first = await post(cust.apiKey, '/v1/privacy/restrict-recipient', { recipient: to, basis: 'legal_claims' });
    const second = await post(cust.apiKey, '/v1/privacy/restrict-recipient', { recipient: to, basis: 'unlawful_processing' });

    expect(second.statusCode).toBe(200);
    expect(second.json().already_restricted).toBe(true);
    // The statutory record needs the ORIGINAL date, not the latest attempt.
    expect(second.json().restriction.restricted_at).toBe(first.json().restriction.restricted_at);
    expect(second.json().restriction.basis).toBe('legal_claims');
  });

  it('BLOCKS sending to a restricted recipient', async () => {
    const cust = await seedCustomer({ scopes: ['messages', 'send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    await post(cust.apiKey, '/v1/privacy/restrict-recipient', { recipient: to, basis: 'legal_claims' });

    const send = await post(cust.apiKey, '/v1/send', {
      from: `s@${domain}`, to, subject: 'should not go', text: 'x',
    });

    expect(send.statusCode).toBe(200);
    expect(send.json().accepted).toBe(0);
    expect(send.json().suppressed).toContain(to);

    const rows = await db.selectFrom('messages').select('message_id')
      .where('customer_id', '=', cust.customerId).execute();
    expect(rows).toHaveLength(0);
  });

  it('blocks the batch send path too', async () => {
    const cust = await seedCustomer({ scopes: ['messages', 'send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const blocked = recipient();
    const allowed = recipient();
    await post(cust.apiKey, '/v1/privacy/restrict-recipient', { recipient: blocked, basis: 'legal_claims' });

    const res = await post(cust.apiKey, '/v1/send/batch', {
      messages: [
        { from: `s@${domain}`, to: allowed, subject: 'ok', text: 'x' },
        { from: `s@${domain}`, to: blocked, subject: 'no', text: 'x' },
      ],
    });

    expect(res.statusCode).toBe(202);
    const results = res.json().results;
    expect(results[0].accepted).toBe(true);
    expect(results[1].accepted).toBe(false);
    expect(results[1].suppressed).toBe(true);
  });

  it('RESTRICTION IS NOT SUPPRESSION: resubscribing does not lift it', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const to = recipient();

    // The recipient is both suppressed (opted out) and restricted (legal).
    await addSuppression(cust.customerId, to, 'unsubscribe', 'opted out');
    await post(cust.apiKey, '/v1/privacy/restrict-recipient', { recipient: to, basis: 'unlawful_processing' });

    // They resubscribe — which clears the marketing state...
    await removeSuppression(cust.customerId, to);
    expect(await isSuppressed(cust.customerId, to)).toBe(false);

    // ...but MUST NOT clear the legal restriction.
    expect(await isProcessingRestricted(cust.customerId, to)).toBe(true);
  });

  it('releases only with a documented reason, and then sending resumes', async () => {
    const cust = await seedCustomer({ scopes: ['messages', 'send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    await post(cust.apiKey, '/v1/privacy/restrict-recipient', { recipient: to, basis: 'accuracy_contested' });

    // Article 18(3): a release with no reason is not a defensible record.
    const noReason = await post(cust.apiKey, '/v1/privacy/release-restriction', { recipient: to });
    expect(noReason.statusCode).toBe(400);

    const released = await post(cust.apiKey, '/v1/privacy/release-restriction', {
      recipient: to, reason: 'accuracy verified with the data subject', released_by: 'dpo@example.com',
    });
    expect(released.statusCode).toBe(200);
    expect(await isProcessingRestricted(cust.customerId, to)).toBe(false);

    const send = await post(cust.apiKey, '/v1/send', { from: `s@${domain}`, to, subject: 'ok now', text: 'x' });
    expect(send.statusCode).toBe(202);
  });

  it('releasing a recipient that is not restricted is a 404', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const res = await post(cust.apiKey, '/v1/privacy/release-restriction', {
      recipient: recipient(), reason: 'nothing to release',
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists active restrictions and keeps released ones as history', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const active = recipient();
    const lifted = recipient();
    await post(cust.apiKey, '/v1/privacy/restrict-recipient', { recipient: active, basis: 'legal_claims' });
    await post(cust.apiKey, '/v1/privacy/restrict-recipient', { recipient: lifted, basis: 'legal_claims' });
    await post(cust.apiKey, '/v1/privacy/release-restriction', { recipient: lifted, reason: 'resolved' });

    const list = await app.inject({ method: 'GET', url: '/v1/privacy/restrictions', headers: hdr(cust.apiKey) });
    const emails = list.json().restrictions.map((r: any) => r.email);
    expect(emails).toContain(active);
    expect(emails).not.toContain(lifted);

    const withHistory = await app.inject({
      method: 'GET', url: '/v1/privacy/restrictions?include_released=true', headers: hdr(cust.apiKey),
    });
    expect(withHistory.json().restrictions.map((r: any) => r.email)).toContain(lifted);
  });

  it('does not leak restrictions across tenants', async () => {
    const a = await seedCustomer({ scopes: ['messages'] });
    const b = await seedCustomer({ scopes: ['messages'] });
    const to = recipient();
    await post(a.apiKey, '/v1/privacy/restrict-recipient', { recipient: to, basis: 'legal_claims' });

    expect(await isProcessingRestricted(b.customerId, to)).toBe(false);
    const list = await app.inject({ method: 'GET', url: '/v1/privacy/restrictions', headers: hdr(b.apiKey) });
    expect(list.json().restrictions).toHaveLength(0);
  });
});

describe('GDPR-02 / CCPA-02: rectification (Article 16 / right to correct)', () => {
  it('moves forward-looking state and preserves the delivery history', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const wrong = recipient();
    const right = recipient();

    await addSuppression(cust.customerId, wrong, 'unsubscribe', 'opted out');
    await db.insertInto('messages').values({
      message_id: `rect-${Date.now()}@example.com`,
      customer_id: cust.customerId,
      to_address: wrong, from_address: 'sender@example.com',
      subject: 'historical', status: 'delivered', body_storage: 'inline',
    } as any).execute();

    const res = await post(cust.apiKey, '/v1/privacy/rectify-recipient', {
      recipient: wrong, corrected: right, requested_by: 'dpo@example.com',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().suppressions_moved).toBe(1);
    expect(res.json().consent_events_moved).toBeGreaterThanOrEqual(1);
    // The historical record is preserved AND reported, so the controller can
    // explain the distinction instead of silently ignoring part of the request.
    expect(res.json().historical_messages_preserved).toBe(1);

    // The opt-out now attaches to the corrected address...
    expect(await isSuppressed(cust.customerId, right)).toBe(true);
    expect(await isSuppressed(cust.customerId, wrong)).toBe(false);

    // ...and the delivery log still says what actually happened.
    const historical = await db.selectFrom('messages').select('to_address')
      .where('customer_id', '=', cust.customerId).executeTakeFirstOrThrow();
    expect(historical.to_address).toBe(wrong);
  });

  it('carries an active restriction across to the corrected address', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const wrong = recipient();
    const right = recipient();
    await post(cust.apiKey, '/v1/privacy/restrict-recipient', { recipient: wrong, basis: 'accuracy_contested' });

    await post(cust.apiKey, '/v1/privacy/rectify-recipient', { recipient: wrong, corrected: right });

    // Correcting a typo must not drop the legal restriction on the way.
    expect(await isProcessingRestricted(cust.customerId, right)).toBe(true);
    expect(await isProcessingRestricted(cust.customerId, wrong)).toBe(false);
  });

  it('does not collide when the corrected address is already suppressed', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const wrong = recipient();
    const right = recipient();
    await addSuppression(cust.customerId, wrong, 'unsubscribe', 'a');
    await addSuppression(cust.customerId, right, 'hard_bounce', 'b');

    const res = await post(cust.apiKey, '/v1/privacy/rectify-recipient', { recipient: wrong, corrected: right });
    expect(res.statusCode).toBe(200);

    // The stricter state survives on the corrected address either way.
    expect(await isSuppressed(cust.customerId, right)).toBe(true);
    expect(await isSuppressed(cust.customerId, wrong)).toBe(false);
  });

  it('rejects a no-op correction', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const to = recipient();
    const res = await post(cust.apiKey, '/v1/privacy/rectify-recipient', { recipient: to, corrected: to });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('rectify_noop');
  });
});

describe('GDPR-02: objection to direct marketing (Article 21)', () => {
  it('takes effect immediately and is distinguishable in the consent ledger', async () => {
    const cust = await seedCustomer({ scopes: ['messages', 'send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();

    const res = await post(cust.apiKey, '/v1/privacy/object', {
      recipient: to, requested_by: 'data-subject',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().effective).toBe('immediately');
    expect(await isSuppressed(cust.customerId, to)).toBe(true);

    // Both an objection and a click stop the mail, but only one is a formal
    // rights request the controller may have to evidence.
    const history = await getConsentHistory(cust.customerId, to);
    expect(history.some((h: any) => h.source === 'gdpr_objection')).toBe(true);

    const send = await post(cust.apiKey, '/v1/send', { from: `s@${domain}`, to, subject: 'x', text: 'x' });
    expect(send.json().accepted).toBe(0);
  });
});
