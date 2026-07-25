// PCI-03: billing_events.payload must retain only what the replay parsers
// read. The decisive assertions are the negative ones — a realistic provider
// event carries payment-instrument and payer-contact subtrees, and none of
// them may survive into storage.
//
// Card numbers below are publicly documented provider TEST values.

import { describe, it, expect } from 'vitest';
import { sanitizeBillingPayload, DROPPED_HIGH_RISK_PATHS } from '@platform/shared';

// A Stripe subscription event shaped like the real thing, including the
// payment-instrument fields Stripe actually sends.
const stripeSubscriptionEvent = {
  id: 'evt_1',
  type: 'customer.subscription.updated',
  created: 1784992010,
  api_version: '2024-06-20',
  data: {
    object: {
      id: 'sub_1',
      customer: 'cus_1',
      status: 'active',
      current_period_start: 1784992010,
      current_period_end: 1787584010,
      cancel_at_period_end: false,
      items: { data: [{ id: 'si_1', price: { id: 'price_pro', recurring: { usage_type: 'licensed' } } }] },
      // Everything below is real Stripe payload that replay never reads.
      default_payment_method: {
        id: 'pm_1',
        card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, fingerprint: 'abc' },
        billing_details: { address: { line1: '1 Test St', postal_code: '94105' }, email: 'payer@example.com' },
      },
      customer_details: { email: 'payer@example.com', phone: '+14155550100', tax_ids: [] },
      payment_settings: { payment_method_types: ['card'] },
      latest_invoice: 'in_1',
    },
  },
};

describe('sanitizeBillingPayload — stripe', () => {
  it('keeps every field the subscription replay parser reads', () => {
    const { payload } = sanitizeBillingPayload('stripe', stripeSubscriptionEvent);
    const p = payload as any;
    expect(p.id).toBe('evt_1');
    expect(p.type).toBe('customer.subscription.updated');
    expect(p.data.object.id).toBe('sub_1');
    expect(p.data.object.customer).toBe('cus_1');
    expect(p.data.object.status).toBe('active');
    expect(p.data.object.current_period_start).toBe(1784992010);
    expect(p.data.object.current_period_end).toBe(1787584010);
    expect(p.data.object.cancel_at_period_end).toBe(false);
    expect(p.data.object.items.data[0].id).toBe('si_1');
    expect(p.data.object.items.data[0].price.id).toBe('price_pro');
    expect(p.data.object.items.data[0].price.recurring.usage_type).toBe('licensed');
  });

  it('drops payment-instrument and payer-contact subtrees', () => {
    const { payload } = sanitizeBillingPayload('stripe', stripeSubscriptionEvent);
    const p = payload as any;
    expect(p.data.object.default_payment_method).toBeUndefined();
    expect(p.data.object.customer_details).toBeUndefined();
    expect(p.data.object.payment_settings).toBeUndefined();
    expect(p.data.object.latest_invoice).toBeUndefined();
    expect(p.api_version).toBeUndefined();

    // The whole-document assertion: nothing card- or contact-shaped survives.
    const json = JSON.stringify(payload);
    expect(json).not.toContain('4242');
    expect(json).not.toContain('payer@example.com');
    expect(json).not.toContain('+14155550100');
    expect(json).not.toContain('fingerprint');
    expect(json).not.toContain('94105');
  });

  it('drops fields a provider adds later (allowlist, not denylist)', () => {
    const withNewField = {
      ...stripeSubscriptionEvent,
      data: { object: { ...stripeSubscriptionEvent.data.object, some_future_field: { card_number: '4242424242424242' } } },
    };
    const json = JSON.stringify(sanitizeBillingPayload('stripe', withNewField).payload);
    expect(json).not.toContain('some_future_field');
    expect(json).not.toContain('4242424242424242');
  });

  it('keeps invoice line data and redacts card data pasted into free text', () => {
    const invoiceEvent = {
      id: 'evt_2',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_1',
          customer: 'cus_1',
          currency: 'usd',
          amount_due: 4200,
          total: 4200,
          tax: 200,
          period_start: 1784992010,
          period_end: 1787584010,
          status_transitions: { paid_at: 1784992100 },
          hosted_invoice_url: 'https://invoice.example/1',
          invoice_pdf: 'https://invoice.example/1.pdf',
          charges: { data: [{ payment_method_details: { card: { last4: '4242' } } }] },
          lines: {
            data: [{
              id: 'il_1',
              description: 'Pro plan — paid with 4242 4242 4242 4242',
              quantity: 1,
              amount: 4200,
              currency: 'usd',
              period: { start: 1784992010, end: 1787584010 },
              metadata: { note: 'cvv: 123', ref: 'A-1' },
            }],
          },
        },
      },
    };

    const { payload, findings } = sanitizeBillingPayload('stripe', invoiceEvent);
    const p = payload as any;

    // Replay-necessary fields survive.
    expect(p.data.object.amount_due).toBe(4200);
    expect(p.data.object.lines.data[0].id).toBe('il_1');
    expect(p.data.object.lines.data[0].period.start).toBe(1784992010);
    expect(p.data.object.lines.data[0].metadata.ref).toBe('A-1');

    // The charges subtree is gone entirely.
    expect(p.data.object.charges).toBeUndefined();

    // Card data pasted into retained free text is redacted, not stored.
    expect(p.data.object.lines.data[0].description).toContain('Pro plan');
    expect(p.data.object.lines.data[0].description).not.toContain('4242');
    expect(p.data.object.lines.data[0].metadata.note).not.toContain('123');
    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(payload)).not.toContain('4242');
  });
});

describe('sanitizeBillingPayload — paypal', () => {
  const paypalEvent = {
    id: 'WH-1',
    event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
    resource: {
      id: 'I-1',
      custom_id: 'cust-uuid',
      plan_id: 'P-1',
      status: 'ACTIVE',
      start_time: '2026-07-25T00:00:00Z',
      subscriber: {
        payer_id: 'PAYER1',
        email_address: 'payer@example.com',
        shipping_address: { address_line_1: '1 Test St', postal_code: '94105' },
        payment_source: { card: { last_digits: '4242', brand: 'VISA', expiry: '2030-12' } },
      },
      billing_info: {
        next_billing_time: '2026-08-25T00:00:00Z',
        last_payment: { amount: { value: '42.00' }, time: '2026-07-25T00:00:00Z' },
      },
    },
  };

  it('keeps replay fields and drops the payment source and shipping address', () => {
    const { payload } = sanitizeBillingPayload('paypal', paypalEvent);
    const p = payload as any;
    expect(p.id).toBe('WH-1');
    expect(p.event_type).toBe('BILLING.SUBSCRIPTION.ACTIVATED');
    expect(p.resource.id).toBe('I-1');
    expect(p.resource.custom_id).toBe('cust-uuid');
    expect(p.resource.plan_id).toBe('P-1');
    expect(p.resource.billing_info.next_billing_time).toBe('2026-08-25T00:00:00Z');
    // payer_id and email_address are the documented customer-resolution
    // fallbacks the parser reads, so they are necessary and kept.
    expect(p.resource.subscriber.payer_id).toBe('PAYER1');

    expect(p.resource.subscriber.payment_source).toBeUndefined();
    expect(p.resource.subscriber.shipping_address).toBeUndefined();
    expect(p.resource.billing_info.last_payment).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('4242');
    expect(JSON.stringify(payload)).not.toContain('94105');
  });
});

describe('sanitizeBillingPayload — cashfree', () => {
  it('keeps only customer_id from customer_details', () => {
    const cashfreeEvent = {
      event_type: 'SUBSCRIPTION_ACTIVATED',
      event_time: '2026-07-25T00:00:00Z',
      data: {
        subscription: {
          subscription_id: 'sub_cf_1',
          plan_id: 'plan_1',
          subscription_status: 'ACTIVE',
          subscription_first_charge_time: '2026-07-25T00:00:00Z',
          subscription_expiry_time: '2027-07-25T00:00:00Z',
          customer_details: {
            customer_id: 'cf_cust_1',
            customer_email: 'payer@example.com',
            customer_phone: '9999999999',
          },
        },
        payment_method: { card: { card_number: '4242424242424242', card_cvv: '123' } },
      },
    };

    const { payload } = sanitizeBillingPayload('cashfree', cashfreeEvent);
    const p = payload as any;
    expect(p.data.subscription.subscription_id).toBe('sub_cf_1');
    expect(p.data.subscription.customer_details.customer_id).toBe('cf_cust_1');
    expect(p.data.subscription.customer_details.customer_email).toBeUndefined();
    expect(p.data.subscription.customer_details.customer_phone).toBeUndefined();
    expect(p.data.payment_method).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('4242');
    expect(JSON.stringify(payload)).not.toContain('payer@example.com');
  });
});

describe('sanitizeBillingPayload — edge cases', () => {
  it('returns null for an unknown provider so the event is "not replayable"', () => {
    expect(sanitizeBillingPayload('someprovider', { anything: true }).payload).toBe(null);
  });

  it('returns null for null/undefined input', () => {
    expect(sanitizeBillingPayload('stripe', null).payload).toBe(null);
    expect(sanitizeBillingPayload('stripe', undefined).payload).toBe(null);
  });

  it('is idempotent — re-sanitizing a stored payload is a no-op', () => {
    const once = sanitizeBillingPayload('stripe', stripeSubscriptionEvent).payload;
    const twice = sanitizeBillingPayload('stripe', once).payload;
    expect(twice).toEqual(once);
  });

  it('every documented high-risk path is actually dropped', () => {
    for (const { provider, path } of DROPPED_HIGH_RISK_PATHS) {
      // Build a payload carrying a marker at exactly that path.
      const marker = 'SHOULD_NOT_SURVIVE';
      const raw: any = {};
      let cursor = raw;
      path.forEach((seg, i) => {
        cursor[seg] = i === path.length - 1 ? marker : {};
        cursor = cursor[seg];
      });
      const json = JSON.stringify(sanitizeBillingPayload(provider, raw).payload);
      expect(json ?? '').not.toContain(marker);
    }
  });
});
