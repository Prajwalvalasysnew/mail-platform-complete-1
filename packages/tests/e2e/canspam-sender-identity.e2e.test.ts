// E2E: CANSPAM-02/03 (compliance implementation plan) — sender identity
// validation and advertisement-identification attestation.
//
// - Custom headers cannot override identity/routing/opt-out headers.
// - Display names embedding third-party addresses are rejected; the tenant's
//   own verified domain is allowed.
// - Header-injection attempts (CR/LF in subject, from_name, header values)
//   fail schema validation.
// - The ad_identified attestation is stored as compliance evidence.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain } from './harness.js';
import { db } from '@platform/shared';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

const headers = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });

function send(apiKey: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/v1/send', headers: headers(apiKey), payload });
}

describe('CAN-SPAM sender identity validation', () => {
  it('rejects custom headers that override identity/routing/opt-out headers', async () => {
    const cust = await seedCustomer({ scopes: ['send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    for (const header of ['From', 'reply-to', 'List-Unsubscribe', 'Return-Path', 'X-MP-Customer-ID']) {
      const res = await send(cust.apiKey, {
        from: `s@${domain}`, to: 'a@example.com', subject: 'x', text: 'x',
        headers: { [header]: 'attacker@evil.example' },
      });
      expect(res.statusCode, header).toBe(422);
      expect(res.json().error, header).toBe('reserved_header');
    }
    // Benign custom headers still pass.
    const ok = await send(cust.apiKey, {
      from: `s@${domain}`, to: 'a@example.com', subject: 'x', text: 'x',
      headers: { 'X-Campaign-Ref': 'q3-launch' },
    });
    expect(ok.statusCode).toBe(202);
  });

  it('rejects a from_name that embeds a third-party address, allows own domain', async () => {
    const cust = await seedCustomer({ scopes: ['send'] });
    const domain = await seedVerifiedDomain(cust.customerId);

    const spoof = await send(cust.apiKey, {
      from: `s@${domain}`, to: 'a@example.com', subject: 'x', text: 'x',
      from_name: 'PayPal Support support@paypal.com',
    });
    expect(spoof.statusCode).toBe(422);
    expect(spoof.json().error).toBe('from_name_spoofing');

    const own = await send(cust.apiKey, {
      from: `s@${domain}`, to: 'a@example.com', subject: 'x', text: 'x',
      from_name: `Support billing@${domain}`,
    });
    expect(own.statusCode).toBe(202);
  });

  it('rejects header-injection attempts in subject, from_name, and header values', async () => {
    const cust = await seedCustomer({ scopes: ['send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const attempts: Array<Record<string, unknown>> = [
      { subject: 'hi\r\nBcc: victim@example.com' },
      { from_name: 'Sender\nX-Injected: 1' },
      { headers: { 'X-Note': 'a\r\nBcc: victim@example.com' } },
    ];
    for (const extra of attempts) {
      const res = await send(cust.apiKey, {
        from: `s@${domain}`, to: 'a@example.com', subject: 'x', text: 'x', ...extra,
      });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      expect(res.json().error).toBe('validation_failed');
    }
  });

  it('applies the same guards per entry in /send/batch', async () => {
    const cust = await seedCustomer({ scopes: ['send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const res = await app.inject({
      method: 'POST', url: '/v1/send/batch', headers: headers(cust.apiKey),
      payload: {
        messages: [
          { from: `s@${domain}`, to: `ok-${Date.now()}@example.com`, subject: 'a', text: 'a' },
          { from: `s@${domain}`, to: `hdr-${Date.now()}@example.com`, subject: 'b', text: 'b', headers: { From: 'evil@evil.example' } },
          { from: `s@${domain}`, to: `spoof-${Date.now()}@example.com`, subject: 'c', text: 'c', from_name: 'IRS refunds@irs.gov' },
        ],
      },
    });
    expect([200, 202]).toContain(res.statusCode);
    const results = res.json().results;
    expect(results[0].accepted).toBe(true);
    expect(results[1]).toMatchObject({ accepted: false, error: 'reserved_header' });
    expect(results[2]).toMatchObject({ accepted: false, error: 'from_name_spoofing' });
  });

  it('records the ad_identified attestation in message metadata', async () => {
    const cust = await seedCustomer({ scopes: ['send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = `ad-attest-${Date.now()}@example.com`;
    const res = await send(cust.apiKey, {
      from: `promo@${domain}`, to, subject: 'Big sale', text: 'Advertisement: big sale', ad_identified: true,
    });
    expect(res.statusCode).toBe(202);
    const row = await db.selectFrom('messages').select(['metadata', 'message_class'])
      .where('customer_id', '=', cust.customerId).where('to_address', '=', to).executeTakeFirstOrThrow();
    expect((row.metadata as any)._ad_identified).toBe(true);
    expect(row.message_class).toBe('commercial');
  });
});
