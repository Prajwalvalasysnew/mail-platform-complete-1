# Billing

Billing has two halves: **outbound** (we tell the provider to create customers,
start checkouts, open the portal, and report metered usage) and **inbound**
(the provider tells us, via webhook, what happened to a subscription).

## Provider Seam

All outbound calls go through a `BillingProvider` (see
`packages/shared/src/billing-provider.ts`). Providers are registered by name and
selected per customer from `customers.billing_provider`:

- **`MockBillingProvider`** (default outside credentialed paths): records calls
  and returns deterministic ids/urls. Lets the entire billing flow run and be
  tested without network or credentials.
- **`StripeBillingProvider`** (when `STRIPE_SECRET_KEY` is set): real Stripe REST
  calls for customers, checkout sessions, billing portal, and usage records.
- **`PayPalBillingProvider`** (when `PAYPAL_CLIENT_ID` and
  `PAYPAL_CLIENT_SECRET` are set): PayPal REST scaffold for subscription
  approval. Configure `PAYPAL_PLAN_MAP_JSON` to map platform price ids such as
  `price_pro` to PayPal plan ids.

Use `registerBillingProvider(name, factory)` and `getBillingProviderFor(name)`
for provider-specific injection. `setBillingProvider()` and
`getBillingProvider()` remain as a back-compat default override for tests and
legacy callers.

## Plan / price mapping (inbound tier resolution)

`TIER_BY_PRICE` (in `packages/shared/src/billing.ts`) maps **internal** plan
keys — `price_free`, `price_starter`, `price_pro`, `price_enterprise` — to the
tier, daily quota, and monthly quota to grant. These keys are NOT the price ids
a real provider sends: a live Stripe subscription event carries a price id like
`price_1P9xAbC...`, which will never equal `price_starter`.

`resolvePlanForPrice(priceId)` / `isKnownPrice(priceId)` bridge that gap. They
resolve a price id to a plan by:
1. direct internal-key hit (self-host / tests / the free-tier default), then
2. an operator-configured `STRIPE_PRICE_MAP_JSON` mapping real provider price
   ids to internal keys.

Set `STRIPE_PRICE_MAP_JSON` in any environment using real Stripe prices, e.g.:

```json
{"price_1P9xAbCStarter":"price_starter","price_1P9xProXyz":"price_pro"}
```

Without this, a live Stripe webhook cannot resolve the tier and the customer's
quota would never be updated. A malformed value is ignored (treated as
unmapped) rather than throwing inside the webhook handler. This mirrors
`PAYPAL_PLAN_MAP_JSON` / `CASHFREE_PLAN_MAP_JSON` for those providers.

## Customer Endpoints

All customer billing endpoints are under `/v1/account/billing` and require the
`billing:manage` capability.

```text
GET  /v1/account/billing
POST /v1/account/billing/checkout   { price_id, success_url, cancel_url } -> { id, url }
POST /v1/account/billing/portal     { return_url } -> { url }
```

The overview returns:

```json
{
  "tier": "free",
  "plan": "free",
  "billing_status": "active",
  "daily_quota": 100,
  "monthly_quota": 3000,
  "has_billing_account": false,
  "billing_provider": "stripe"
}
```

`checkout` lazily provisions a provider customer the first time and persists the
provider customer id on the account. The column is still named
`stripe_customer_id` for backward compatibility, but it now stores the selected
provider's customer reference. Subsequent calls reuse it.

## Plans

`TIER_BY_PRICE` maps provider price ids to a tier and quotas:

| price id | tier | daily | monthly |
| --- | --- | --- | --- |
| `price_free` | free | 100 | 3,000 |
| `price_starter` | paid | 5,000 | 50,000 |
| `price_pro` | paid | 50,000 | 1,000,000 |
| `price_enterprise` | enterprise | 1,000,000 | 50,000,000 |

## Inbound Webhooks

`POST /billing/webhook` remains the Stripe-compatible legacy path. New provider
webhooks should use `POST /billing/webhook/:provider` where `provider` is
`stripe` or `paypal`.

Stripe verifies `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET`. PayPal verifies
`PayPal-Transmission-*` headers with `PAYPAL_WEBHOOK_SECRET` in local/test
deployments; live PayPal certificate/API verification remains a credentialed
deploy-time check.

`applySubscriptionState()` maps subscription lifecycle events to the
`customers` and `subscriptions` tables. It is idempotent: the `billing_events`
table guards replays, so the same event is applied at most once. Subscription
deletion downgrades the account to free. When a Stripe event carries a metered
subscription item id, it is stored on the customer for usage reporting.

## Metered Usage

`reportMeteredUsage({ customerId, usageDate })` reads that day's `delivered`
count from `usage_daily` and reports it to the customer's metered subscription
item via the provider, with an idempotency key of
`usage:{customerId}:{date}`. It no-ops if the customer has no metered item.
Run it from a daily job. `reconcileMetering()` ties metered usage back to
invoices and surfaces drift so revenue leakage is caught.

PayPal does not have a Stripe-style usage-record API for subscriptions, so the
PayPal provider intentionally no-ops `reportUsage()`. Use fixed PayPal tiers or
handle overage outside the provider seam.

## Sending Gates

The send path enforces billing: a `canceled` billing status returns
`402 billing_inactive`, and exceeding the plan quota returns
`429 quota_exceeded`.
