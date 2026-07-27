// PCI-03 (compliance implementation plan): billing webhook payload allowlist.
//
// billing_events.payload exists so an operator can replay a mis-applied or
// dropped provider event (035_billing_event_payload.sql). Storing the WHOLE
// provider event to get that is more retention than the job needs: a Stripe
// invoice event carries charges[], payment_intent, and payment_method_details
// (card brand, last4, expiry, issuing country, and the billing address);
// Cashfree carries customer_details with the payer's email and phone. None of
// that is read on replay, but all of it lands in the primary database, its
// replicas, and every backup image taken afterwards.
//
// So persistence goes through an ALLOWLIST, not a denylist. The shapes below
// enumerate exactly the fields the replay parsers read
// (stripeSubscriptionEvent / stripeInvoiceEvent / stripeCreditNoteEvent /
// paypalSubscriptionEvent / cashfreeSubscriptionEvent in
// packages/api/src/routes/billing.ts). Anything a provider adds later is
// dropped by default rather than silently retained — the failure mode of a
// missed allowlist entry is "an operator must re-fetch the event from the
// provider to replay it", which is strictly safer than retaining card data.
//
// Free-text fields that MUST be kept for replay (invoice line descriptions,
// credit-note memos, line metadata) are additionally run through the PCI-02
// card-data redactor, because those fields are customer-controlled and are a
// realistic place for a pasted card number to arrive.

import { redactCardData, type CardFinding } from './card-data.js';

export type BillingPayloadProvider = 'stripe' | 'paypal' | 'cashfree';

/**
 * `true`      keep the scalar (or whole array of scalars) as-is
 * `'text'`    keep, but redact card data from the string
 * `'textmap'` keep an object of arbitrary keys, redacting card data in values
 * `{...}`     recurse into these object keys
 * `each(s)`   apply shape `s` to every element of an array
 */
type Shape = true | 'text' | 'textmap' | { [key: string]: Shape } | EachShape;
interface EachShape { __each: Shape }

function each(shape: Shape): EachShape {
  return { __each: shape };
}
function isEach(shape: Shape): shape is EachShape {
  return typeof shape === 'object' && shape !== null && '__each' in shape;
}

// Stripe delivers subscription, invoice, and credit-note events with the same
// envelope (id/type/data.object), so one shape covers all three; keys that only
// apply to one event kind are simply absent from the others.
const STRIPE: Shape = {
  id: true,
  type: true,
  created: true,
  data: {
    object: {
      // Common envelope
      id: true,
      customer: true,
      currency: true,
      status: true,
      created: true,

      // customer.subscription.*
      current_period_start: true,
      current_period_end: true,
      cancel_at_period_end: true,
      items: { data: each({ id: true, price: { id: true, recurring: { usage_type: true } } }) },

      // invoice.*
      amount_due: true,
      total: true,
      tax: true,
      total_tax_amounts: each({ amount: true }),
      period_start: true,
      period_end: true,
      due_date: true,
      status_transitions: { paid_at: true },
      hosted_invoice_url: true,
      invoice_pdf: true,
      lines: {
        data: each({
          id: true,
          description: 'text',
          quantity: true,
          amount: true,
          currency: true,
          period: { start: true, end: true },
          metadata: 'textmap',
        }),
      },

      // credit_note.*
      invoice: true,
      number: true,
      amount: true,
      reason: true,
      memo: 'text',
    },
  },
};

const PAYPAL: Shape = {
  id: true,
  event_type: true,
  resource: {
    id: true,
    custom_id: true,
    plan_id: true,
    status: true,
    start_time: true,
    payer_id: true,
    // payer_id is preferred; email_address is the documented fallback the
    // parser uses to resolve the customer, so it is necessary for replay.
    subscriber: { payer_id: true, email_address: true },
    billing_info: { next_billing_time: true },
  },
};

const CASHFREE: Shape = {
  event_type: true,
  event_time: true,
  data: {
    subscription: {
      subscription_id: true,
      plan_id: true,
      subscription_status: true,
      subscription_first_charge_time: true,
      subscription_expiry_time: true,
      // customer_id only. The sibling customer_email / customer_phone fields
      // are not read on replay and are dropped.
      customer_details: { customer_id: true },
    },
  },
};

const SHAPES: Record<BillingPayloadProvider, Shape> = { stripe: STRIPE, paypal: PAYPAL, cashfree: CASHFREE };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function applyShape(value: unknown, shape: Shape, path: string, findings: CardFinding[]): unknown {
  if (value === null || value === undefined) return value;

  if (shape === true) return value;

  if (shape === 'text') {
    if (typeof value !== 'string') return value;
    const r = redactCardData(value, path);
    findings.push(...r.findings);
    return r.text;
  }

  if (shape === 'textmap') {
    if (!isPlainObject(value)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string') {
        const r = redactCardData(v, `${path}.${k}`);
        findings.push(...r.findings);
        out[k] = r.text;
      } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
        out[k] = v;
      }
      // Nested structures inside free-form metadata are dropped: they are not
      // read on replay and are unbounded in shape.
    }
    return out;
  }

  if (isEach(shape)) {
    if (!Array.isArray(value)) return undefined;
    return value.map((item, i) => applyShape(item, shape.__each, `${path}[${i}]`, findings));
  }

  // Object shape: keep only the enumerated keys.
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, childShape] of Object.entries(shape)) {
    if (!(key in value)) continue;
    const kept = applyShape(value[key], childShape, path ? `${path}.${key}` : key, findings);
    if (kept !== undefined) out[key] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface SanitizedBillingPayload {
  /** The allowlisted payload, or null when nothing survived (unknown shape). */
  payload: unknown | null;
  /** Card-data hits found in retained free-text fields. Carries no digits. */
  findings: CardFinding[];
}

/**
 * Reduce a raw provider event to the fields the replay parsers actually read.
 *
 * An unknown provider yields a null payload: the event is still recorded for
 * idempotency, and the admin API reports it as "not replayable" — the same,
 * already-handled state as a pre-035 row.
 */
export function sanitizeBillingPayload(
  provider: string | null | undefined,
  raw: unknown,
): SanitizedBillingPayload {
  const findings: CardFinding[] = [];
  if (raw === null || raw === undefined) return { payload: null, findings };

  const shape = SHAPES[(provider ?? 'stripe') as BillingPayloadProvider];
  if (!shape) return { payload: null, findings };

  const payload = applyShape(raw, shape, '', findings);
  return { payload: payload === undefined ? null : payload, findings };
}

/**
 * Field paths the allowlist deliberately drops, used by the PCI-03 regression
 * test and the migration that scrubs rows written before this control existed.
 * Each entry is a jsonb path into the stored payload.
 */
export const DROPPED_HIGH_RISK_PATHS: Array<{ provider: BillingPayloadProvider; path: string[] }> = [
  { provider: 'stripe', path: ['data', 'object', 'charges'] },
  { provider: 'stripe', path: ['data', 'object', 'payment_intent'] },
  { provider: 'stripe', path: ['data', 'object', 'payment_method_details'] },
  { provider: 'stripe', path: ['data', 'object', 'default_payment_method'] },
  { provider: 'stripe', path: ['data', 'object', 'customer_details'] },
  { provider: 'stripe', path: ['data', 'object', 'payment_settings'] },
  { provider: 'stripe', path: ['data', 'object', 'last_payment_error'] },
  { provider: 'paypal', path: ['resource', 'billing_info', 'last_payment'] },
  { provider: 'paypal', path: ['resource', 'subscriber', 'shipping_address'] },
  { provider: 'paypal', path: ['resource', 'subscriber', 'payment_source'] },
  { provider: 'cashfree', path: ['data', 'payment_method'] },
  { provider: 'cashfree', path: ['data', 'subscription', 'customer_details', 'customer_email'] },
  { provider: 'cashfree', path: ['data', 'subscription', 'customer_details', 'customer_phone'] },
];
