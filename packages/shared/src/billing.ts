// Billing lifecycle + metering reconciliation.
//
// The webhook route handles provider events idempotently (billing_events table
// guards replays). This module owns:
//   - applySubscriptionState(): map a provider subscription event to our
//     customers + subscriptions tables (create/update/cancel, proration-safe).
//   - reconcileMetering(): tie usage_daily (what we metered) to invoices (what
//     we billed) and surface drift, so revenue leakage is caught.
//   - checkQuotaThresholds(): emit 80%/100% notifications once per period.

import { sql } from 'kysely';
import { db } from './db.js';
import { getBillingProviderFor } from './billing-provider.js';

export const TIER_BY_PRICE: Record<string, { tier: 'free' | 'paid' | 'enterprise'; daily: number; monthly: number; plan: string }> = {
  price_free: { tier: 'free', daily: 100, monthly: 3000, plan: 'free' },
  price_starter: { tier: 'paid', daily: 5000, monthly: 50000, plan: 'starter' },
  price_pro: { tier: 'paid', daily: 50000, monthly: 1000000, plan: 'pro' },
  price_enterprise: { tier: 'enterprise', daily: 1000000, monthly: 50000000, plan: 'enterprise' },
};

// The keys of TIER_BY_PRICE (price_free, price_starter, …) are INTERNAL plan
// identifiers, not the price IDs a real payment provider sends. A live Stripe
// subscription event carries a price id like "price_1P9xAbC...", which will
// never equal "price_starter". Without a mapping, the webhook can't resolve the
// tier and the customer's quota is never updated.
//
// resolvePlanForPrice() bridges that: it maps a provider price id to a
// TIER_BY_PRICE entry using an env-configured map, and falls back to treating
// the id as an internal key directly (so tests and self-hosted setups that use
// the literal internal keys keep working). This mirrors the existing
// PAYPAL_PLAN_MAP_JSON / CASHFREE_PLAN_MAP_JSON pattern in billing-provider.ts,
// giving Stripe the same operator-configurable mapping the other providers have.
//
// STRIPE_PRICE_MAP_JSON example:
//   {"price_1P9xAbCStarter":"price_starter","price_1P9xProXyz":"price_pro"}
export function resolvePlanForPrice(
  priceId: string | undefined | null
): { tier: 'free' | 'paid' | 'enterprise'; daily: number; monthly: number; plan: string } | undefined {
  if (!priceId) return undefined;
  // 1. Direct internal-key hit (tests, self-host, and the free-tier default).
  if (TIER_BY_PRICE[priceId]) return TIER_BY_PRICE[priceId];
  // 2. Operator-configured provider-id -> internal-key map.
  const mapRaw = process.env.STRIPE_PRICE_MAP_JSON;
  if (mapRaw) {
    try {
      const internalKey = (JSON.parse(mapRaw) as Record<string, string>)[priceId];
      if (internalKey && TIER_BY_PRICE[internalKey]) return TIER_BY_PRICE[internalKey];
    } catch {
      // Malformed map env — treat as unmapped rather than throwing inside a
      // webhook handler (a bad env var shouldn't 500 every billing event).
    }
  }
  return undefined;
}

/** True when a price id resolves to a known plan (real provider id or internal key). */
export function isKnownPrice(priceId: string | undefined | null): boolean {
  return resolvePlanForPrice(priceId) !== undefined;
}

export interface SubscriptionEvent {
  type: string;
  provider?: string;
  provider_event_id: string;
  provider_customer_id?: string;
  stripe_customer_id?: string;
  /** Internal customer UUID — used as a fallback lookup when provider_customer_id doesn't match. */
  internal_customer_id?: string;
  provider_subscription_id?: string;
  subscription_item_id?: string;
  price_id?: string;
  status?: string;
  current_period_start?: number; // unix seconds
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  /**
   * The raw provider event payload, persisted on billing_events so the admin
   * replay tool can re-run it. Optional: callers that don't supply it (older
   * call sites, internal synthetic events) simply store null and the event is
   * reported as "not replayable".
   */
  raw_payload?: unknown;
}

const VALID_STATUS = ['active', 'past_due', 'canceled', 'trialing', 'incomplete', 'unpaid'];

/**
 * Idempotently process a subscription lifecycle event. Returns false if the
 * event was already processed (replay), true if newly applied.
 */
export async function applySubscriptionState(ev: SubscriptionEvent): Promise<boolean> {
  const provider = ev.provider ?? 'stripe';
  const providerCustomerId = ev.provider_customer_id ?? ev.stripe_customer_id;

  return db.transaction().execute(async (trx) => {
    // Replay protection. This insert and every state mutation below now
    // commit or roll back together: previously the marker was a standalone
    // statement, so a crash/exception after it committed but before the
    // customer/subscription rows were updated left the event permanently
    // marked "processed" with no state change ever applied — a provider
    // retry would see the conflict and bail out via `return false` without
    // ever repairing the missed update.
    const dup = await trx
      .insertInto('billing_events')
      .values({
        provider_event_id: ev.provider_event_id,
        type: ev.type,
        provider,
        // Store the raw payload (JSONB) so an operator can replay this exact
        // event later. null when the caller didn't provide it.
        payload: ev.raw_payload !== undefined ? (ev.raw_payload as any) : null,
      })
      .onConflict((oc) => oc.column('provider_event_id').doNothing())
      .returning('provider_event_id')
      .executeTakeFirst();
    if (!dup) return false; // already processed (and fully applied, since it's now atomic)

    let customer = providerCustomerId ? await trx
      .selectFrom('customers')
      .select('id')
      .where('stripe_customer_id', '=', providerCustomerId)
      .where('billing_provider', '=', provider as any)
      .executeTakeFirst() : undefined;
    if (!customer && providerCustomerId) {
      // Back-compat for rows created before billing_provider existed.
      customer = await trx.selectFrom('customers').select('id').where('stripe_customer_id', '=', providerCustomerId).executeTakeFirst();
    }
    if (!customer && ev.internal_customer_id) {
      // Providers like PayPal assign their own payer_id at approval time (different
      // from the synthetic ID stored at subscription creation). Look up by the
      // internal customer UUID we embedded as custom_id in the checkout request.
      customer = await trx.selectFrom('customers').select('id').where('id', '=', ev.internal_customer_id).executeTakeFirst();
    }
    if (!customer) return true; // unknown customer; event consumed but nothing to do

    const status = ev.status && VALID_STATUS.includes(ev.status) ? ev.status : 'active';

    if (ev.type === 'customer.subscription.deleted') {
      const free = TIER_BY_PRICE['price_free']!;
      await trx.updateTable('customers').set({ tier: free.tier, daily_quota: free.daily, monthly_quota: free.monthly, billing_status: 'canceled' }).where('id', '=', customer.id).execute();
      await trx.updateTable('subscriptions').set({ status: 'canceled' }).where('customer_id', '=', customer.id).execute();
      return true;
    }

    const plan = resolvePlanForPrice(ev.price_id);

    await trx
      .insertInto('subscriptions')
        .values({
          customer_id: customer.id,
        provider,
        provider_subscription_id: ev.provider_subscription_id ?? null,
        price_id: ev.price_id ?? null,
        plan: plan?.plan ?? 'free',
        status: status as any,
        current_period_start: ev.current_period_start ? new Date(ev.current_period_start * 1000) : null,
        current_period_end: ev.current_period_end ? new Date(ev.current_period_end * 1000) : null,
        cancel_at_period_end: ev.cancel_at_period_end ?? false,
      })
      .onConflict((oc) =>
        oc.column('provider_subscription_id').doUpdateSet({
          price_id: ev.price_id ?? null,
          plan: plan?.plan ?? 'free',
          status: status as any,
          current_period_start: ev.current_period_start ? new Date(ev.current_period_start * 1000) : null,
          current_period_end: ev.current_period_end ? new Date(ev.current_period_end * 1000) : null,
          cancel_at_period_end: ev.cancel_at_period_end ?? false,
          updated_at: new Date(),
        })
      )
      .execute();

    if (plan) {
      const billingStatus = ['active', 'past_due', 'canceled', 'trialing'].includes(status) ? status : 'active';
      await trx
        .updateTable('customers')
        .set({
          tier: plan.tier,
          daily_quota: plan.daily,
          monthly_quota: plan.monthly,
          billing_status: billingStatus as any,
          ...(ev.subscription_item_id ? { stripe_subscription_item_id: ev.subscription_item_id } : {}),
        })
        .where('id', '=', customer.id)
        .execute();
    }
    return true;
  });
}

export interface MeteringDrift {
  totalDrift: number;
  byCustomer: Array<{ customer_id: string; metered: number; billed: number; drift: number }>;
}

/**
 * Reconcile current-month metered usage (usage_daily.sent) against billed
 * quantities on invoices for the same period. Persists the drift onto the
 * latest open invoice per customer and returns the aggregate.
 */
export async function reconcileMetering(): Promise<MeteringDrift> {
  const metered = await db
    .selectFrom('usage_daily')
    .select(['customer_id', db.fn.sum<number>('sent').as('metered')])
    .where(sql<boolean>`date_trunc('month', usage_date) = date_trunc('month', CURRENT_DATE)`)
    .groupBy('customer_id')
    .execute();

  const byCustomer: MeteringDrift['byCustomer'] = [];
  let total = 0;
  for (const m of metered) {
    const meteredN = Number(m.metered ?? 0);
    const inv = await db
      .selectFrom('invoices')
      .select(['id', 'billed_quantity'])
      .where('customer_id', '=', m.customer_id)
      .where(sql<boolean>`date_trunc('month', period_start) = date_trunc('month', CURRENT_DATE)`)
      .orderBy('period_start', 'desc')
      .executeTakeFirst();
    const billed = Number(inv?.billed_quantity ?? 0);
    const drift = meteredN - billed;
    if (inv) {
      await db.updateTable('invoices').set({ metered_quantity: meteredN, drift }).where('id', '=', inv.id).execute();
    }
    if (drift !== 0) {
      byCustomer.push({ customer_id: m.customer_id, metered: meteredN, billed, drift });
      total += drift;
    }
  }
  return { totalDrift: total, byCustomer };
}

/**
 * Check daily+monthly quota thresholds and return any newly-crossed ones,
 * recording them so each (period, threshold) only alerts once.
 */
export async function checkQuotaThresholds(
  customerId: string,
  dailyUsed: number,
  dailyLimit: number,
  monthlyUsed: number,
  monthlyLimit: number
): Promise<Array<{ scope: 'daily' | 'monthly'; threshold: number }>> {
  const crossed: Array<{ scope: 'daily' | 'monthly'; threshold: number }> = [];
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);

  const checks: Array<{ scope: 'daily' | 'monthly'; period: string; pct: number }> = [
    { scope: 'daily', period: today, pct: dailyLimit > 0 ? dailyUsed / dailyLimit : 0 },
    { scope: 'monthly', period: month, pct: monthlyLimit > 0 ? monthlyUsed / monthlyLimit : 0 },
  ];

  for (const c of checks) {
    for (const threshold of [100, 80]) {
      if (c.pct * 100 >= threshold) {
        const inserted = await db
          .insertInto('quota_notifications')
          .values({ customer_id: customerId, period: c.period, threshold })
          .onConflict((oc) => oc.columns(['customer_id', 'period', 'threshold']).doNothing())
          .returning('threshold')
          .executeTakeFirst();
        if (inserted) crossed.push({ scope: c.scope, threshold });
        break; // only the highest crossed threshold per scope
      }
    }
  }
  return crossed;
}

// ---------------------------------------------------------------------------
// Outbound billing: customer provisioning, checkout, portal, metered usage.
// These wrap the BillingProvider seam (mock by default, Stripe in prod).
// ---------------------------------------------------------------------------

/**
 * Return the customer's provider customer id, creating and persisting
 * it on first use. Idempotent and race-safe (re-checks after creating).
 */
async function ensureBillingCustomerContext(customerId: string): Promise<{ providerName: string; providerCustomerId: string; email: string }> {
  const c = await db
    .selectFrom('customers')
    .select(['id', 'email', 'name', 'stripe_customer_id', 'billing_provider'])
    .where('id', '=', customerId)
    .executeTakeFirst();
  if (!c) throw new Error('customer_not_found');
  const providerName = c.billing_provider ?? 'stripe';
  if (c.stripe_customer_id) return { providerName, providerCustomerId: c.stripe_customer_id, email: c.email };

  const provider = getBillingProviderFor(providerName);
  const created = await provider.createCustomer({ email: c.email, name: c.name, metadata: { customer_id: c.id } });

  // Persist only if still unset (another request may have raced us).
  const updated = await db
    .updateTable('customers')
    .set({ stripe_customer_id: created.id })
    .where('id', '=', customerId)
    .where('stripe_customer_id', 'is', null)
    .returning('stripe_customer_id')
    .executeTakeFirst();
  if (updated?.stripe_customer_id) return { providerName, providerCustomerId: updated.stripe_customer_id, email: c.email };

  // Lost the race: return whatever is now stored.
  const reread = await db.selectFrom('customers').select('stripe_customer_id').where('id', '=', customerId).executeTakeFirstOrThrow();
  return { providerName, providerCustomerId: reread.stripe_customer_id ?? created.id, email: c.email };
}

export async function ensureBillingCustomer(customerId: string): Promise<string> {
  return (await ensureBillingCustomerContext(customerId)).providerCustomerId;
}

export async function startCheckout(input: { customerId: string; priceId: string; successUrl: string; cancelUrl: string }): Promise<{ id: string; url: string }> {
  const { providerName, providerCustomerId, email } = await ensureBillingCustomerContext(input.customerId);
  return getBillingProviderFor(providerName).createCheckoutSession({
    customerId: providerCustomerId,
    priceId: input.priceId,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    metadata: { customer_id: input.customerId, customer_email: email },
  });
}

export async function startBillingPortal(input: { customerId: string; returnUrl: string }): Promise<{ url: string }> {
  const { providerName, providerCustomerId } = await ensureBillingCustomerContext(input.customerId);
  return getBillingProviderFor(providerName).createPortalSession({ customerId: providerCustomerId, returnUrl: input.returnUrl });
}

export interface BillingOverview {
  tier: string;
  plan: string;
  billing_status: string;
  daily_quota: number;
  monthly_quota: number;
  has_billing_account: boolean;
  billing_provider: string;
}

export async function getBillingOverview(customerId: string): Promise<BillingOverview | null> {
  const c = await db
    .selectFrom('customers')
    .select(['tier', 'billing_status', 'daily_quota', 'monthly_quota', 'stripe_customer_id', 'billing_provider'])
    .where('id', '=', customerId)
    .executeTakeFirst();
  if (!c) return null;
  const plan = Object.values(TIER_BY_PRICE).find((p) => p.tier === c.tier && p.daily === c.daily_quota)?.plan ?? c.tier;
  return {
    tier: c.tier,
    plan,
    billing_status: c.billing_status,
    daily_quota: c.daily_quota,
    monthly_quota: c.monthly_quota,
    has_billing_account: !!c.stripe_customer_id,
    billing_provider: c.billing_provider ?? 'stripe',
  };
}

/**
 * Report a customer's metered usage (delivered emails) for a day to the billing
 * provider. Requires a known metered subscription item id (stored on the
 * customer once their subscription is created). Returns the quantity reported,
 * or null if there's nothing to report / no metered item.
 */
export async function reportMeteredUsage(input: { customerId: string; usageDate: string }): Promise<number | null> {
  const c = await db
    .selectFrom('customers')
    .select(['stripe_subscription_item_id', 'billing_provider'])
    .where('id', '=', input.customerId)
    .executeTakeFirst();
  if (!c?.stripe_subscription_item_id) return null;

  const usage = await db
    .selectFrom('usage_daily')
    .select(['delivered'])
    .where('customer_id', '=', input.customerId)
    .where('usage_date', '=', input.usageDate as any)
    .executeTakeFirst();
  const quantity = Number(usage?.delivered ?? 0);

  await getBillingProviderFor(c.billing_provider ?? 'stripe').reportUsage({
    subscriptionItemId: c.stripe_subscription_item_id,
    quantity,
    timestamp: Math.floor(new Date(input.usageDate + 'T00:00:00Z').getTime() / 1000),
    idempotencyKey: `usage:${input.customerId}:${input.usageDate}`,
  });
  return quantity;
}

// ─── Billing event replay (admin tooling) ────────────────────────────────────
// Gap analysis 2.3.2: "Event retention/replay tooling limited. Add billing
// event replay admin tool." billing_events now persists the raw provider
// payload (035_billing_event_payload.sql), so an operator can inspect and
// re-run a specific event — useful when a subscription change was mis-applied
// or dropped, or to recover from a bug that has since been fixed.

export interface BillingEventSummary {
  provider_event_id: string;
  type: string;
  provider: string | null;
  processed_at: Date;
  replayed_at: Date | null;
  replay_count: number;
  replayable: boolean; // true when a raw payload is stored
}

/** List billing events newest-first, for the admin console. */
export async function listBillingEvents(opts: { limit?: number; before?: string } = {}): Promise<BillingEventSummary[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  let q = db
    .selectFrom('billing_events')
    .select(['provider_event_id', 'type', 'provider', 'processed_at', 'replayed_at', 'replay_count', 'payload'])
    .orderBy('processed_at', 'desc')
    .limit(limit);
  if (opts.before) q = q.where('processed_at', '<', opts.before as any);
  const rows = await q.execute();
  return rows.map((r) => ({
    provider_event_id: r.provider_event_id,
    type: r.type,
    provider: r.provider,
    processed_at: r.processed_at as unknown as Date,
    replayed_at: (r.replayed_at as unknown as Date) ?? null,
    replay_count: Number(r.replay_count ?? 0),
    replayable: r.payload != null,
  }));
}

/** Fetch a single billing event, including its stored raw payload. */
export async function getBillingEvent(providerEventId: string): Promise<
  (BillingEventSummary & { payload: unknown | null }) | null
> {
  const r = await db
    .selectFrom('billing_events')
    .select(['provider_event_id', 'type', 'provider', 'processed_at', 'replayed_at', 'replay_count', 'payload'])
    .where('provider_event_id', '=', providerEventId)
    .executeTakeFirst();
  if (!r) return null;
  return {
    provider_event_id: r.provider_event_id,
    type: r.type,
    provider: r.provider,
    processed_at: r.processed_at as unknown as Date,
    replayed_at: (r.replayed_at as unknown as Date) ?? null,
    replay_count: Number(r.replay_count ?? 0),
    replayable: r.payload != null,
    payload: r.payload ?? null,
  };
}

/**
 * Re-apply a stored subscription event, bypassing the idempotency guard (a
 * replay is an intentional re-run). The caller supplies the re-parsed
 * SubscriptionEvent (parsers live in the API route), plus the original
 * provider_event_id so we can record the replay. Reuses the same state-mutation
 * logic as first-time processing by writing directly rather than going through
 * the dedupe insert.
 *
 * Returns { applied: boolean } — false only when the customer can't be resolved.
 */
export async function replayBillingEvent(providerEventId: string): Promise<
  { status: 'not_found' } | { status: 'not_replayable' } | { status: 'replayed'; applied: boolean }
> {
  const stored = await getBillingEvent(providerEventId);
  if (!stored) return { status: 'not_found' };
  if (!stored.replayable || stored.payload == null) return { status: 'not_replayable' };

  // Bump replay bookkeeping. The actual re-parse + re-apply is done by the
  // caller (API route) which owns the provider-specific parsers; this function
  // is invoked AFTER a successful re-apply to record it. See the admin route.
  await db
    .updateTable('billing_events')
    .set({ replayed_at: new Date(), replay_count: (stored.replay_count ?? 0) + 1 })
    .where('provider_event_id', '=', providerEventId)
    .execute();
  return { status: 'replayed', applied: true };
}
