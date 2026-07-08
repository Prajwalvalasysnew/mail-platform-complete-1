// Billing provider seam (outbound).
//
// Same shape as the inference/storage/mailer seams, now with a registry so a
// customer can choose a provider (stripe/paypal/mock) without route changes.
// The mock remains the default outside credentialed environments and providers
// can be injected by tests without network or credentials.

import crypto from 'node:crypto';

export interface BillingProvider {
  readonly name: string;
  createCustomer(input: { email: string; name?: string | null; metadata?: Record<string, string> }): Promise<{ id: string }>;
  createCheckoutSession(input: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
  }): Promise<{ id: string; url: string }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  reportUsage(input: { subscriptionItemId: string; quantity: number; timestamp?: number; idempotencyKey?: string }): Promise<void>;
}

/** Deterministic, network-free provider. Default outside production. */
export class MockBillingProvider implements BillingProvider {
  readonly name: string;
  readonly calls: Array<{ method: string; input: unknown }> = [];

  constructor(name = 'mock') {
    this.name = name;
  }

  private det(prefix: string, seed: string): string {
    const h = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24);
    return `${prefix}_${h}`;
  }

  async createCustomer(input: { email: string; name?: string | null }): Promise<{ id: string }> {
    this.calls.push({ method: 'createCustomer', input });
    return { id: this.det(`cus_${this.name}`, input.email) };
  }
  async createCheckoutSession(input: { customerId: string; priceId: string; successUrl: string; cancelUrl: string }): Promise<{ id: string; url: string }> {
    this.calls.push({ method: 'createCheckoutSession', input });
    const id = this.det(`cs_${this.name}`, input.customerId + input.priceId);
    return { id, url: `https://billing.mock.local/${this.name}/checkout/${id}` };
  }
  async createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    this.calls.push({ method: 'createPortalSession', input });
    const id = this.det(`bps_${this.name}`, input.customerId);
    return { url: `https://billing.mock.local/${this.name}/portal/${id}` };
  }
  async reportUsage(input: { subscriptionItemId: string; quantity: number; timestamp?: number; idempotencyKey?: string }): Promise<void> {
    this.calls.push({ method: 'reportUsage', input });
  }
}

class BillingProviderError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'BillingProviderError';
  }
}

/** Real Stripe provider (REST). Selected when STRIPE_SECRET_KEY is set. */
export class StripeBillingProvider implements BillingProvider {
  readonly name = 'stripe';
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { secretKey: string; baseUrl?: string; fetch?: typeof fetch }) {
    this.secretKey = opts.secretKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.stripe.com').replace(/\/$/, '');
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error('StripeBillingProvider: no fetch available');
    this.fetchImpl = f;
  }

  private form(obj: Record<string, string | number | undefined>): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) p.set(k, String(v));
    return p.toString();
  }

  private async post<T>(path: string, body: string, idempotencyKey?: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) throw new BillingProviderError(res.status, parsed?.error?.message ?? `Stripe error ${res.status}`);
    return parsed as T;
  }

  async createCustomer(input: { email: string; name?: string | null; metadata?: Record<string, string> }): Promise<{ id: string }> {
    const body: Record<string, string> = { email: input.email };
    if (input.name) body.name = input.name;
    for (const [k, v] of Object.entries(input.metadata ?? {})) body[`metadata[${k}]`] = v;
    return this.post('/v1/customers', this.form(body));
  }
  async createCheckoutSession(input: { customerId: string; priceId: string; successUrl: string; cancelUrl: string; metadata?: Record<string, string> }): Promise<{ id: string; url: string }> {
    const body: Record<string, string> = {
      mode: 'subscription',
      customer: input.customerId,
      'line_items[0][price]': input.priceId,
      'line_items[0][quantity]': '1',
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    };
    for (const [k, v] of Object.entries(input.metadata ?? {})) body[`metadata[${k}]`] = v;
    return this.post('/v1/checkout/sessions', this.form(body));
  }
  async createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    return this.post('/v1/billing_portal/sessions', this.form({ customer: input.customerId, return_url: input.returnUrl }));
  }
  async reportUsage(input: { subscriptionItemId: string; quantity: number; timestamp?: number; idempotencyKey?: string }): Promise<void> {
    await this.post(
      `/v1/subscription_items/${encodeURIComponent(input.subscriptionItemId)}/usage_records`,
      this.form({ quantity: input.quantity, timestamp: input.timestamp, action: 'set' }),
      input.idempotencyKey,
    );
  }
}

/**
 * PayPal REST scaffold. PayPal subscriptions do not support Stripe-style usage
 * records, so reportUsage() is intentionally a no-op; deploys that choose
 * PayPal should use fixed tiers or handle overage outside this method.
 */
export class PayPalBillingProvider implements BillingProvider {
  readonly name = 'paypal';
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(opts: { clientId: string; clientSecret: string; baseUrl?: string; fetch?: typeof fetch }) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.baseUrl = (opts.baseUrl ?? 'https://api-m.paypal.com').replace(/\/$/, '');
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error('PayPalBillingProvider: no fetch available');
    this.fetchImpl = f;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) throw new BillingProviderError(res.status, parsed?.error_description ?? `PayPal OAuth error ${res.status}`);
    const expiresIn = Number(parsed.expires_in ?? 300);
    this.token = { value: String(parsed.access_token), expiresAt: Date.now() + expiresIn * 1000 };
    return this.token.value;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) throw new BillingProviderError(res.status, parsed?.message ?? `PayPal error ${res.status}`);
    return parsed as T;
  }

  private planForPrice(priceId: string): string {
    const mapRaw = process.env.PAYPAL_PLAN_MAP_JSON;
    if (mapRaw) {
      const mapped = (JSON.parse(mapRaw) as Record<string, string>)[priceId];
      if (mapped) return mapped;
    }
    if (priceId.startsWith('P-')) return priceId;
    throw new Error(`paypal_plan_not_configured:${priceId}`);
  }

  async createCustomer(input: { email: string; name?: string | null; metadata?: Record<string, string> }): Promise<{ id: string }> {
    // PayPal creates payer identity during approval rather than via a separate
    // customer API. Persist a stable local reference so the rest of the billing
    // flow can stay provider-neutral.
    const h = crypto.createHash('sha256').update(input.email).digest('hex').slice(0, 24);
    return { id: `paypal_payer_${h}` };
  }

  async createCheckoutSession(input: { customerId: string; priceId: string; successUrl: string; cancelUrl: string; metadata?: Record<string, string> }): Promise<{ id: string; url: string }> {
    const subscription = await this.post<any>('/v1/billing/subscriptions', {
      plan_id: this.planForPrice(input.priceId),
      custom_id: input.metadata?.customer_id,
      application_context: {
        brand_name: process.env.PAYPAL_BRAND_NAME ?? 'Mail Platform',
        user_action: 'SUBSCRIBE_NOW',
        return_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
    });
    const approve = (subscription.links ?? []).find((l: any) => l.rel === 'approve')?.href;
    return { id: subscription.id, url: approve ?? `https://www.paypal.com/billing/subscriptions/${subscription.id}` };
  }

  async createPortalSession(_input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    // PayPal has no Stripe-like hosted portal API. This points customers at
    // PayPal's subscription/autopay management surface.
    return { url: process.env.PAYPAL_PORTAL_URL ?? 'https://www.paypal.com/myaccount/autopay/' };
  }

  async reportUsage(input: { subscriptionItemId: string; quantity: number; timestamp?: number; idempotencyKey?: string }): Promise<void> {
    void input;
  }
}

/**
 * Cashfree Subscriptions provider. Cashfree does not support Stripe-style
 * metered usage records; reportUsage() is a no-op. Use fixed-tier plans and
 * set CASHFREE_PLAN_MAP_JSON to map internal price_ids to Cashfree plan_ids.
 */
export class CashfreeBillingProvider implements BillingProvider {
  readonly name = 'cashfree';
  private readonly appId: string;
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { appId: string; secretKey: string; baseUrl?: string; fetch?: typeof fetch }) {
    this.appId = opts.appId;
    this.secretKey = opts.secretKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.cashfree.com').replace(/\/$/, '');
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error('CashfreeBillingProvider: no fetch available');
    this.fetchImpl = f;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'x-client-id': this.appId,
        'x-client-secret': this.secretKey,
        'x-api-version': '2023-08-01',
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) throw new BillingProviderError(res.status, parsed?.message ?? `Cashfree error ${res.status}`);
    return parsed as T;
  }

  private planForPrice(priceId: string): string {
    const mapRaw = process.env.CASHFREE_PLAN_MAP_JSON;
    if (mapRaw) {
      const mapped = (JSON.parse(mapRaw) as Record<string, string>)[priceId];
      if (mapped) return mapped;
    }
    throw new Error(`cashfree_plan_not_configured:${priceId}`);
  }

  async createCustomer(input: { email: string; name?: string | null; metadata?: Record<string, string> }): Promise<{ id: string }> {
    // Cashfree has no standalone customer creation API; identity is captured
    // during subscription authorization. Return a stable local reference.
    const h = crypto.createHash('sha256').update(input.email).digest('hex').slice(0, 24);
    return { id: `cf_cus_${h}` };
  }

  async createCheckoutSession(input: { customerId: string; priceId: string; successUrl: string; cancelUrl: string; metadata?: Record<string, string> }): Promise<{ id: string; url: string }> {
    const subscriptionId = `sub_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const subscription = await this.post<any>('/subscriptions', {
      subscription_id: subscriptionId,
      customer_details: {
        customer_id: input.customerId,
        customer_email: input.metadata?.customer_email ?? '',
        customer_phone: input.metadata?.customer_phone ?? '',
      },
      plan_details: {
        plan_id: this.planForPrice(input.priceId),
      },
      return_url: input.successUrl,
    });
    const url = subscription.payment_link ?? `${this.baseUrl}/subscriptions/${subscription.subscription_id ?? subscriptionId}`;
    return { id: subscription.subscription_id ?? subscriptionId, url };
  }

  async createPortalSession(_input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
    return { url: process.env.CASHFREE_PORTAL_URL ?? 'https://merchant.cashfree.com/' };
  }

  async reportUsage(input: { subscriptionItemId: string; quantity: number; timestamp?: number; idempotencyKey?: string }): Promise<void> {
    void input;
  }
}

export type BillingProviderFactory = () => BillingProvider;

let provider: BillingProvider | null = null;
const factories = new Map<string, BillingProviderFactory>();
const providerCache = new Map<string, BillingProvider>();

function normalizeProviderName(name: string): string {
  const n = name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(n)) throw new Error(`invalid_billing_provider:${name}`);
  return n;
}

function defaultFactory(name: string): BillingProviderFactory | null {
  if (name === 'mock') return () => new MockBillingProvider('mock');
  if (name === 'stripe') {
    return () => (process.env.STRIPE_SECRET_KEY
      ? new StripeBillingProvider({ secretKey: process.env.STRIPE_SECRET_KEY! })
      : new MockBillingProvider('stripe'));
  }
  if (name === 'paypal') {
    return () => (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET
      ? new PayPalBillingProvider({ clientId: process.env.PAYPAL_CLIENT_ID!, clientSecret: process.env.PAYPAL_CLIENT_SECRET! })
      : new MockBillingProvider('paypal'));
  }
  if (name === 'cashfree') {
    return () => (process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET_KEY
      ? new CashfreeBillingProvider({ appId: process.env.CASHFREE_APP_ID!, secretKey: process.env.CASHFREE_SECRET_KEY! })
      : new MockBillingProvider('cashfree'));
  }
  return null;
}

export function registerBillingProvider(name: string, factory: BillingProviderFactory): void {
  const n = normalizeProviderName(name);
  factories.set(n, factory);
  providerCache.delete(n);
}

export function getBillingProviderFor(name: string): BillingProvider {
  if (provider) return provider; // Back-compat override used by existing tests.
  const n = normalizeProviderName(name);
  const cached = providerCache.get(n);
  if (cached) return cached;
  const factory = factories.get(n) ?? defaultFactory(n);
  if (!factory) throw new Error(`unknown_billing_provider:${n}`);
  const p = factory();
  providerCache.set(n, p);
  return p;
}

export function getBillingProvider(): BillingProvider {
  if (provider) return provider;
  const defaultName = process.env.BILLING_PROVIDER ?? (process.env.STRIPE_SECRET_KEY ? 'stripe' : 'mock');
  return getBillingProviderFor(defaultName);
}

export function setBillingProvider(p: BillingProvider | null): void {
  provider = p;
  providerCache.clear();
}
