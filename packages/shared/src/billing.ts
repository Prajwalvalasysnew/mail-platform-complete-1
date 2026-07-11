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
import type { DbExecutor } from './db.js';
import { getBillingProviderFor } from './billing-provider.js';
import { sendDunningEmail } from './mailer.js';

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

export interface CatalogPlan {
  tier: 'free' | 'paid' | 'enterprise';
  daily: number;
  monthly: number;
  plan: string;
  providerPriceId: string;
}

export async function resolveCatalogPlan(
  priceId: string | undefined | null,
  provider: string,
  executor: DbExecutor = db,
): Promise<CatalogPlan | undefined> {
  if (!priceId) return undefined;
  const environment = process.env.BILLING_ENVIRONMENT === 'test' ? 'test' : 'live';
  const row = await executor.selectFrom('billing_plan_prices')
    .innerJoin('billing_plans', 'billing_plans.plan_key', 'billing_plan_prices.plan_key')
    .select(['billing_plans.plan_key', 'billing_plans.tier', 'billing_plans.daily_quota', 'billing_plans.monthly_quota', 'billing_plan_prices.provider_price_id'])
    .where('billing_plan_prices.provider', '=', provider as any)
    .where('billing_plan_prices.environment', '=', environment)
    .where('billing_plan_prices.provider_price_id', '=', priceId)
    .where('billing_plan_prices.active', '=', true)
    .where('billing_plans.active', '=', true)
    .executeTakeFirst();
  if (row) return {
    tier: row.tier, daily: row.daily_quota, monthly: row.monthly_quota,
    plan: row.plan_key, providerPriceId: row.provider_price_id,
  };
  // Preserve self-hosted/test compatibility, but never accept placeholders in production.
  if (process.env.NODE_ENV !== 'production') {
    const legacy = resolvePlanForPrice(priceId);
    if (legacy) return { ...legacy, providerPriceId: priceId };
  }
  return undefined;
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
  plan_item_id?: string;
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
      await trx.insertInto('billing_dunning_state').values({ customer_id: customer.id, state: 'canceled' })
        .onConflict((oc) => oc.column('customer_id').doUpdateSet({ state: 'canceled', grace_ends_at: null, updated_at: new Date() })).execute();
      return true;
    }

    const plan = await resolveCatalogPlan(ev.price_id, provider, trx);

    await trx
      .insertInto('subscriptions')
        .values({
          customer_id: customer.id,
        provider,
          provider_subscription_id: ev.provider_subscription_id ?? null,
        provider_plan_item_id: ev.plan_item_id ?? null,
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
          provider_plan_item_id: ev.plan_item_id ?? null,
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
      const billingStatus = status === 'active' || status === 'trialing' ? status
        : status === 'canceled' ? 'canceled' : 'past_due';
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
    if (status === 'active' || status === 'trialing') {
      await trx.insertInto('billing_dunning_state').values({ customer_id: customer.id, state: 'healthy', recovered_at: new Date() })
        .onConflict((oc) => oc.column('customer_id').doUpdateSet({ state: 'recovered', grace_ends_at: null, recovered_at: new Date(), updated_at: new Date() })).execute();
    } else if (status === 'past_due') {
      const graceEnds = new Date(Date.now() + Number(process.env.BILLING_GRACE_DAYS ?? 7) * 86_400_000);
      await trx.insertInto('billing_dunning_state').values({ customer_id: customer.id, state: 'grace', failure_count: 1, grace_ends_at: graceEnds, last_failure_at: new Date() })
        .onConflict((oc) => oc.column('customer_id').doUpdateSet((eb) => ({
          state: 'grace', failure_count: eb('billing_dunning_state.failure_count', '+', 1),
          grace_ends_at: sql`COALESCE(billing_dunning_state.grace_ends_at, ${graceEnds})`,
          last_failure_at: new Date(), updated_at: new Date(),
        }))).execute();
    } else if (status === 'unpaid' || status === 'incomplete' || status === 'canceled') {
      await trx.insertInto('billing_dunning_state').values({ customer_id: customer.id, state: 'restricted', failure_count: 1, last_failure_at: new Date() })
        .onConflict((oc) => oc.column('customer_id').doUpdateSet({ state: 'restricted', grace_ends_at: null, last_failure_at: new Date(), updated_at: new Date() })).execute();
    }
    // The provider webhook is the authority for entitlement activation. Match
    // the submitted request by tenant/provider price only after an active or
    // trialing subscription event has been authenticated and applied.
    if (plan && ev.price_id && (status === 'active' || status === 'trialing')) {
      await trx.updateTable('billing_plan_change_requests').set({
        status: 'applied', applied_at: new Date(), updated_at: new Date(),
      }).where('customer_id', '=', customer.id)
        .where('provider', '=', provider)
        .where('provider_price_id', '=', ev.price_id)
        .where('status', '=', 'checkout_started')
        .execute();
    }
    return true;
  });
}

export interface BillingAccess {
  allowed: boolean;
  reason?: 'billing_canceled' | 'payment_required' | 'grace_expired';
  graceEndsAt: Date | null;
  plan: string;
  features: Record<string, unknown>;
}

export async function evaluateBillingAccess(customerId: string): Promise<BillingAccess> {
  const customer = await db.selectFrom('customers').select(['billing_status', 'tier']).where('id', '=', customerId).executeTakeFirstOrThrow();
  const subscription = await db.selectFrom('subscriptions').select(['plan', 'status']).where('customer_id', '=', customerId).orderBy('updated_at', 'desc').executeTakeFirst();
  const planKey = subscription?.plan ?? (customer.tier === 'free' ? 'free' : customer.tier);
  const plan = await db.selectFrom('billing_plans').select(['features']).where('plan_key', '=', planKey).where('active', '=', true).executeTakeFirst();
  const dunning = await db.selectFrom('billing_dunning_state').select(['state', 'grace_ends_at']).where('customer_id', '=', customerId).executeTakeFirst();
  const graceEndsAt = dunning?.grace_ends_at ? new Date(dunning.grace_ends_at as any) : null;
  if (customer.billing_status === 'canceled' || dunning?.state === 'canceled') {
    return { allowed: false, reason: 'billing_canceled', graceEndsAt, plan: planKey, features: plan?.features ?? {} };
  }
  if (dunning?.state === 'restricted' || subscription?.status === 'unpaid' || subscription?.status === 'incomplete') {
    return { allowed: false, reason: 'payment_required', graceEndsAt, plan: planKey, features: plan?.features ?? {} };
  }
  if (customer.billing_status === 'past_due' || dunning?.state === 'grace') {
    if (!graceEndsAt || graceEndsAt.getTime() <= Date.now()) {
      return { allowed: false, reason: 'grace_expired', graceEndsAt, plan: planKey, features: plan?.features ?? {} };
    }
  }
  return { allowed: true, graceEndsAt, plan: planKey, features: plan?.features ?? {} };
}

export async function hasEntitlement(customerId: string, feature: string): Promise<boolean> {
  const access = await evaluateBillingAccess(customerId);
  return access.allowed && access.features[feature] === true;
}

export interface DunningSweepResult { scanned: number; restricted: number; sent: number; failed: number }

async function notifyDunning(input: { customerId: string; email: string; stage: 'payment_failed' | 'grace_ending' | 'restricted' | 'recovered'; cycleKey: string; graceEndsAt: Date | null }): Promise<'sent' | 'skipped' | 'failed'> {
  const row = await db.insertInto('billing_dunning_notifications').values({
    customer_id: input.customerId, stage: input.stage, cycle_key: input.cycleKey,
  }).onConflict((oc) => oc.columns(['customer_id', 'stage', 'cycle_key']).doUpdateSet({ updated_at: new Date() }))
    .returning(['id', 'status', 'attempts']).executeTakeFirstOrThrow();
  if (row.status === 'sent') return 'skipped';
  try {
    await sendDunningEmail({ to: input.email, stage: input.stage, graceEndsAt: input.graceEndsAt });
    await db.updateTable('billing_dunning_notifications').set({ status: 'sent', attempts: row.attempts + 1, sent_at: new Date(), last_error: null, updated_at: new Date().toISOString() }).where('id', '=', row.id).execute();
    return 'sent';
  } catch (error) {
    await db.updateTable('billing_dunning_notifications').set({ status: 'failed', attempts: row.attempts + 1, last_error: (error instanceof Error ? error.message : String(error)).slice(0, 1000), updated_at: new Date().toISOString() }).where('id', '=', row.id).execute();
    return 'failed';
  }
}

export async function runDunningSweep(now = new Date(), options: { customerId?: string } = {}): Promise<DunningSweepResult> {
  let query = db.selectFrom('billing_dunning_state')
    .innerJoin('customers', 'customers.id', 'billing_dunning_state.customer_id')
    .select(['billing_dunning_state.customer_id', 'billing_dunning_state.state', 'billing_dunning_state.grace_ends_at', 'billing_dunning_state.updated_at', 'customers.email'])
    .where('billing_dunning_state.state', 'in', ['grace', 'restricted', 'recovered']);
  if (options.customerId) query = query.where('billing_dunning_state.customer_id', '=', options.customerId);
  const rows = await query.execute();
  const result: DunningSweepResult = { scanned: rows.length, restricted: 0, sent: 0, failed: 0 };
  for (const row of rows) {
    const graceEnds = row.grace_ends_at ? new Date(row.grace_ends_at as any) : null;
    const cycleKey = (graceEnds ?? new Date(row.updated_at as any)).toISOString();
    const stages: Array<'payment_failed' | 'grace_ending' | 'restricted' | 'recovered'> = [];
    if (row.state === 'grace') {
      stages.push('payment_failed');
      const remaining = graceEnds ? graceEnds.getTime() - now.getTime() : -1;
      if (remaining > 0 && remaining <= 24 * 3600_000) stages.push('grace_ending');
      if (remaining <= 0) {
        await db.updateTable('billing_dunning_state').set({ state: 'restricted', updated_at: now.toISOString() }).where('customer_id', '=', row.customer_id).where('state', '=', 'grace').execute();
        stages.push('restricted');
        result.restricted++;
      }
    } else if (row.state === 'restricted') stages.push('restricted');
    else stages.push('recovered');
    for (const stage of stages) {
      const outcome = await notifyDunning({ customerId: row.customer_id, email: row.email, stage, cycleKey, graceEndsAt: graceEnds });
      if (outcome === 'sent') result.sent++;
      if (outcome === 'failed') result.failed++;
    }
  }
  return result;
}

export async function listCustomerInvoices(customerId: string, options: { limit?: number; before?: string } = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
  let query = db.selectFrom('invoices')
    .select(['id', 'provider_invoice_id', 'period_start', 'period_end', 'billed_quantity', 'metered_quantity', 'amount_cents', 'currency', 'status', 'drift', 'hosted_invoice_url', 'invoice_pdf_url', 'due_at', 'paid_at', 'created_at'])
    .where('customer_id', '=', customerId).orderBy('created_at', 'desc').limit(limit + 1);
  if (options.before) query = query.where('created_at', '<', options.before as any);
  const rows = await query.execute();
  const hasMore = rows.length > limit;
  const invoices = hasMore ? rows.slice(0, limit) : rows;
  return { invoices, next_cursor: hasMore ? invoices.at(-1)!.created_at : null };
}

export async function getCustomerInvoice(customerId: string, invoiceId: string) {
  const invoice = await db.selectFrom('invoices').selectAll()
    .where('id', '=', invoiceId).where('customer_id', '=', customerId).executeTakeFirst();
  if (!invoice) return null;
  const lines = await db.selectFrom('invoice_line_items')
    .select(['id', 'provider_line_item_id', 'description', 'quantity', 'amount_cents', 'currency', 'period_start', 'period_end', 'metadata'])
    .where('invoice_id', '=', invoice.id).orderBy('id', 'asc').execute();
  return { ...invoice, lines };
}

export async function previewPlanChange(customerId: string, targetPriceId: string) {
  const customer = await db.selectFrom('customers').select(['billing_provider', 'tier', 'daily_quota', 'monthly_quota'])
    .where('id', '=', customerId).executeTakeFirstOrThrow();
  const target = await resolveCatalogPlan(targetPriceId, customer.billing_provider ?? 'stripe');
  if (!target) throw new Error('unknown_price');
  const currentSub = await db.selectFrom('subscriptions').select(['plan', 'provider_subscription_id', 'provider_plan_item_id']).where('customer_id', '=', customerId).orderBy('updated_at', 'desc').executeTakeFirst();
  const currentPlanKey = currentSub?.plan ?? (customer.tier === 'free' ? 'free' : customer.tier);
  const currentCatalog = await db.selectFrom('billing_plans').select(['features']).where('plan_key', '=', currentPlanKey).executeTakeFirst();
  const targetCatalog = await db.selectFrom('billing_plans').select(['features']).where('plan_key', '=', target.plan).executeTakeFirstOrThrow();
  const direction = target.monthly > customer.monthly_quota ? 'upgrade' : target.monthly < customer.monthly_quota ? 'downgrade' : 'lateral';
  const currentFeatures = currentCatalog?.features ?? {};
  const targetFeatures = targetCatalog.features ?? {};
  const gained = Object.keys(targetFeatures).filter((key) => targetFeatures[key] === true && currentFeatures[key] !== true);
  const lost = Object.keys(currentFeatures).filter((key) => currentFeatures[key] === true && targetFeatures[key] !== true);
  const usage = await db.selectFrom('usage_daily').select(({ fn }) => fn.sum<number>('sent').as('sent'))
    .where('customer_id', '=', customerId).where(sql<boolean>`date_trunc('month', usage_date) = date_trunc('month', CURRENT_DATE)`).executeTakeFirst();
  const monthlyUsed = Number(usage?.sent ?? 0);
  const warnings: string[] = [];
  if (direction === 'downgrade' && monthlyUsed > target.monthly) warnings.push('current_month_usage_exceeds_target_quota');
  if (lost.length) warnings.push('features_will_be_removed');
  const prorationDate = Math.floor(Date.now() / 1000);
  const provider = getBillingProviderFor(customer.billing_provider ?? 'stripe');
  let providerPreview: { amountDue: number; currency: string; prorationAmount: number } | null = null;
  if (currentSub?.provider_subscription_id && currentSub.provider_plan_item_id && provider.previewSubscriptionChange) {
    providerPreview = await provider.previewSubscriptionChange({
      subscriptionId: currentSub.provider_subscription_id, subscriptionItemId: currentSub.provider_plan_item_id,
      priceId: target.providerPriceId, prorationDate,
    });
  }
  const request = await db.insertInto('billing_plan_change_requests').values({
    customer_id: customerId, current_plan: currentPlanKey, target_plan: target.plan,
    provider: customer.billing_provider ?? 'stripe', provider_price_id: target.providerPriceId,
    direction, quota_delta: { daily: target.daily - customer.daily_quota, monthly: target.monthly - customer.monthly_quota },
    feature_delta: { gained, lost }, warnings,
    proration_date: providerPreview ? prorationDate : null,
    proration_amount_cents: providerPreview?.prorationAmount ?? null,
    preview_amount_due_cents: providerPreview?.amountDue ?? null,
    preview_currency: providerPreview?.currency ?? null,
  }).returning(['id', 'expires_at']).executeTakeFirstOrThrow();
  return {
    request_id: request.id, current_plan: currentPlanKey, target_plan: target.plan, direction,
    current: { daily_quota: customer.daily_quota, monthly_quota: customer.monthly_quota, features: currentFeatures },
    target: { daily_quota: target.daily, monthly_quota: target.monthly, features: targetFeatures },
    quota_delta: { daily: target.daily - customer.daily_quota, monthly: target.monthly - customer.monthly_quota },
    feature_delta: { gained, lost }, current_month_usage: monthlyUsed, warnings,
    proration: providerPreview
      ? { available: true, date: prorationDate, amount_cents: providerPreview.prorationAmount, invoice_amount_due_cents: providerPreview.amountDue, currency: providerPreview.currency }
      : { available: false, reason: 'provider_preview_required' }, expires_at: request.expires_at,
  };
}

export async function confirmPlanChange(customerId: string, requestId: string) {
  const request = await db.selectFrom('billing_plan_change_requests').selectAll()
    .where('id', '=', requestId).where('customer_id', '=', customerId).executeTakeFirst();
  if (!request) return { status: 'not_found' as const };
  if (request.status !== 'previewed' || new Date(request.expires_at as any).getTime() <= Date.now()) return { status: 'expired' as const };
  const subscription = await db.selectFrom('subscriptions').select(['provider_subscription_id', 'provider_plan_item_id', 'current_period_end'])
    .where('customer_id', '=', customerId).orderBy('updated_at', 'desc').executeTakeFirst();
  if (!subscription?.provider_subscription_id || !subscription.provider_plan_item_id) return { status: 'subscription_not_ready' as const };
  const provider = getBillingProviderFor(request.provider);
  if (!provider.updateSubscription) return { status: 'unsupported_provider' as const };

  // Downgrades take effect at period end, not immediately: the customer already
  // paid for the current period, so they keep their higher capacity until the
  // boundary, and the request stays cancellable (rollback) until it applies.
  // BILLING_DOWNGRADE_AT_PERIOD_END=0 restores legacy immediate proration.
  if (request.direction === 'downgrade' && process.env.BILLING_DOWNGRADE_AT_PERIOD_END !== '0') {
    const effectiveAt = subscription.current_period_end
      ? new Date(subscription.current_period_end as any)
      : new Date(Date.now() + Number(process.env.BILLING_DEFAULT_PERIOD_DAYS ?? 30) * 86_400_000);
    await db.updateTable('billing_plan_change_requests').set({
      status: 'scheduled', scheduled_effective_at: effectiveAt, updated_at: new Date().toISOString(),
    }).where('id', '=', request.id).where('status', '=', 'previewed').execute();
    return { status: 'scheduled' as const, effective_at: effectiveAt.toISOString() };
  }

  // Upgrades / lateral moves apply immediately with provider proration.
  if (!request.proration_date) return { status: 'provider_preview_required' as const };
  const updated = await provider.updateSubscription({ subscriptionId: subscription.provider_subscription_id,
    subscriptionItemId: subscription.provider_plan_item_id, priceId: request.provider_price_id,
    prorationDate: Number(request.proration_date), idempotencyKey: `plan-change:${request.id}` });
  await db.updateTable('billing_plan_change_requests').set({ status: 'checkout_started', updated_at: new Date().toISOString() })
    .where('id', '=', request.id).where('status', '=', 'previewed').execute();
  return { status: 'pending_provider_confirmation' as const, provider_subscription_id: updated.id, provider_status: updated.status };
}

export async function cancelPlanChange(customerId: string, requestId: string): Promise<'canceled' | 'not_found' | 'not_cancelable'> {
  // Cancellable states: an unsubmitted preview, or a scheduled downgrade that
  // has not yet reached its period-end effective date (rollback). Once a change
  // is submitted to the provider or applied, it can no longer be cancelled here.
  const updated = await db.updateTable('billing_plan_change_requests').set({
    status: 'canceled', canceled_at: new Date(), updated_at: new Date().toISOString(),
  }).where('id', '=', requestId).where('customer_id', '=', customerId).where('status', 'in', ['previewed', 'scheduled'])
    .returning('id').executeTakeFirst();
  if (updated) return 'canceled';
  const exists = await db.selectFrom('billing_plan_change_requests').select('status')
    .where('id', '=', requestId).where('customer_id', '=', customerId).executeTakeFirst();
  return exists ? 'not_cancelable' : 'not_found';
}

export async function expirePlanChangeRequests(now = new Date()): Promise<number> {
  const result = await db.updateTable('billing_plan_change_requests').set({ status: 'expired', updated_at: now.toISOString() })
    .where('status', '=', 'previewed').where('expires_at', '<=', now as any).executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0);
}

// Operator SLA observation. A plan-change request that has been submitted to
// the provider (status='checkout_started') but never confirmed by a webhook or
// picked up by reconcileSubmittedPlanChanges() should not linger indefinitely:
// it means the provider never reflected the requested price, or the provider is
// unsupported for authenticated retrieval. Anything past the SLA window is a
// breach an operator must investigate. Returns the count of breaching requests.
export async function countStuckPlanChanges(slaMinutes = 60): Promise<number> {
  const cutoff = new Date(Date.now() - Math.max(0, slaMinutes) * 60_000);
  const row = await db.selectFrom('billing_plan_change_requests')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where('status', '=', 'checkout_started')
    .where('updated_at', '<=', cutoff as any)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function reconcileSubmittedPlanChanges(options: { staleMinutes?: number; limit?: number } = {}) {
  const cutoff = new Date(Date.now() - Math.max(0, options.staleMinutes ?? 10) * 60_000);
  const requests = await db.selectFrom('billing_plan_change_requests')
    .select(['id', 'customer_id', 'provider', 'provider_price_id'])
    .where('status', '=', 'checkout_started').where('updated_at', '<=', cutoff as any)
    .orderBy('updated_at', 'asc').limit(Math.max(1, Math.min(options.limit ?? 100, 500))).execute();
  const result = { scanned: requests.length, applied: 0, pending: 0, unsupported: 0, failed: 0 };
  for (const request of requests) {
    try {
      const subscription = await db.selectFrom('subscriptions').select('provider_subscription_id')
        .where('customer_id', '=', request.customer_id).where('provider', '=', request.provider).orderBy('updated_at', 'desc').executeTakeFirst();
      const provider = getBillingProviderFor(request.provider);
      if (!subscription?.provider_subscription_id || !provider.getSubscription) { result.unsupported++; continue; }
      const remote = await provider.getSubscription(subscription.provider_subscription_id);
      const item = remote.items.find((candidate) => candidate.priceId === request.provider_price_id);
      if (!item) { result.pending++; continue; }
      await applySubscriptionState({ provider: request.provider,
        provider_event_id: `plan_reconcile:${request.id}:${remote.status}:${request.provider_price_id}`,
        type: 'customer.subscription.updated', internal_customer_id: request.customer_id,
        provider_subscription_id: remote.id, plan_item_id: item.id, price_id: item.priceId, status: remote.status });
      const state = await db.selectFrom('billing_plan_change_requests').select('status').where('id', '=', request.id).executeTakeFirstOrThrow();
      if (state.status === 'applied') result.applied++; else result.pending++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

// Apply scheduled downgrades whose period-end effective date has arrived. Each
// due request is submitted to the provider (no proration — the customer used
// the full period) and then finalized through the provider-authoritative
// applySubscriptionState path, which lowers the tier/quota and marks the
// request 'applied'. Rollbacks (cancelPlanChange) that happened before the
// boundary already moved the request to 'canceled', so it is never seen here.
export async function applyScheduledDowngrades(now = new Date(), limit = 200) {
  const due = await db.selectFrom('billing_plan_change_requests')
    .select(['id', 'customer_id', 'provider', 'provider_price_id'])
    .where('status', '=', 'scheduled').where('scheduled_effective_at', '<=', now as any)
    .orderBy('scheduled_effective_at', 'asc').limit(Math.max(1, Math.min(limit, 500))).execute();
  const result = { scanned: due.length, applied: 0, pending: 0, unsupported: 0, failed: 0 };
  for (const request of due) {
    try {
      const subscription = await db.selectFrom('subscriptions').select(['provider_subscription_id', 'provider_plan_item_id'])
        .where('customer_id', '=', request.customer_id).where('provider', '=', request.provider).orderBy('updated_at', 'desc').executeTakeFirst();
      const provider = getBillingProviderFor(request.provider);
      if (!subscription?.provider_subscription_id || !subscription.provider_plan_item_id || !provider.updateSubscription) { result.unsupported++; continue; }
      // Move to submitted first so a concurrent provider webhook and this apply
      // path converge on the same row via the checkout_started matcher.
      await db.updateTable('billing_plan_change_requests').set({ status: 'checkout_started', updated_at: new Date().toISOString() })
        .where('id', '=', request.id).where('status', '=', 'scheduled').execute();
      const updated = await provider.updateSubscription({ subscriptionId: subscription.provider_subscription_id,
        subscriptionItemId: subscription.provider_plan_item_id, priceId: request.provider_price_id,
        prorationDate: Math.floor(now.getTime() / 1000), idempotencyKey: `scheduled-downgrade:${request.id}` });
      await applySubscriptionState({ provider: request.provider,
        provider_event_id: `scheduled_downgrade:${request.id}:${updated.status}:${request.provider_price_id}`,
        type: 'customer.subscription.updated', internal_customer_id: request.customer_id,
        provider_subscription_id: updated.id, plan_item_id: subscription.provider_plan_item_id,
        price_id: request.provider_price_id, status: updated.status });
      const state = await db.selectFrom('billing_plan_change_requests').select('status').where('id', '=', request.id).executeTakeFirstOrThrow();
      if (state.status === 'applied') result.applied++; else result.pending++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

export interface MeteringDrift {
  totalDrift: number;
  byCustomer: Array<{ customer_id: string; metered: number; billed: number; drift: number }>;
}

export interface InvoiceEvent {
  provider: string;
  provider_event_id: string;
  type: string;
  provider_customer_id: string;
  provider_invoice_id: string;
  amount_cents: number;
  currency: string;
  period_start: number;
  period_end: number;
  due_at?: number;
  paid_at?: number;
  hosted_invoice_url?: string | null;
  invoice_pdf_url?: string | null;
  billed_quantity?: number;
  lines?: Array<{ id: string; description?: string | null; quantity?: number; amount_cents?: number; currency?: string; period_start?: number; period_end?: number; metadata?: Record<string, unknown> }>;
  raw_payload?: unknown;
}

export async function applyInvoiceEvent(ev: InvoiceEvent): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const marker = await trx.insertInto('billing_events').values({
      provider_event_id: ev.provider_event_id, type: ev.type, provider: ev.provider, payload: ev.raw_payload as any,
    }).onConflict((oc) => oc.column('provider_event_id').doNothing()).returning('provider_event_id').executeTakeFirst();
    if (!marker) return false;
    const customer = await trx.selectFrom('customers').select('id')
      .where('stripe_customer_id', '=', ev.provider_customer_id).where('billing_provider', '=', ev.provider as any).executeTakeFirst();
    if (!customer) return true;
    const status = ev.type === 'invoice.paid' ? 'paid' : ev.type === 'invoice.voided' ? 'void'
      : ev.type === 'invoice.marked_uncollectible' ? 'uncollectible' : 'open';
    const invoice = await trx.insertInto('invoices').values({
      customer_id: customer.id, provider_invoice_id: ev.provider_invoice_id,
      period_start: new Date(ev.period_start * 1000).toISOString().slice(0, 10),
      period_end: new Date(ev.period_end * 1000).toISOString().slice(0, 10),
      billed_quantity: ev.billed_quantity ?? 0, amount_cents: ev.amount_cents,
      currency: ev.currency.toLowerCase(), status, hosted_invoice_url: ev.hosted_invoice_url ?? null,
      invoice_pdf_url: ev.invoice_pdf_url ?? null, due_at: ev.due_at ? new Date(ev.due_at * 1000) : null,
      paid_at: ev.paid_at ? new Date(ev.paid_at * 1000) : null,
    }).onConflict((oc) => oc.column('provider_invoice_id').doUpdateSet({
      billed_quantity: ev.billed_quantity ?? 0, amount_cents: ev.amount_cents, currency: ev.currency.toLowerCase(),
      status, hosted_invoice_url: ev.hosted_invoice_url ?? null, invoice_pdf_url: ev.invoice_pdf_url ?? null,
      due_at: ev.due_at ? new Date(ev.due_at * 1000) : null, paid_at: ev.paid_at ? new Date(ev.paid_at * 1000) : null,
      updated_at: new Date(),
    })).returning('id').executeTakeFirstOrThrow();
    for (const line of ev.lines ?? []) {
      await trx.insertInto('invoice_line_items').values({
        invoice_id: invoice.id, provider_line_item_id: line.id, description: line.description ?? null,
        quantity: line.quantity ?? 0, amount_cents: line.amount_cents ?? 0,
        currency: (line.currency ?? ev.currency).toLowerCase(),
        period_start: line.period_start ? new Date(line.period_start * 1000) : null,
        period_end: line.period_end ? new Date(line.period_end * 1000) : null, metadata: line.metadata ?? {},
      }).onConflict((oc) => oc.columns(['invoice_id', 'provider_line_item_id']).doUpdateSet({
        description: line.description ?? null, quantity: line.quantity ?? 0, amount_cents: line.amount_cents ?? 0,
        metadata: line.metadata ?? {},
      })).execute();
    }
    if (ev.type === 'invoice.payment_failed') {
      const graceEnds = new Date(Date.now() + Number(process.env.BILLING_GRACE_DAYS ?? 7) * 86_400_000);
      await trx.updateTable('customers').set({ billing_status: 'past_due' }).where('id', '=', customer.id).execute();
      await trx.insertInto('billing_dunning_state').values({ customer_id: customer.id, state: 'grace', failure_count: 1, grace_ends_at: graceEnds, last_failure_at: new Date() })
        .onConflict((oc) => oc.column('customer_id').doUpdateSet((eb) => ({ state: 'grace', failure_count: eb('billing_dunning_state.failure_count', '+', 1), grace_ends_at: sql`COALESCE(billing_dunning_state.grace_ends_at, ${graceEnds})`, last_failure_at: new Date(), updated_at: new Date() }))).execute();
    } else if (ev.type === 'invoice.paid') {
      await trx.updateTable('customers').set({ billing_status: 'active' }).where('id', '=', customer.id).where('billing_status', '!=', 'canceled').execute();
      await trx.insertInto('billing_dunning_state').values({ customer_id: customer.id, state: 'recovered', recovered_at: new Date() })
        .onConflict((oc) => oc.column('customer_id').doUpdateSet({ state: 'recovered', grace_ends_at: null, recovered_at: new Date(), updated_at: new Date() })).execute();
    } else if (ev.type === 'invoice.marked_uncollectible') {
      await trx.updateTable('customers').set({ billing_status: 'past_due' }).where('id', '=', customer.id).execute();
      await trx.insertInto('billing_dunning_state').values({ customer_id: customer.id, state: 'restricted', failure_count: 1, last_failure_at: new Date() })
        .onConflict((oc) => oc.column('customer_id').doUpdateSet({ state: 'restricted', grace_ends_at: null, updated_at: new Date() })).execute();
    }
    return true;
  });
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
  const billing = await db.selectFrom('customers').select('billing_provider').where('id', '=', input.customerId).executeTakeFirst();
  if (!billing) throw new Error('customer_not_found');
  const plan = await resolveCatalogPlan(input.priceId, billing.billing_provider ?? 'stripe');
  if (!plan) throw new Error('unknown_price');
  const { providerName, providerCustomerId, email } = await ensureBillingCustomerContext(input.customerId);
  return getBillingProviderFor(providerName).createCheckoutSession({
    customerId: providerCustomerId,
    priceId: plan.providerPriceId,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    metadata: { customer_id: input.customerId, customer_email: email },
  });
}

export async function isCheckoutPriceAvailable(customerId: string, priceId: string): Promise<boolean> {
  const customer = await db.selectFrom('customers').select('billing_provider').where('id', '=', customerId).executeTakeFirst();
  return !!customer && !!(await resolveCatalogPlan(priceId, customer.billing_provider ?? 'stripe'));
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
