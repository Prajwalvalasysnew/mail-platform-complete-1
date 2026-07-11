# Billing event replay (gap analysis 2.3.2 idempotency row)

## The gap

The report scored billing-webhook idempotency 8.0 with: "Event retention/replay
tooling limited. Add billing event replay admin tool." Root cause: the
`billing_events` table stored only `(provider_event_id, type, processed_at)` —
enough to DEDUPE (never process the same event twice) but the raw provider
payload was discarded, so a mis-applied or dropped subscription change could
not be re-run.

## What was added

**Migration `035_billing_event_payload.sql`** — adds nullable
`provider`, `payload` (JSONB), `replayed_at`, `replay_count` to
`billing_events`. Nullable + no backfill = backward compatible; pre-existing
rows have a null payload and are reported "not replayable".

**Ingest** (`applySubscriptionState`) now persists the raw payload and provider
alongside the idempotency marker, in the same transaction.

**Service functions** (`packages/shared/src/billing.ts`):
- `listBillingEvents({limit, before})` — newest-first, with a `replayable` flag.
- `getBillingEvent(id)` — one event including its stored raw payload.
- `replayBillingEvent(id)` — records replay bookkeeping (replay_count/replayed_at).

**Admin endpoints** (`packages/api/src/routes/admin.ts`):
- `GET  /admin/billing-events` — list (operator role).
- `GET  /admin/billing-events/:id` — inspect one with payload (operator).
- `POST /admin/billing-events/:id/replay` — replay (ADMIN role; rate-limited;
  audit-logged). Re-parses the stored payload through the SAME provider parser
  used at ingest (so a parser bugfix takes effect on replay), then re-applies
  with a replay-suffixed event id so the idempotency guard doesn't short-circuit
  the intentional re-run. Returns 422 for events that predate payload storage.

The three provider parsers (`stripeSubscriptionEvent`, `paypalSubscriptionEvent`,
`cashfreeSubscriptionEvent`) are now exported from the billing route and reused
by the admin replay endpoint rather than duplicated.

## Verified how (real, live infra)

- Migration 035 applies cleanly (verified: all 7 columns present); the
  migration test suite still passes.
- `npm run build` (all packages): exit 0, no TS errors.
- `billing-event-replay.test.ts`: 5/5 pass against live Postgres — payload
  persisted on ingest, listing, fetch-with-payload, replay bookkeeping
  increment, not_found, and not_replayable paths.
- Full suite: 86 files, 577 tests, 0 failures.

## Migration numbering note

The RLS fail-closed migration was ultimately shipped later as
`infra/migrations/043_rls_fail_closed.sql`. This billing migration retained
035 in the auto-applied directory without a numbering collision.
`docs/RLS_FAIL_CLOSED_ROLLOUT.md` has been updated accordingly.

## Still external (NOT closed by this work)

The report's other billing sub-items — "real sandbox/live proof" for Stripe/
PayPal/Cashfree — require live provider credentials and cannot be closed in this
environment. The signature verifiers themselves are already implemented and
well-tested (fail-closed in prod, HMAC + timestamp replay protection,
timing-safe compare; see hardening.test.ts and cashfree-webhook-timestamp.test.ts).
What remains is running them against each provider's real sandbox, which is an
ops/credentials task, not a code gap.
