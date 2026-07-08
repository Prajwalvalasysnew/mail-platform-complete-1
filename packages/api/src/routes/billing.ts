import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { applySubscriptionState, TIER_BY_PRICE, isKnownPrice } from '@platform/shared';

/**
 * Provider-keyed billing webhooks. /billing/webhook remains a Stripe-compatible
 * alias; /billing/webhook/:provider lets each provider verify and parse its own
 * event shape.
 */

function timingSafeStringEqual(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Decide whether to accept a webhook for which no signing secret is configured.
 *
 * In development/test this returns true so local flows work without provider
 * secrets. In production it FAILS CLOSED (returns false): accepting unsigned
 * billing webhooks would let anyone who discovers the URL forge "payment
 * succeeded" / subscription-change events. The config guard also *requires* the
 * relevant secret in production, so this is defense-in-depth for the case where
 * the guard is somehow bypassed (e.g. a verifier called from a context that
 * didn't run enforceConfig).
 */
function allowUnsignedWebhook(secretEnvName: string): boolean {
  if (process.env.NODE_ENV === 'production') {
    console.error(`[billing] refusing unsigned webhook: ${secretEnvName} is not set in production`);
    return false;
  }
  return true;
}

function parseStripeSignature(sigHeader: string): Record<string, string> {
  const pairs = sigHeader.split(',').map((p) => {
    const idx = p.indexOf('=');
    if (idx === -1) return null;
    return [p.slice(0, idx).trim(), p.slice(idx + 1).trim()];
  }).filter((x): x is [string, string] => x !== null);
  return Object.fromEntries(pairs);
}

export function verifyStripeSignature(payload: string, sigHeader: string | undefined, secret: string | undefined): boolean {
  if (!secret) return allowUnsignedWebhook('STRIPE_WEBHOOK_SECRET');
  if (!sigHeader) return false;
  const parts = parseStripeSignature(sigHeader);
  if (!parts.t || !parts.v1) return false;
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${payload}`).digest('hex');
  return timingSafeStringEqual(parts.v1, expected);
}

export function verifyPayPalSignature(input: {
  payload: string;
  transmissionId?: string;
  transmissionTime?: string;
  signature?: string;
  secret?: string;
}): boolean {
  if (!input.secret) return allowUnsignedWebhook('PAYPAL_WEBHOOK_SECRET');
  if (!input.transmissionId || !input.transmissionTime || !input.signature) return false;
  const ts = Date.parse(input.transmissionTime);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 300_000) return false;
  const signedPayload = `${input.transmissionId}.${input.transmissionTime}.${input.payload}`;
  const expected = crypto.createHmac('sha256', input.secret).update(signedPayload).digest('base64');
  return timingSafeStringEqual(input.signature, expected);
}

export function verifyCashfreeSignature(input: {
  payload: string;
  timestamp?: string;
  signature?: string;
  secret?: string;
}): boolean {
  if (!input.secret) return allowUnsignedWebhook('CASHFREE_WEBHOOK_SECRET');
  if (!input.timestamp || !input.signature) return false;
  // Cashfree's official examples send x-webhook-timestamp in MILLISECONDS
  // (13 digits, e.g. 1746427759733); some integrations use seconds (10 digits).
  // Accept both — a 10-digit value is seconds, otherwise treat as ms. The raw
  // header string is what gets signed, so we only normalize for freshness.
  const rawTs = Number(input.timestamp);
  if (!Number.isFinite(rawTs)) return false;
  const tsMs = input.timestamp.trim().length <= 10 ? rawTs * 1000 : rawTs;
  if (Math.abs(Date.now() - tsMs) > 300_000) return false;
  const expected = crypto.createHmac('sha256', input.secret).update(input.timestamp + input.payload).digest('base64');
  return timingSafeStringEqual(input.signature, expected);
}

function unixSeconds(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return undefined;
}

export function stripeSubscriptionEvent(event: any) {
  const obj = event?.data?.object ?? {};
  const providerCustomerId = obj.customer;
  if (!providerCustomerId || !event?.id) return null;
  if (
    event.type !== 'customer.subscription.created' &&
    event.type !== 'customer.subscription.updated' &&
    event.type !== 'customer.subscription.deleted'
  ) return null;

  // A subscription may have multiple items (base plan + metered usage). Pick
  // the known plan tier for quota, and the metered item for usage reporting.
  // isKnownPrice resolves real Stripe price ids via STRIPE_PRICE_MAP_JSON (or
  // internal keys directly), so a live "price_1P9x..." id is matched here
  // rather than silently falling through to no tier.
  const items: any[] = obj.items?.data ?? [];
  const tierItem = items.find((it) => it?.price?.id && isKnownPrice(it.price.id));
  const fallbackItem = tierItem ?? items[0];
  const meteredItem = items.find((it) => it?.price?.recurring?.usage_type === 'metered') ?? fallbackItem;

  return {
    provider: 'stripe',
    type: event.type,
    provider_event_id: event.id,
    provider_customer_id: providerCustomerId,
    provider_subscription_id: obj.id,
    subscription_item_id: meteredItem?.id,
    price_id: fallbackItem?.price?.id,
    status: obj.status,
    current_period_start: obj.current_period_start,
    current_period_end: obj.current_period_end,
    cancel_at_period_end: obj.cancel_at_period_end,
  };
}

export function paypalSubscriptionEvent(event: any) {
  const resource = event?.resource ?? {};
  const providerCustomerId = resource.subscriber?.payer_id ?? resource.subscriber?.email_address ?? resource.payer_id;
  if (!providerCustomerId || !event?.id) return null;
  const typeByEvent: Record<string, string> = {
    'BILLING.SUBSCRIPTION.CREATED': 'customer.subscription.created',
    'BILLING.SUBSCRIPTION.ACTIVATED': 'customer.subscription.updated',
    'BILLING.SUBSCRIPTION.UPDATED': 'customer.subscription.updated',
    'BILLING.SUBSCRIPTION.SUSPENDED': 'customer.subscription.updated',
    'BILLING.SUBSCRIPTION.CANCELLED': 'customer.subscription.deleted',
    'BILLING.SUBSCRIPTION.EXPIRED': 'customer.subscription.deleted',
  };
  const mapped = typeByEvent[event.event_type];
  if (!mapped) return null;
  const status = typeof resource.status === 'string' ? resource.status.toLowerCase() : undefined;
  return {
    provider: 'paypal',
    type: mapped,
    provider_event_id: event.id,
    provider_customer_id: providerCustomerId,
    // PayPal assigns a real payer_id at approval time that differs from the
    // synthetic ID stored at subscription creation. custom_id is our internal
    // customer UUID embedded during checkout so the lookup can always succeed.
    internal_customer_id: typeof resource.custom_id === 'string' ? resource.custom_id : undefined,
    provider_subscription_id: resource.id,
    price_id: resource.plan_id,
    status,
    current_period_start: unixSeconds(resource.start_time),
    current_period_end: unixSeconds(resource.billing_info?.next_billing_time),
    cancel_at_period_end: false,
  };
}

export function cashfreeSubscriptionEvent(event: any) {
  const sub = event?.data?.subscription ?? {};
  const providerCustomerId = sub?.customer_details?.customer_id;
  if (!providerCustomerId || !event?.event_type) return null;
  const typeByEvent: Record<string, string> = {
    SUBSCRIPTION_CREATED: 'customer.subscription.created',
    SUBSCRIPTION_ACTIVATED: 'customer.subscription.updated',
    SUBSCRIPTION_PAYMENT_SUCCESS: 'customer.subscription.updated',
    SUBSCRIPTION_PAYMENT_FAILED: 'customer.subscription.updated',
    SUBSCRIPTION_CANCELLED: 'customer.subscription.deleted',
    SUBSCRIPTION_EXPIRED: 'customer.subscription.deleted',
  };
  const mapped = typeByEvent[event.event_type];
  if (!mapped) return null;
  const status = typeof sub.subscription_status === 'string' ? sub.subscription_status.toLowerCase() : undefined;
  const eventKey = `${event.event_type}:${sub.subscription_id}:${event.event_time ?? ''}`;
  return {
    provider: 'cashfree',
    type: mapped,
    provider_event_id: `cf_${crypto.createHash('sha256').update(eventKey).digest('hex').slice(0, 32)}`,
    provider_customer_id: providerCustomerId,
    provider_subscription_id: sub.subscription_id,
    price_id: sub.plan_id,
    status,
    current_period_start: unixSeconds(sub.subscription_first_charge_time),
    current_period_end: unixSeconds(sub.subscription_expiry_time),
    cancel_at_period_end: false,
  };
}

async function handleWebhook(req: FastifyRequest, reply: any, provider: string) {
  const rawBody = req.body as string;

  if (provider === 'stripe') {
    if (!verifyStripeSignature(rawBody, header(req, 'stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET)) {
      return reply.code(400).send({ error: 'invalid_signature' });
    }
  } else if (provider === 'paypal') {
    if (!verifyPayPalSignature({
      payload: rawBody,
      transmissionId: header(req, 'paypal-transmission-id'),
      transmissionTime: header(req, 'paypal-transmission-time'),
      signature: header(req, 'paypal-transmission-sig'),
      secret: process.env.PAYPAL_WEBHOOK_SECRET,
    })) {
      return reply.code(400).send({ error: 'invalid_signature' });
    }
  } else if (provider === 'cashfree') {
    if (!verifyCashfreeSignature({
      payload: rawBody,
      timestamp: header(req, 'x-webhook-timestamp'),
      signature: header(req, 'x-webhook-signature'),
      secret: process.env.CASHFREE_WEBHOOK_SECRET,
    })) {
      return reply.code(400).send({ error: 'invalid_signature' });
    }
  } else {
    return reply.code(400).send({ error: 'unsupported_billing_provider' });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return reply.code(400).send({ error: 'invalid_json' });
  }

  const subEvent = provider === 'stripe' ? stripeSubscriptionEvent(event)
    : provider === 'cashfree' ? cashfreeSubscriptionEvent(event)
    : paypalSubscriptionEvent(event);
  if (!subEvent) return reply.code(200).send({ received: true });

  const applied = await applySubscriptionState(subEvent);
  return reply.code(200).send({ received: true, applied });
}

export const billingRoutes: FastifyPluginAsync = async (app) => {
  // Raw body needed for signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/billing/webhook', async (req, reply) => handleWebhook(req, reply, 'stripe'));

  app.post<{ Params: { provider: string } }>('/billing/webhook/:provider', async (req, reply) => {
    return handleWebhook(req, reply, req.params.provider.toLowerCase());
  });
};
