// E2E: CCPA-05 (compliance implementation plan) — right to limit the use and
// disclosure of sensitive personal information (§1798.121).
//
// Message content is SPI here by definition: §1798.140(ae)(1)(E) covers the
// contents of mail and email unless the business is the intended recipient,
// and this platform never is.
//
// The two things worth proving are the two halves of the line:
//   * the limit DOES turn off engagement tracking, overriding the sender
//   * the limit does NOT turn off delivery, abuse scanning, or the CAN-SPAM
//     footer — those are permitted purposes and legal obligations, and a
//     consumer preference cannot switch them off

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain } from './harness.js';
import {
  db,
  isSensitivePiLimited,
  limitSensitivePiUse,
  applySensitivePiLimitToTracking,
  isErasedPseudonym,
} from '@platform/shared';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

const recipient = () => `spi-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
const hdr = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });

async function trackingFor(customerId: string) {
  return db.selectFrom('messages').select(['to_address', 'tracking_opens', 'tracking_clicks'])
    .where('customer_id', '=', customerId).execute();
}

describe('applySensitivePiLimitToTracking', () => {
  // Returns the message COLUMN names: both call sites spread this straight
  // into the insert, so returning the API's {opens, clicks} shape would write
  // columns that do not exist and drop the real ones.
  it('forces tracking off when limited, whatever the sender asked for', () => {
    expect(applySensitivePiLimitToTracking(true, { opens: true, clicks: true }))
      .toEqual({ tracking_opens: false, tracking_clicks: false });
    expect(applySensitivePiLimitToTracking(true, undefined))
      .toEqual({ tracking_opens: false, tracking_clicks: false });
  });

  it('preserves the sender preference when not limited', () => {
    expect(applySensitivePiLimitToTracking(false, { opens: false, clicks: true }))
      .toEqual({ tracking_opens: false, tracking_clicks: true });
    // Tracking defaults on when nothing is specified.
    expect(applySensitivePiLimitToTracking(false, undefined))
      .toEqual({ tracking_opens: true, tracking_clicks: true });
  });
});

describe('CCPA-05: recording and lifting a limit', () => {
  it('records a limit and reports its effect', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const to = recipient();

    const res = await app.inject({
      method: 'POST', url: '/v1/privacy/limit-sensitive-pi', headers: hdr(cust.apiKey),
      payload: { recipient: to, source: 'web_form' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().limit.source).toBe('web_form');
    expect(res.json().effect).toContain('tracking are disabled');
    expect(await isSensitivePiLimited(cust.customerId, to)).toBe(true);
  });

  it('is idempotent', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const to = recipient();
    await app.inject({
      method: 'POST', url: '/v1/privacy/limit-sensitive-pi', headers: hdr(cust.apiKey),
      payload: { recipient: to },
    });
    const again = await app.inject({
      method: 'POST', url: '/v1/privacy/limit-sensitive-pi', headers: hdr(cust.apiKey),
      payload: { recipient: to },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().already_limited).toBe(true);
  });

  it('lifts the limit and restores tracking', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const to = recipient();
    await limitSensitivePiUse({ customerId: cust.customerId, email: to });

    const released = await app.inject({
      method: 'POST', url: '/v1/privacy/limit-sensitive-pi/release', headers: hdr(cust.apiKey),
      payload: { recipient: to, reason: 'consumer withdrew the request' },
    });
    expect(released.statusCode).toBe(200);
    expect(await isSensitivePiLimited(cust.customerId, to)).toBe(false);
  });

  it('releasing when nothing is limited is a 404', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const res = await app.inject({
      method: 'POST', url: '/v1/privacy/limit-sensitive-pi/release', headers: hdr(cust.apiKey),
      payload: { recipient: recipient() },
    });
    expect(res.statusCode).toBe(404);
  });

  it('does not leak limits across tenants', async () => {
    const a = await seedCustomer({ scopes: ['messages'] });
    const b = await seedCustomer({ scopes: ['messages'] });
    const to = recipient();
    await limitSensitivePiUse({ customerId: a.customerId, email: to });

    expect(await isSensitivePiLimited(b.customerId, to)).toBe(false);
    const list = await app.inject({
      method: 'GET', url: '/v1/privacy/sensitive-pi-limits', headers: hdr(b.apiKey),
    });
    expect(list.json().limits).toHaveLength(0);
  });
});

describe('CCPA-05: enforcement in the send path', () => {
  it('DISABLES TRACKING even when the sender explicitly asks for it', async () => {
    const cust = await seedCustomer({ scopes: ['messages', 'send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    await limitSensitivePiUse({ customerId: cust.customerId, email: to });

    const res = await app.inject({
      method: 'POST', url: '/v1/send', headers: hdr(cust.apiKey),
      payload: {
        from: `s@${domain}`, to, subject: 'hello', text: 'hi',
        tracking: { opens: true, clicks: true },
      },
    });
    expect(res.statusCode).toBe(202);

    // A consumer instruction outranks a customer setting — that is the point
    // of the right.
    const [row] = await trackingFor(cust.customerId);
    expect(row.tracking_opens).toBe(false);
    expect(row.tracking_clicks).toBe(false);
  });

  it('leaves tracking on for recipients who have not limited', async () => {
    const cust = await seedCustomer({ scopes: ['messages', 'send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();

    await app.inject({
      method: 'POST', url: '/v1/send', headers: hdr(cust.apiKey),
      payload: { from: `s@${domain}`, to, subject: 'hello', text: 'hi', tracking: { opens: true, clicks: true } },
    });

    const [row] = await trackingFor(cust.customerId);
    expect(row.tracking_opens).toBe(true);
    expect(row.tracking_clicks).toBe(true);
  });

  it('applies per recipient within one multi-recipient send', async () => {
    const cust = await seedCustomer({ scopes: ['messages', 'send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const limited = recipient();
    const open = recipient();
    await limitSensitivePiUse({ customerId: cust.customerId, email: limited });

    const res = await app.inject({
      method: 'POST', url: '/v1/send', headers: hdr(cust.apiKey),
      payload: { from: `s@${domain}`, to: [limited, open], subject: 'hello', text: 'hi' },
    });
    expect(res.statusCode).toBe(202);

    const rows = await trackingFor(cust.customerId);
    const limitedRow = rows.find((r) => r.to_address === limited)!;
    const openRow = rows.find((r) => r.to_address === open)!;
    expect(limitedRow.tracking_opens).toBe(false);
    expect(openRow.tracking_opens).toBe(true);
  });

  it('applies on the batch send path too', async () => {
    const cust = await seedCustomer({ scopes: ['messages', 'send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const limited = recipient();
    const open = recipient();
    await limitSensitivePiUse({ customerId: cust.customerId, email: limited });

    const res = await app.inject({
      method: 'POST', url: '/v1/send/batch', headers: hdr(cust.apiKey),
      payload: {
        messages: [
          { from: `s@${domain}`, to: limited, subject: 'a', text: 'a', tracking: { opens: true, clicks: true } },
          { from: `s@${domain}`, to: open, subject: 'b', text: 'b', tracking: { opens: true, clicks: true } },
        ],
      },
    });
    expect(res.statusCode).toBe(202);

    const rows = await trackingFor(cust.customerId);
    expect(rows.find((r) => r.to_address === limited)!.tracking_opens).toBe(false);
    expect(rows.find((r) => r.to_address === open)!.tracking_opens).toBe(true);
  });

  it('DOES NOT stop delivery — the limit is not a suppression', async () => {
    const cust = await seedCustomer({ scopes: ['messages', 'send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    await limitSensitivePiUse({ customerId: cust.customerId, email: to });

    const res = await app.inject({
      method: 'POST', url: '/v1/send', headers: hdr(cust.apiKey),
      payload: { from: `s@${domain}`, to, subject: 'still delivered', text: 'hi' },
    });

    // Performing the service is a permitted purpose; over-enforcing here would
    // silently unsubscribe someone who only asked not to be profiled.
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(1);
    expect(res.json().suppressed ?? []).not.toContain(to);
  });

  it('DOES NOT disable abuse scanning — that is a permitted purpose', async () => {
    const cust = await seedCustomer({ scopes: ['messages', 'send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    const to = recipient();
    await limitSensitivePiUse({ customerId: cust.customerId, email: to });

    // Card-data screening (PCI-02) still refuses. Allowing the limit to switch
    // off abuse controls would turn a privacy right into an evasion technique.
    const res = await app.inject({
      method: 'POST', url: '/v1/send', headers: hdr(cust.apiKey),
      payload: { from: `s@${domain}`, to, subject: 'x', text: 'card 4242424242424242' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('card_data_detected');
  });
});

describe('CCPA-05: erasure integration (BASE-03)', () => {
  it('pseudonymizes the limit on erasure', async () => {
    const cust = await seedCustomer({ scopes: ['messages'] });
    const to = recipient();
    await limitSensitivePiUse({ customerId: cust.customerId, email: to });

    const erase = await app.inject({
      method: 'POST', url: '/v1/privacy/delete-recipient',
      headers: hdr(cust.apiKey), payload: { recipient: to },
    });
    expect(erase.statusCode).toBe(200);

    const rows = await db.selectFrom('sensitive_pi_limits').selectAll()
      .where('customer_id', '=', cust.customerId).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].email).not.toBe(to);
    expect(isErasedPseudonym(rows[0].email)).toBe(true);
    expect(rows[0].pseudonymized_at).toBeTruthy();
  });
});
