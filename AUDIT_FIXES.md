# Security & Correctness Audit — Fixes

This document records the bugs found and fixed during an end-to-end audit of the
mail platform, beyond the previously-completed "Antigravity" batch (which was
verified to already be present and correct in the code).

Each item lists the file(s) touched, the problem, and the fix. Every change was
verified to compile (`npm run build`) and, where runnable without a live
Postgres/Redis, covered by unit tests (`npm test`).

> Note on scope: "bug-free" cannot be certified for any codebase. This audit
> fixed everything found by close reading plus building and running the test
> suite. The DB-backed integration suites require Docker (Postgres + Redis) and
> were not executed in the audit environment; new DB-backed regression tests
> are included and will run under `npm test` with the stack up.

---

## Round 1

### 1. FBL complaint forgery (HIGH — security)
**File:** `packages/haraka-inbound/plugins/bounce_parser.js`

The complaint path chose its target message-id as
`fbl.originalMessageId || verpMessageId`, trusting the `Message-ID:` header
inside the ARF report body. That header is attacker-controllable, so anyone able
to deliver a forged complaint could suppress an arbitrary recipient and damage a
customer's sender reputation — defeating the VERP signing the platform
implements precisely to prevent this. The DSN path already required the signed
id; only the FBL path leaked.

**Fix:** require the verified VERP message-id; if the body also carries a
`Message-ID`, it must match the signed one, otherwise the report is ignored.
Added 3 regression tests in `tests/bounce-parser.test.ts`.

### 2. `first_clicked_at` overwritten on every click (correctness)
**File:** `packages/worker/src/event-worker.ts`

`first_clicked_at` was assigned `new Date()` on every click event with a plain
`.set()`, so the "first" click timestamp moved forward on every repeat click.

**Fix:** `COALESCE` it (like the adjacent `human_clicked_at`/`human_opened_at`)
so it captures the first click only. DB-backed regression test added in
`tests/bot-detection-e2e.test.ts`.

### 3. Unescaped recipient address in tracker HTML (hardening)
**File:** `packages/tracker/src/server.ts`

The unsubscribe pages interpolated `msg.to_address` into markup unescaped.

**Fix:** added an `escapeHtml` helper, applied it to the reflected address, and
`encodeURIComponent` on the URL path parameter.

---

## Round 2

### 4. Webhook SSRF (HIGH — security)
**Files:** `packages/shared/src/ssrf.ts` (new),
`packages/worker/src/webhook-worker.ts`, `packages/api/src/routes/webhooks.ts`,
`packages/shared/src/index.ts`, `packages/shared/src/metrics.ts`

The webhook worker POSTed to customer-supplied URLs with no validation. A
customer could target `169.254.169.254` (cloud metadata), `localhost`, or any
RFC1918 address and use the platform as a confused deputy against the internal
network / instance credentials.

**Fix:** new SSRF guard that
- rejects non-http(s) schemes and credentials-in-URL,
- rejects private/reserved/loopback IPv4 and IPv6 (including IPv4-mapped),
- re-resolves the hostname **at delivery time** and rejects if any resolved
  address is private (defeats DNS-rebinding),
- disables redirect following on delivery (`maxRedirections: 0`).

Enforced at registration (fast feedback, `400 invalid_webhook_url`) and at
delivery (authoritative; non-retryable `blocked` outcome). A
`WEBHOOK_ALLOW_PRIVATE=1` escape hatch exists for local dev/tests only. 14 unit
tests in `tests/ssrf.test.ts`.

### 5. Config guard missed shipped placeholder secrets (production safety)
**File:** `packages/shared/src/config-guard.ts`

The guard's exact-match blocklist did not contain the actual `change-me-…`
values shipped in `.env.example`, nor the all-zeros `ENCRYPTION_KEY`, and never
checked `API_KEY_PEPPER` / `ADMIN_SESSION_PEPPER` at all — so a production deploy
using the shipped defaults would boot.

**Fix:** replaced exact-match with a heuristic detector (`change-me`/`changeme`,
all-zeros, single-repeated-char, `example`/`placeholder`/`your-`/`xxxx`) and
added `API_KEY_PEPPER`, `ADMIN_SESSION_PEPPER`, `HARAKA_OUTBOUND_PASS` to the
rules. Updated/added tests in `tests/config-guard.test.ts`.

### 6. Outbound DKIM signing was plugin-order-fragile (deliverability)
**File:** `packages/haraka-outbound/plugins/customer_dkim.js`

`customer_dkim.sign` read `X-MP-Customer-ID` from a header that
`header_cleanup.strip_internal_headers` removes on the same `queue_outbound`
hook. The current load order happens to work, but any reorder would make the
DKIM plugin read `null` and `DENYSOFT` every message — silently halting all
outbound mail. `header_cleanup` already stashes the ids into `txn.notes`
precisely so downstream plugins don't depend on header presence; `event_emitter`
correctly reads from notes, but DKIM did not.

**Fix:** read the customer id from `txn.notes` first with a header fallback, so
signing is independent of plugin load order.

### 7. Non-constant-time, not-fail-closed admin token check (hardening)
**File:** `packages/api/src/routes/customers.ts`

`/admin/api-keys` compared the admin token with `!==` (a timing oracle on a
secret).

**Fix:** `crypto.timingSafeEqual` via a `safeEqual` helper that also fails
closed when either side is empty.

### 8. NaN-crash on malformed pagination / `days` params (robustness)
**Files:** `packages/api/src/routes/usage.ts`,
`packages/api/src/routes/suppressions.ts`

`Number(days)` / `Number(limit)` on non-numeric query params produced `NaN`,
which crashes the Postgres query (500) — the same class the messages route
already guarded against.

**Fix:** clamp/sanitize with sane defaults and bounds, matching the messages
route pattern.

---

## Test summary

- Runnable unit tests (no DB): **103 passing** (was 87 before this audit).
- New tests added: SSRF guard (14), config-guard placeholders + required peppers
  (2 new), FBL forgery resistance (3), first-click COALESCE (1, DB-backed).
- Webhook routes are now registered in the e2e harness so the SSRF rejection is
  reachable end-to-end under the full suite.
- DB-backed suites (e2e, quota, apikeys, abuse, suppression-softbounce,
  admin-kms, reputation, antigravity-fixes-db, the two new DB-backed cases)
  require `docker compose up postgres redis` and were not run in the audit
  environment.

---

## Round 3 — Live end-to-end delivery testing

### 9. VERP token local-part exceeds SMTP 64-character limit (HIGH — deliverability)
**Files:** `packages/shared/src/crypto.ts`, `packages/haraka-inbound/plugins/bounce_parser.js`,
`packages/tests/verp.test.ts`, `docker-compose.yml`

`buildVerpToken` base64url-encoded the full message ID including the domain
(e.g. `f5f0910d…@happycubing.com`) producing a local part of 83+ characters.
RFC 5321 §4.5.3.1 limits the local part to 64 characters. Haraka rejected every
outbound message at the SMTP DATA stage with `501 Invalid MAIL FROM address`,
making delivery completely impossible.

**Fix:** encode only the hex local part (before `@`); reconstruct the full
message ID on the inbound side by appending `@PLATFORM_DOMAIN` from the
environment. Added `PLATFORM_DOMAIN=happycubing.com` to the `haraka-inbound`
container env. Updated the VERP round-trip test to set `PLATFORM_DOMAIN`.

---

### 10. DKIM plugin looked up wrong domain — envelope MAIL FROM instead of From header (HIGH — deliverability)
**File:** `packages/haraka-outbound/plugins/customer_dkim.js`

`fromDomain` was read from `txn.mail_from.host`, which is the VERP bounce-path
domain (`bounces.happycubing.com`). No DKIM key exists for that domain, so the
lookup always returned no row and signing failed with `DENYSOFT` on every message.

**Fix:** extract the domain from the `From:` header using a regex
(`/@([\w.-]+)/`) so signing uses the customer's actual sending domain
(`happycubing.com`) rather than the envelope return-path domain.

---

### 11. Customer ID and message ID headers have trailing newlines in Haraka (HIGH — deliverability + correctness)
**Files:** `packages/haraka-outbound/plugins/customer_dkim.js`,
`packages/haraka-outbound/plugins/header_cleanup.js`

`txn.header.get()` in Haraka appends a trailing `\n` to header values. Two
separate failures resulted:

- **DKIM plugin:** `customer_id` with `\n` was passed directly to a Postgres
  UUID query, producing `invalid input syntax for type uuid` on every message,
  causing DKIM to `DENYSOFT` (or silently fail when `DKIM_REQUIRED=false`).
- **header_cleanup / event_emitter:** `message_id` stored in `txn.notes` with
  `\n` was serialised into the queue file. When the outbound delivery worker
  fired the `delivered`/`bounce` hook, `getMessageId()` returned an id with a
  trailing newline, so the event worker's DB `WHERE message_id = $1` matched
  nothing and messages were permanently stuck in `accepted` status.

**Fix:** apply `.trim()` to all three values (`customer_id`, `message_id`,
`ip_pool`) in both `customer_dkim.js` and `header_cleanup.js` when storing into
`txn.notes`.

---

### 12. Outbound TLS init permanently blocked the delivery queue (CRITICAL — deliverability)
**Files:** `packages/haraka-outbound/config/tls.ini`,
`packages/haraka-outbound/Dockerfile`

Two issues combined to make Haraka accept every message via SMTP but never
attempt delivery:

**(a) Missing TLS certificate:** Haraka looked for `tls_key.pem` /
`tls_cert.pem` at startup. When absent, `obtls.cfg` was not populated, so the
delivery queue called `obtls.init(cb)` for every message. `init()` attempted to
connect to Redis via `haraka-plugin-redis` for TLS-failure-host tracking. No
`redis.ini` was present, so it defaulted to `localhost:6379` (unreachable inside
the container). The callback `cb` was never invoked, the delivery Promise never
resolved, and the queue was permanently blocked.

**(b) Boolean INI parsing:** Adding `disable_for_failed_hosts=false` to `tls.ini`
was parsed by `haraka-config` as the string `"false"` (truthy), not boolean
`false`, so the fast-path condition
`if (cfg.redis && !cfg.redis.disable_for_failed_hosts)` evaluated to `false` and
the Redis init path was still taken.

**Fix:**
- Generate a self-signed TLS cert in the Dockerfile (`openssl req -x509 …`) so
  `obtls.cfg` is populated at startup and the fast path `if (obtls.cfg) hmail.send()`
  is taken directly.
- Add an empty `[redis]` section to `tls.ini`. An empty section parses to `{}`
  (truthy); `{}.disable_for_failed_hosts` is `undefined` (falsy), satisfying
  `!disable_for_failed_hosts = true` and triggering the immediate `return cb()`
  without Redis.
- Separated the `openssl` install into its own `RUN` layer to preserve the
  `python3 make g++` cache and avoid slow rebuilds.

---

### 13. `ipv6_enabled=false` is not a valid Haraka 3.2.1 config option (deliverability)
**File:** `packages/haraka-outbound/config/outbound.ini`

The original config used `ipv6_enabled=false`, which was valid in older Haraka
versions but is ignored in 3.2.1. Docker containers have IPv6 interfaces but no
external IPv6 routing. Haraka resolved Gmail's MX to IPv6 addresses first
(`2404:6800:…`) and attempted connection, receiving `ENETUNREACH` on every
attempt. The Haraka 3.2.1 equivalent is `inet_prefer`.

**Fix:** add `inet_prefer=v4` to `outbound.ini`. This puts IPv4 MX addresses
first in the connection list so Haraka connects via IPv4, where external routing
is available.

---

## How to build & test

```bash
npm install
npm run build
# unit + e2e (needs Postgres + Redis reachable per .env):
docker compose up -d postgres redis
npm test
```
