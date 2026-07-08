# Mail Platform — Production-Readiness Audit & Fixes

**Scope:** full in-depth review of the `mail-platform-step30-body-offload` monorepo
(API, send/event/webhook workers, scheduler, two Haraka MTAs, tracker, shared lib,
31 SQL migrations, Helm/k8s, 463-test suite).

**Method:** extracted the repo, built every package, stood up Postgres + Redis,
ran all migrations, and ran the full test suite. Read the security- and
correctness-critical paths line by line (send pipeline, body-offload, quota,
idempotency, outbox, VERP bounce signing, SSRF, webhook delivery, DKIM signing,
billing-webhook verification, tracker/unsubscribe, retention, event worker).

**Result:** found and fixed **5 real production bugs** (3 data-loss / delivery-breaking,
1 a hard functional block on sending, 1 an SSRF DNS-rebind bypass), plus closed
**3 hardening gaps** (webhook signature fail-open, public metrics, event status
downgrades). Test suite went from **456/463** to **492/492 green**, with **25 new
regression/stress tests** that pin the fixed behaviour — including concurrency
stress tests proving no quota oversell and no idempotency double-send.

---

## What was already strong

This is a genuinely well-engineered codebase; the hard parts are mostly right:

- **Signed VERP return-paths** with constant-time tag comparison; forged
  bounces/complaints can't suppress arbitrary recipients.
- **FBL complaint handling** trusts only the signed VERP id, not the
  attacker-controllable body `Message-ID`.
- **Two-layer SSRF protection** for webhooks, including a DNS-resolution check at
  *delivery* time (defeats DNS-rebinding), redirect blocking, and IPv4/IPv6
  private-range coverage incl. cloud metadata.
- **Atomic quota reservation** via a Lua script (daily + monthly move together),
  seeded from the durable table on a cold cache so a Redis flush can't reset quota.
- **Transactional send outbox** drained with `FOR UPDATE SKIP LOCKED`, claimed
  inside the transaction to avoid double-claim races.
- **Startup config guard** that refuses to boot in prod on default/weak secrets.

---

## Bugs found & fixed

### 1. Stale-send recovery was completely non-functional (delivery-breaking)

**Severity: High.** The scheduler's `stale_send_recovery` job (runs every 10 min)
existed to rescue messages stranded in `status='sending'` after a worker crash.
Its query filtered on `messages.updated_at`, **a column that never existed**:

```
ERROR: column "updated_at" of relation "messages" does not exist
```

So the job threw on every run and **stranded messages stayed in `sending`
forever** — the exact failure the job was built to prevent.

**Fix.** Added migration `031` introducing a dedicated **`sending_at`** timestamp
that the send worker stamps the instant it transitions a row into `sending`, plus
a generic `updated_at` audit column with the standard trigger. Recovery now keys
off `sending_at` (and treats `NULL` defensively as stale).

> **Design note:** a trigger-managed `updated_at` is the *wrong* signal for this —
> the recovery UPDATE itself (and unrelated later mutations) would reset it, so a
> stuck row would never look stale. `sending_at` measures exactly "how long stuck
> in the sending state," which is the correct semantic. A partial index
> (`WHERE status='sending'`) keeps the sweep cheap at scale.

Files: `infra/migrations/031_messages_updated_at.sql`, `schema.ts`,
`worker/src/send-worker.ts`, `worker/src/scheduler.ts`.

### 2. Batch send silently dropped the body under object storage (data loss)

**Severity: High.** With `BODY_STORAGE=fs` or `s3`, the single-send path correctly
offloads the body and stores a pointer. The **`/send/batch`** path, however,
hard-coded `body_storage:'inline'` and null'd `html_body`/`text_body`
**without ever calling `bodyStore.put()`**. Result: every batch-sent message had
no inline body and no object key, so the worker's `loadMessageBody` returned
empty — **every batch send delivered an empty email**.

**Fix.** The batch path now offloads each message body (content-addressed, so
identical bodies still dedupe) *before* opening the transaction, and writes the
correct pointer per row — matching the single-send path.

Files: `api/src/routes/send.ts`. Regression test:
`tests/e2e/send-body-offload.e2e.test.ts` ("offloads bodies for BATCH sends too").

### 3. Bounce/complaint events double-counted on provider re-delivery

**Severity: Medium.** The inbound bounce parser stamped each
hard_bounce / soft_bounce / complaint event with `crypto.randomUUID()` as its
idempotency key. The event worker uses that key to dedupe (its own comment
requires the key be *stable across re-deliveries*). Mail providers **retry DSN/FBL
delivery**, so the same bounce arrived with a fresh UUID each time and was
processed repeatedly — **double-bumping `bounced`/`complained` usage** and
re-running suppression/reputation logic.

**Fix.** The key is now a deterministic SHA-256 over
`(event_type, message_id, recipient)`, so a re-delivered identical DSN/FBL
collides on the `events.event_key` unique index and is skipped.

Files: `haraka-inbound/plugins/bounce_parser.js`. Regression test:
`tests/bounce-parser.test.ts` ("bounceEventKey deterministic").

### 4. `GET/PATCH /v1/profile` always returned 401 (blocks all live sending)

**Severity: High.** `customerRoutes` is mounted *outside* the API-key auth scope
(correctly, since it also hosts public `/signup`). But the `/profile` handlers
depend on `req.auth` via `requireScope('messages')`, which only the auth plugin
populates — so **every authenticated `/profile` call 401'd**.

This is not cosmetic: `/profile` is the only API to set the customer's CAN-SPAM
`physical_address`, and the send worker **hard-fails any live send**
(`physical_address_required`) when that field is empty. Net effect: a customer
could never set their address through the API, so **no live mail could be sent at
all** without direct DB surgery.

**Fix.** Split the two profile handlers into their own `profileRoutes` plugin and
registered it *inside* the authenticated scope (in both `server.ts` and the test
harness). `/signup` etc. stay public.

Files: `api/src/routes/profile.ts` (new), `api/src/routes/customers.ts`,
`api/src/server.ts`, `tests/e2e/harness.ts`.

---

## Test-suite hygiene (not product bugs, but fixed)

- **Migration count tests** hardcoded `29` and were already stale; rewritten to
  count `.sql` files dynamically so they never break on a new migration. The
  baseline test also had an internal off-by-one (`baselined=29` vs `count=28`),
  now consistent.
- **KMS aws-provider test** used `expect(() => p.getKey()).toThrow()` against an
  `async` method that *rejects* rather than throws synchronously; corrected to
  `await ...rejects.toThrow()`.

---

## Verification

- `npm run build` — clean across all packages.
- `tsc --noEmit` — clean across shared/api/worker/tracker/sdk.
- `npx vitest run` — **467 passed / 467 (69 files)**, including the 4 new
  regression tests.
- Migrations apply cleanly from a fresh schema (`applied=31`).

---

## Hardening pass (the three follow-ups — now done)

### 5. Webhook DNS-rebinding TOCTOU (SSRF bypass — High)

**Found while going deeper.** The webhook worker validated the target URL's
resolved IPs via `resolveAndAssertPublicUrl`, then called `request(wh.url)`,
which **re-resolved the hostname independently** at connect time. A malicious DNS
server could return a public IP for the validation lookup and a private IP
(e.g. cloud metadata `169.254.169.254`) for the actual request — a classic
time-of-check/time-of-use rebind. `maxRedirections: 0` blocked the redirect
vector but not this one.

**Fix.** Pin the connection to the already-validated IP via a custom undici
dispatcher (`ipPinnedDispatcher`) whose `lookup` short-circuits DNS to the vetted
address, while the original hostname is preserved for the Host header and TLS
SNI. Per-delivery dispatcher is torn down after the response drains. Regression
test (`webhook-ssrf-pinning.test.ts`) proves a request to a non-resolving
hostname pinned to loopback still lands on the pinned IP.

Files: `worker/src/webhook-worker.ts`.

### 6. Billing webhook signature fail-open

All three verifiers did `if (!secret) return true` — an unset webhook secret
accepted **any forged payload** (fake "payment succeeded", subscription changes).
Fixed two ways: verifiers now **fail closed in production** (`allowUnsignedWebhook`),
and `config-guard` **conditionally requires** the active provider's
`*_WEBHOOK_SECRET` in production — only for the provider actually selected and
live-configured. Files: `api/src/routes/billing.ts`, `shared/src/config-guard.ts`.

### 7. Public `/metrics` exposure

The Helm ingress routed `path: /` to the API, so the Prometheus endpoint — which
leaks per-customer send volumes and bounce/complaint rates — was world-readable.
Added a constant-time token guard (`metricsAuthorized`, fail-closed in prod) on
both the API and tracker, updated the Prometheus scrape config to present the
bearer token, and added an nginx `deny` on `/metrics` at both ingresses (defense
in depth). Files: `shared/src/metrics.ts`, `api/src/server.ts`,
`tracker/src/server.ts`, `infra/prometheus/prometheus.yml`,
`infra/helm/.../ingress.yaml`.

### 8. Event status downgrades

Out-of-order/duplicate provider events (a delayed `delivered` after a
`hard_bounce`) could overwrite a terminal state. Added a `STATUS_PRECEDENCE`
guard so status only ever advances; timestamps are still recorded regardless of
order. Verified end-to-end against the real event worker. Files:
`worker/src/event-worker.ts`.

## Concurrency stress testing (new)

To validate SendGrid-grade correctness under load, added stress tests that hit
the real atomic paths:

- **No quota oversell:** 20 concurrent sends against a daily limit of 5 admit
  **exactly 5** — the Lua check-and-increment never oversells.
- **No idempotency double-send:** 12 simultaneous identical requests with one
  `Idempotency-Key` produce **exactly one** message; the rest replay (202) or
  report in-progress (409).

## Verification (final)

- `npm run build` + `tsc --noEmit` — clean across all packages.
- `npx vitest run` — **492 passed / 492 (72 files)**, including 25 new tests.
- Migrations apply cleanly from a fresh schema.

## Remaining lower-priority notes

These are defensible as-is but worth a glance for a 10/10 bar:

1. **Per-delivery undici Agent.** `ipPinnedDispatcher` creates one Agent per
   webhook delivery. Correct and safely torn down, but at very high webhook
   volume a pooled-per-IP dispatcher cache would cut connection churn. Optimization,
   not a correctness issue.
2. **`releaseQuota` underflow.** On full suppression the reserved quota is
   decremented; a stray double-release could drive the counter negative. Low risk
   (paths are guarded), but a `max(0, …)` floor in the Lua would be belt-and-suspenders.
