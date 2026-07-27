// E2E: GDPR-05 (compliance implementation plan) — consent standards.
//
// The platform could already prove someone OPTED OUT. This proves they OPTED
// IN, which is what Art 7(1) demands: "the controller shall be able to
// demonstrate that the data subject has consented".
//
// The two load-bearing negatives:
//   * an unconfirmed double opt-in is NOT valid consent
//   * a record with no evidence wording is refused, because it would look like
//     proof while proving nothing

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer } from './harness.js';
import {
  db,
  hasValidConsent,
  recordConsentGrant,
  getConsentProof,
  isErasedPseudonym,
} from '@platform/shared';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

const recipient = () => `consent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
const hdr = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });

const WORDING = 'I agree to receive marketing emails about product updates and offers.';

describe('GDPR-05: recording affirmative consent', () => {
  it('records a web-form grant with full provenance', async () => {
    const cust = await seedCustomer({ scopes: ['suppressions'] });
    const to = recipient();

    const res = await app.inject({
      method: 'POST', url: '/v1/privacy/consent', headers: hdr(cust.apiKey),
      payload: {
        recipient: to, method: 'web_form', evidence_text: WORDING,
        policy_version: '2026-01-15', source_url: 'https://example.com/signup',
        ip: '203.0.113.10', user_agent: 'Mozilla/5.0',
      },
    });

    expect(res.statusCode).toBe(201);
    const consent = res.json().consent;
    expect(consent.method).toBe('web_form');
    expect(consent.evidence_text).toBe(WORDING);
    expect(consent.policy_version).toBe('2026-01-15');
    expect(consent.affirmative).toBe(true);
    expect(await hasValidConsent(cust.customerId, to)).toBe(true);
  });

  it('REFUSES a grant with no evidence wording', async () => {
    const cust = await seedCustomer({ scopes: ['suppressions'] });
    const res = await app.inject({
      method: 'POST', url: '/v1/privacy/consent', headers: hdr(cust.apiKey),
      payload: { recipient: recipient(), method: 'web_form', evidence_text: 'ok' },
    });

    // A record without the wording would look like proof while proving
    // nothing — worse than no record, because it invites relying on it.
    expect(res.statusCode).toBe(400);
  });

  it('supersedes an earlier grant rather than accumulating competing claims', async () => {
    const cust = await seedCustomer({ scopes: ['suppressions'] });
    const to = recipient();

    await recordConsentGrant({
      customerId: cust.customerId, email: to, method: 'web_form',
      evidenceText: WORDING, policyVersion: '2025-01-01',
    });
    await recordConsentGrant({
      customerId: cust.customerId, email: to, method: 'web_form',
      evidenceText: WORDING, policyVersion: '2026-01-15',
    });

    const proof = await getConsentProof(cust.customerId, to);
    expect(proof.records).toHaveLength(2);
    expect(proof.has_valid_consent).toBe(true);
    // Exactly one live grant; the older one is withdrawn as superseded.
    const live = proof.records.filter((r) => r.withdrawn_at === null);
    expect(live).toHaveLength(1);
    expect(live[0].policy_version).toBe('2026-01-15');
    const superseded = proof.records.find((r) => r.withdrawn_at !== null)!;
    expect(superseded.withdrawal_source).toBe('superseded_by_new_consent');
  });
});

describe('GDPR-05: double opt-in', () => {
  it('AN UNCONFIRMED DOUBLE OPT-IN IS NOT VALID CONSENT', async () => {
    const cust = await seedCustomer({ scopes: ['suppressions'] });
    const to = recipient();

    const res = await app.inject({
      method: 'POST', url: '/v1/privacy/consent', headers: hdr(cust.apiKey),
      payload: { recipient: to, method: 'double_opt_in', evidence_text: WORDING },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().pending_confirmation).toBe(true);
    expect(res.json().confirmation_token).toBeTruthy();

    // Treating this as consent would let anyone subscribe any address — the
    // exact abuse double opt-in exists to prevent.
    expect(await hasValidConsent(cust.customerId, to)).toBe(false);
  });

  it('becomes valid once confirmed, and the token is single-use', async () => {
    const cust = await seedCustomer({ scopes: ['suppressions'] });
    const to = recipient();

    const created = await app.inject({
      method: 'POST', url: '/v1/privacy/consent', headers: hdr(cust.apiKey),
      payload: { recipient: to, method: 'double_opt_in', evidence_text: WORDING },
    });
    const token = created.json().confirmation_token;

    const confirmed = await app.inject({
      method: 'POST', url: '/v1/privacy/consent/confirm', headers: hdr(cust.apiKey),
      payload: { token },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(await hasValidConsent(cust.customerId, to)).toBe(true);

    const replay = await app.inject({
      method: 'POST', url: '/v1/privacy/consent/confirm', headers: hdr(cust.apiKey),
      payload: { token },
    });
    expect(replay.statusCode).toBe(404);
  });

  it('does not leak the confirmation token in the created record body', async () => {
    const cust = await seedCustomer({ scopes: ['suppressions'] });
    const res = await app.inject({
      method: 'POST', url: '/v1/privacy/consent', headers: hdr(cust.apiKey),
      payload: { recipient: recipient(), method: 'double_opt_in', evidence_text: WORDING },
    });
    expect(res.json().consent.confirmation_token).toBeUndefined();
  });
});

describe('GDPR-05: withdrawal (Art 7(3))', () => {
  it('withdraws without destroying the proof consent once existed', async () => {
    const cust = await seedCustomer({ scopes: ['suppressions'] });
    const to = recipient();
    await recordConsentGrant({
      customerId: cust.customerId, email: to, method: 'web_form', evidenceText: WORDING,
    });

    const res = await app.inject({
      method: 'POST', url: '/v1/privacy/consent/withdraw', headers: hdr(cust.apiKey),
      payload: { recipient: to, source: 'preference_centre' },
    });
    expect(res.statusCode).toBe(200);
    expect(await hasValidConsent(cust.customerId, to)).toBe(false);

    // The controller still has to account for mail sent while consent was
    // valid, so the record survives with its evidence intact.
    const proof = await getConsentProof(cust.customerId, to);
    expect(proof.records).toHaveLength(1);
    expect(proof.records[0].withdrawn_at).toBeTruthy();
    expect(proof.records[0].evidence_text).toBe(WORDING);
    expect(proof.records[0].withdrawal_source).toBe('preference_centre');
  });

  it('withdrawing when there is nothing to withdraw is a 404', async () => {
    const cust = await seedCustomer({ scopes: ['suppressions'] });
    const res = await app.inject({
      method: 'POST', url: '/v1/privacy/consent/withdraw', headers: hdr(cust.apiKey),
      payload: { recipient: recipient() },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GDPR-05: proof export', () => {
  it('returns the whole grant chain, not just the current position', async () => {
    const cust = await seedCustomer({ scopes: ['suppressions'] });
    const to = recipient();
    await recordConsentGrant({
      customerId: cust.customerId, email: to, method: 'offline',
      evidenceText: WORDING, policyVersion: 'v1',
    });
    await recordConsentGrant({
      customerId: cust.customerId, email: to, method: 'web_form',
      evidenceText: WORDING, policyVersion: 'v2',
    });

    const res = await app.inject({
      method: 'GET', url: `/v1/privacy/consent/proof?recipient=${encodeURIComponent(to)}`,
      headers: hdr(cust.apiKey),
    });

    expect(res.statusCode).toBe(200);
    // "What was the position on <date>" cannot be answered from one row.
    expect(res.json().records).toHaveLength(2);
    expect(res.json().has_valid_consent).toBe(true);
  });

  it('does not leak consent across tenants', async () => {
    const a = await seedCustomer({ scopes: ['suppressions'] });
    const b = await seedCustomer({ scopes: ['suppressions'] });
    const to = recipient();
    await recordConsentGrant({
      customerId: a.customerId, email: to, method: 'web_form', evidenceText: WORDING,
    });

    expect(await hasValidConsent(b.customerId, to)).toBe(false);
    const res = await app.inject({
      method: 'GET', url: `/v1/privacy/consent/proof?recipient=${encodeURIComponent(to)}`,
      headers: hdr(b.apiKey),
    });
    expect(res.json().records).toHaveLength(0);
  });
});

describe('GDPR-05: erasure integration (BASE-03)', () => {
  it('pseudonymizes consent records on erasure and clears the personal data', async () => {
    const cust = await seedCustomer({ scopes: ['suppressions', 'messages'] });
    const to = recipient();
    await recordConsentGrant({
      customerId: cust.customerId, email: to, method: 'web_form',
      evidenceText: WORDING, policyVersion: '2026-01-15',
      ip: '203.0.113.10', userAgent: 'Mozilla/5.0',
    });

    const erase = await app.inject({
      method: 'POST', url: '/v1/privacy/delete-recipient',
      headers: hdr(cust.apiKey), payload: { recipient: to },
    });
    expect(erase.statusCode).toBe(200);

    const rows = await db.selectFrom('consent_records')
      .selectAll().where('customer_id', '=', cust.customerId).execute();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // A new table must not become a place erasure forgets to reach.
    expect(row.email).not.toBe(to);
    expect(isErasedPseudonym(row.email)).toBe(true);
    expect(row.ip).toBeNull();
    expect(row.user_agent).toBeNull();
    expect(row.confirmation_token).toBeNull();
    expect(row.pseudonymized_at).toBeTruthy();

    // The proof itself carries no identifier, so it survives.
    expect(row.evidence_text).toBe(WORDING);
    expect(row.policy_version).toBe('2026-01-15');
    expect(row.method).toBe('web_form');
  });
});
