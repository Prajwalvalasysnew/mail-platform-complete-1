// E2E: PCI-02 (compliance implementation plan) — accidental card data is
// detected and contained at every ingress that can carry free text.
//
// The platform is deliberately outside the cardholder data environment, so the
// controls under test are: message content is refused before anything is
// persisted, support tickets are redacted rather than refused, and ordinary
// traffic that merely LOOKS numeric is unaffected.
//
// Card numbers here are publicly documented provider TEST values — Luhn-valid
// but not issued to anyone — so this file contains no real cardholder data.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain } from './harness.js';
import { db } from '@platform/shared';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

const VISA = '4242424242424242';
const AMEX = '378282246310005';

const headers = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });
function send(apiKey: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/v1/send', headers: headers(apiKey), payload });
}

describe('PCI-02: card data in outbound message content', () => {
  it.each(['free', 'paid', 'enterprise'] as const)(
    'rejects a PAN for the $tier tier and persists no message',
    async (tier) => {
    const cust = await seedCustomer({ tier, scopes: ['send'] });
    const domain = await seedVerifiedDomain(cust.customerId);

    const res = await send(cust.apiKey, {
      from: `s@${domain}`, to: 'a@example.com',
      subject: 'Your receipt',
      text: `Charged card ${VISA} for $42.`,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('card_data_detected');
    expect(res.json().fields).toContain('text');
    // The rejection message must not echo the value back to the caller.
    expect(JSON.stringify(res.json())).not.toContain('4242');

    // Nothing was written: the PAN never reached the messages table.
    const rows = await db.selectFrom('messages').select('message_id')
      .where('customer_id', '=', cust.customerId).execute();
    expect(rows).toHaveLength(0);
    },
  );

  it('rejects a PAN in the HTML body and in the subject', async () => {
    const cust = await seedCustomer({ scopes: ['send'] });
    const domain = await seedVerifiedDomain(cust.customerId);

    const htmlRes = await send(cust.apiKey, {
      from: `s@${domain}`, to: 'a@example.com', subject: 'hi',
      html: `<p>card: ${AMEX}</p>`,
    });
    expect(htmlRes.statusCode).toBe(422);
    expect(htmlRes.json().fields).toContain('html');

    const subjRes = await send(cust.apiKey, {
      from: `s@${domain}`, to: 'a@example.com',
      subject: `Payment for ${VISA}`, text: 'thanks',
    });
    expect(subjRes.statusCode).toBe(422);
    expect(subjRes.json().fields).toContain('subject');
  });

  it('catches a PAN injected through a template variable, not just an inline body', async () => {
    const cust = await seedCustomer({ scopes: ['send'] });
    const domain = await seedVerifiedDomain(cust.customerId);

    const tpl = await db.insertInto('templates').values({
      customer_id: cust.customerId,
      name: `receipt-${Date.now()}`,
      subject: 'Receipt',
      html_body: '<p>Paid with {{card}}</p>',
      text_body: 'Paid with {{card}}',
    }).returning('id').executeTakeFirstOrThrow();

    const res = await send(cust.apiKey, {
      from: `s@${domain}`, to: 'a@example.com',
      template_id: tpl.id,
      variables: { card: VISA },
    });

    // Screening runs AFTER rendering, so the substituted value is caught.
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('card_data_detected');
  });

  it('writes a value-free audit record naming the field but not the digits', async () => {
    const cust = await seedCustomer({ scopes: ['send'] });
    const domain = await seedVerifiedDomain(cust.customerId);
    await send(cust.apiKey, {
      from: `s@${domain}`, to: 'a@example.com', subject: 'x', text: `pay ${VISA}`,
    });

    const audit = await db.selectFrom('audit_log').select(['action', 'resource', 'metadata'])
      .where('customer_id', '=', cust.customerId)
      .where('action', '=', 'card_data_detected')
      .executeTakeFirst();

    expect(audit).toBeTruthy();
    expect(audit!.resource).toBe('send');
    const meta = audit!.metadata as any;
    expect(meta.fields).toContain('text');
    expect(meta.brands).toContain('visa');
    expect(meta.pan).toBe(1);
    // The audit trail must never become a place card data is stored.
    expect(JSON.stringify(meta)).not.toContain('4242');
  });

  it('rejects the offending entry in a batch without failing the whole batch', async () => {
    const cust = await seedCustomer({ scopes: ['send'] });
    const domain = await seedVerifiedDomain(cust.customerId);

    const res = await app.inject({
      method: 'POST', url: '/v1/send/batch', headers: headers(cust.apiKey),
      payload: {
        messages: [
          { from: `s@${domain}`, to: 'ok@example.com', subject: 'fine', text: 'nothing to see' },
          { from: `s@${domain}`, to: 'bad@example.com', subject: 'oops', text: `card ${VISA}` },
        ],
      },
    });

    expect(res.statusCode).toBe(202);
    const results = res.json().results;
    expect(results[0].accepted).toBe(true);
    expect(results[1].accepted).toBe(false);
    expect(results[1].error).toBe('card_data_detected');
  });

  it('does not block ordinary numeric content', async () => {
    const cust = await seedCustomer({ scopes: ['send'] });
    const domain = await seedVerifiedDomain(cust.customerId);

    // Order ids, epoch timestamps, phone numbers, and masked card references
    // are exactly the traffic a false-positive-prone detector would break.
    const res = await send(cust.apiKey, {
      from: `s@${domain}`, to: 'a@example.com',
      subject: 'Order 00012345 confirmed',
      text: `Placed at ${Date.now()}. Card ending 4242. Questions? +1 415 555 0100. Ref 12345678901234567890.`,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(1);
    expect(res.json().message_ids).toHaveLength(1);
  });
});

describe('PCI-02: card data in support tickets', () => {
  async function registerUser() {
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: `pci-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`,
        password: 'correct-horse-battery',
        name: 'PCI Test User',
        org_name: 'PCI Test Org',
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { token: string };
  }

  it('redacts rather than rejects, so the customer does not lose the ticket', async () => {
    const { token } = await registerUser();

    const res = await app.inject({
      method: 'POST', url: '/v1/support/tickets',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { subject: 'Charge failed', body: `My card ${VISA} was declined, cvv: 123` },
    });

    expect(res.statusCode).toBe(201);
    const ticketId = res.json().ticket.id;

    // The ticket body is stored as the first message on the thread.
    const stored = await db.selectFrom('support_ticket_messages').select('body')
      .where('ticket_id', '=', ticketId).orderBy('created_at').executeTakeFirstOrThrow();
    expect(stored.body).not.toContain('4242');
    expect(stored.body).not.toContain('cvv: 123');
    expect(stored.body).toContain('[redacted-card]');
    expect(stored.body).toContain('declined');   // the rest of the message survives
  });

  it('redacts a PAN pasted into a follow-up ticket message', async () => {
    const { token } = await registerUser();
    const created = await app.inject({
      method: 'POST', url: '/v1/support/tickets',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { subject: 'Billing question', body: 'Why was I charged twice?' },
    });
    expect(created.statusCode).toBe(201);
    const ticketId = created.json().ticket.id;

    const msg = await app.inject({
      method: 'POST', url: `/v1/support/tickets/${ticketId}/messages`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { body: `Here is the card I used: ${AMEX}` },
    });
    expect(msg.statusCode).toBe(201);

    const stored = await db.selectFrom('support_ticket_messages').select('body')
      .where('id', '=', msg.json().message.id).executeTakeFirstOrThrow();
    expect(stored.body).not.toContain('3782');
    expect(stored.body).toContain('[redacted-card]');
  });
});
