import { describe, it, expect } from 'vitest';
import { applyInvoiceEvent, applyCreditNoteEvent, listCustomerCreditNotes, db, evaluateBillingAccess, seedCustomer } from '@platform/shared';
import { stripeInvoiceEvent, stripeCreditNoteEvent } from '@platform/api/routes/billing.js';

describe('billing invoice lifecycle', () => {
  it('parses Stripe invoice payloads with normalized line items', () => {
    const parsed = stripeInvoiceEvent({ id: 'evt_invoice_parse', type: 'invoice.payment_failed', data: { object: {
      id: 'in_parse', customer: 'cus_parse', amount_due: 2500, tax: 400, currency: 'usd', period_start: 1700000000, period_end: 1702592000,
      lines: { data: [{ id: 'il_1', quantity: 25, amount: 2500, currency: 'usd', period: { start: 1700000000, end: 1702592000 } }] },
    } } });
    expect(parsed).toMatchObject({ provider_invoice_id: 'in_parse', amount_cents: 2500, tax_cents: 400, billed_quantity: 25 });
    expect(parsed?.lines).toHaveLength(1);
  });

  it('falls back to total_tax_amounts when the aggregate tax field is absent', () => {
    const parsed = stripeInvoiceEvent({ id: 'evt_invoice_tax_sum', type: 'invoice.paid', data: { object: {
      id: 'in_tax_sum', customer: 'cus_tax', amount_due: 3300, currency: 'eur', period_start: 1700000000, period_end: 1702592000,
      total_tax_amounts: [{ amount: 200 }, { amount: 100 }],
      lines: { data: [{ id: 'il_1', quantity: 30, amount: 3000, currency: 'eur' }] },
    } } });
    expect(parsed).toMatchObject({ tax_cents: 300, currency: 'eur' });
  });

  it('persists tax on the stored invoice', async () => {
    const customer = await seedCustomer({ billingStatus: 'active' });
    const providerCustomerId = `cus_tax_${Date.now()}`;
    await db.updateTable('customers').set({ billing_provider: 'stripe', stripe_customer_id: providerCustomerId }).where('id', '=', customer.customerId).execute();
    const invoiceId = `in_tax_${Date.now()}`;
    expect(await applyInvoiceEvent({ provider: 'stripe', provider_event_id: `evt_tax_${Date.now()}`, type: 'invoice.paid',
      provider_customer_id: providerCustomerId, provider_invoice_id: invoiceId, amount_cents: 5400, tax_cents: 900,
      currency: 'usd', period_start: 1700000000, period_end: 1702592000, billed_quantity: 45 })).toBe(true);
    expect(await db.selectFrom('invoices').select(['amount_cents', 'tax_cents']).where('provider_invoice_id', '=', invoiceId).executeTakeFirstOrThrow())
      .toMatchObject({ amount_cents: 5400, tax_cents: 900 });
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

describe('credit notes / refunds', () => {
  it('parses a Stripe credit_note payload', () => {
    const parsed = stripeCreditNoteEvent({ id: 'evt_cn_parse', type: 'credit_note.created', data: { object: {
      id: 'cn_1', customer: 'cus_cn', invoice: 'in_cn', number: 'CN-001', total: 1500, currency: 'usd', reason: 'duplicate', memo: 'refund',
    } } });
    expect(parsed).toMatchObject({ provider_credit_note_id: 'cn_1', provider_invoice_id: 'in_cn', amount_cents: 1500, reason: 'duplicate' });
    expect(stripeCreditNoteEvent({ id: 'x', type: 'invoice.paid', data: { object: {} } })).toBeNull();
  });

  it('records a credit note, links it to the invoice, and is idempotent', async () => {
    const customer = await seedCustomer({ billingStatus: 'active' });
    const providerCustomerId = `cus_cn_${Date.now()}`;
    await db.updateTable('customers').set({ billing_provider: 'stripe', stripe_customer_id: providerCustomerId }).where('id', '=', customer.customerId).execute();
    const invoiceId = `in_cn_${Date.now()}`;
    await applyInvoiceEvent({ provider: 'stripe', provider_event_id: `evt_cninv_${Date.now()}`, type: 'invoice.paid',
      provider_customer_id: providerCustomerId, provider_invoice_id: invoiceId, amount_cents: 5000, currency: 'usd',
      period_start: 1700000000, period_end: 1702592000, billed_quantity: 50 });
    const cnId = `cn_${Date.now()}`;
    const base = { provider: 'stripe', type: 'credit_note.created', provider_customer_id: providerCustomerId,
      provider_credit_note_id: cnId, provider_invoice_id: invoiceId, amount_cents: 1500, currency: 'usd', reason: 'duplicate' } as const;
    expect(await applyCreditNoteEvent({ ...base, provider_event_id: `evt_cn_${Date.now()}` })).toBe(true);
    const dupEvent = `evt_cn_dup_${Date.now()}`;
    expect(await applyCreditNoteEvent({ ...base, provider_event_id: dupEvent })).toBe(true);
    expect(await applyCreditNoteEvent({ ...base, provider_event_id: dupEvent })).toBe(false); // replay

    const localInvoice = await db.selectFrom('invoices').select('id').where('provider_invoice_id', '=', invoiceId).executeTakeFirstOrThrow();
    const listed = await listCustomerCreditNotes(customer.customerId);
    const note = listed.credit_notes.find((n) => n.provider_credit_note_id === cnId);
    expect(note).toMatchObject({ amount_cents: 1500, status: 'issued', reason: 'duplicate', invoice_id: localInvoice.id });
    // Only one row despite the duplicate event (unique on provider_credit_note_id).
    expect(await db.selectFrom('credit_notes').select('id').where('provider_credit_note_id', '=', cnId).execute()).toHaveLength(1);
  });

  it('voids a credit note on credit_note.voided', async () => {
    const customer = await seedCustomer({ billingStatus: 'active' });
    const providerCustomerId = `cus_cnv_${Date.now()}`;
    await db.updateTable('customers').set({ billing_provider: 'stripe', stripe_customer_id: providerCustomerId }).where('id', '=', customer.customerId).execute();
    const cnId = `cn_void_${Date.now()}`;
    await applyCreditNoteEvent({ provider: 'stripe', provider_event_id: `evt_cnv1_${Date.now()}`, type: 'credit_note.created',
      provider_customer_id: providerCustomerId, provider_credit_note_id: cnId, amount_cents: 800, currency: 'usd' });
    await applyCreditNoteEvent({ provider: 'stripe', provider_event_id: `evt_cnv2_${Date.now()}`, type: 'credit_note.voided',
      provider_customer_id: providerCustomerId, provider_credit_note_id: cnId, amount_cents: 800, currency: 'usd' });
    expect(await db.selectFrom('credit_notes').select('status').where('provider_credit_note_id', '=', cnId).executeTakeFirstOrThrow()).toMatchObject({ status: 'void' });
  });
});
