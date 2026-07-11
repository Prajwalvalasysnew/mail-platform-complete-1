import { describe, it, expect } from 'vitest';
import { applyInvoiceEvent, db, evaluateBillingAccess, seedCustomer } from '@platform/shared';
import { stripeInvoiceEvent } from '@platform/api/routes/billing.js';

describe('billing invoice lifecycle', () => {
  it('parses Stripe invoice payloads with normalized line items', () => {
    const parsed = stripeInvoiceEvent({ id: 'evt_invoice_parse', type: 'invoice.payment_failed', data: { object: {
      id: 'in_parse', customer: 'cus_parse', amount_due: 2500, currency: 'usd', period_start: 1700000000, period_end: 1702592000,
      lines: { data: [{ id: 'il_1', quantity: 25, amount: 2500, currency: 'usd', period: { start: 1700000000, end: 1702592000 } }] },
    } } });
    expect(parsed).toMatchObject({ provider_invoice_id: 'in_parse', amount_cents: 2500, billed_quantity: 25 });
    expect(parsed?.lines).toHaveLength(1);
  });

  it('applies failure idempotently and recovers on payment', async () => {
    const customer = await seedCustomer({ billingStatus: 'active' });
    const providerCustomerId = `cus_invoice_${Date.now()}`;
    await db.updateTable('customers').set({ billing_provider: 'stripe', stripe_customer_id: providerCustomerId }).where('id', '=', customer.customerId).execute();
    const base = {
      provider: 'stripe', provider_customer_id: providerCustomerId, provider_invoice_id: `in_${Date.now()}`,
      amount_cents: 4200, currency: 'usd', period_start: 1700000000, period_end: 1702592000,
      billed_quantity: 42, lines: [{ id: 'line_usage', quantity: 42, amount_cents: 4200, currency: 'usd' }],
    };
    expect(await applyInvoiceEvent({ ...base, provider_event_id: `evt_fail_${Date.now()}`, type: 'invoice.payment_failed' })).toBe(true);
    const duplicateId = `evt_duplicate_${Date.now()}`;
    expect(await applyInvoiceEvent({ ...base, provider_event_id: duplicateId, type: 'invoice.payment_failed' })).toBe(true);
    expect(await applyInvoiceEvent({ ...base, provider_event_id: duplicateId, type: 'invoice.payment_failed' })).toBe(false);
    const invoice = await db.selectFrom('invoices').select(['id', 'status', 'amount_cents', 'billed_quantity']).where('provider_invoice_id', '=', base.provider_invoice_id).executeTakeFirstOrThrow();
    expect(invoice).toMatchObject({ status: 'open', amount_cents: 4200, billed_quantity: 42 });
    expect(await db.selectFrom('invoice_line_items').select('id').where('invoice_id', '=', invoice.id).execute()).toHaveLength(1);
    expect(await evaluateBillingAccess(customer.customerId)).toMatchObject({ allowed: true });

    expect(await applyInvoiceEvent({ ...base, provider_event_id: `evt_paid_${Date.now()}`, type: 'invoice.paid', paid_at: 1701000000 })).toBe(true);
    expect(await db.selectFrom('invoices').select('status').where('id', '=', invoice.id).executeTakeFirstOrThrow()).toMatchObject({ status: 'paid' });
    expect(await db.selectFrom('billing_dunning_state').select('state').where('customer_id', '=', customer.customerId).executeTakeFirstOrThrow()).toMatchObject({ state: 'recovered' });
    expect(await db.selectFrom('customers').select('billing_status').where('id', '=', customer.customerId).executeTakeFirstOrThrow()).toMatchObject({ billing_status: 'active' });
  });
});
