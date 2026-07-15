# Changelog

## v0.7.26 - Retention hardening (Database 10/10 Plan, Phase 0)

### Legal-hold-aware retention (compliance fix)

- **`runRetention` now respects active legal holds.** Previously the daily
  sweep nulled bodies, deleted body objects, and deleted events with no hold
  check, so a tenant under litigation hold still had data destroyed — defeating
  the hold that the erasure endpoint (`assertNoActiveHold`) correctly enforces.
  Every destructive step now skips rows covered by an active `customer` or
  `recipient:<email>` hold; skipped rows are reported as `held_rows_skipped`
  (exposed as the `mp_retention_held_rows_skipped` gauge) and purged by a later
  sweep once the hold is released. Archival steps (audit log → archive) and
  non-tenant data (blocklist checks) are intentionally not hold-gated.

### Batched, indexed sweeps

- The event purge was a single unbatched `DELETE` whose predicate no index
  could serve (a sequential scan holding one long transaction). All cutoff
  deletes/updates now run in bounded batches (`RETENTION_BATCH_SIZE`, default
  10k rows), and migration `062_retention_hardening.sql` adds cutoff indexes
  on `events(occurred_at)`, `messages(queued_at)`, `tracked_links(created_at)`,
  `webhook_delivery_log(delivered_at)`, and `blocklist_checks(checked_at)`.

### Previously unbounded tables now age out

- **`messages` metadata rows**: purged after `RETENTION_MESSAGE_DAYS`
  (default 395) — terminal statuses only, hold-aware. Bodies still expire at
  `RETENTION_BODY_DAYS`; long-term stats live in `usage_daily` + ClickHouse
  rollups.
- **`tracked_links`**: purged with the body window, hold-aware via the parent
  message.
- **`webhook_delivery_log`**: purged after `RETENTION_WEBHOOK_LOG_DAYS`
  (default 30).
- **`blocklist_checks`**: purged after `RETENTION_BLOCKLIST_DAYS` (default 180).
- `POST /admin/retention/run` accepts the new windows
  (`message_retention_days`, `webhook_log_retention_days`,
  `blocklist_retention_days`).

### Connection-layer hardening

- Pool tunables are env-driven per service: `PGPOOL_MAX`,
  `PGPOOL_IDLE_TIMEOUT_MS`, `PGPOOL_CONNECT_TIMEOUT_MS`,
  `PG_STATEMENT_TIMEOUT_MS` (default 30 s), `PG_IDLE_TX_TIMEOUT_MS`
  (default 60 s), `PG_APPLICATION_NAME`. The migration runner keeps its own
  untimed pool, so long DDL is unaffected.
- New `mp_pg_pool_connections{state}` gauge (total/idle/waiting), sampled at
  `/metrics` scrape time in every service.

## v0.7.25 - Readiness probes, graceful drain, backup drill, billing alerts, webhook secret rotation

### T5 — Readiness checks + graceful worker drain

- **Worker `/health`**: checks Postgres (live query), Redis (`PING`), and the
  send queue (`getJobCounts`) before reporting healthy; returns `503` with a
  per-dependency `checks` map when any dependency is down.
- **Worker `/live`**: lightweight liveness probe — returns `200` immediately
  without querying dependencies.
- **Worker `/ready`**: same dependency checks as `/health`; returns `{ status:
  "ready" }` on success.
- **Graceful drain**: `SIGTERM`/`SIGINT` now race all BullMQ workers'
  `.close()` against a `WORKER_DRAIN_TIMEOUT_MS` (default 30 s) force-exit
  timer, ensuring in-flight jobs finish before the process exits but the
  container is never blocked indefinitely.
- **Test harness** (`packages/tests/e2e/harness.ts`): `/health`, `/ready`, and
  `/metrics` routes wired into `buildTestApp()` with real dependency checks.

### T6 — Backup / restore drill

- `scripts/backup-restore-drill.sh`: idempotent shell script that:
  - Runs `pg_dump` inside the Postgres Docker container into a temp file.
  - Restores into a scratch database (`mail_platform_drill`).
  - Verifies row counts on `customers`, `messages`, `schema_migrations` tables.
  - Drops the scratch database on exit (cleanup trap).
- `package.json` root script: `"backup-drill": "bash scripts/backup-restore-drill.sh"`.

### T7 — Billing reconciliation alerting job

- **Scheduler** (`packages/worker/src/scheduler.ts`): `metering_reconcile` job
  (12 h) now writes a `billing:reconciliation_drift` entry to `audit_log` when
  drift is detected, so ops can query it from the admin panel.
- **External webhook**: if `BILLING_ALERT_WEBHOOK_URL` is set, the scheduler
  fires a `POST` with the drift payload; delivery failures are logged but do not
  crash the job.
- **Admin endpoint** `POST /admin/billing/reconcile` (`operator` role): runs
  `reconcileMetering()` on demand, audits the action, and returns
  `{ ok, total_drift, by_customer, alert }` where `alert` is `"clean"` or
  `"drift_detected"`.

### T8 — Customer webhook secret rotation

- `rotateWebhookSecret(customerId, webhookId)` in `packages/shared`: generates
  a new `whsec_` prefixed secret, updates the DB row, returns the updated
  webhook or `null` on not-found / wrong owner.
- API endpoint `POST /v1/webhooks/:id/rotate-secret` (`webhooks` scope):
  returns `201` with the updated row plus a `note` field; cross-org access
  returns `404`; missing scope returns `403`.

### Tests

- `e2e/healthcheck.e2e.test.ts` (5 tests): `/live`, `/health` dependency
  results, `/ready` status, structured check map, `/metrics` Prometheus format.
- `e2e/billing-reconcile-webhook-rotation.e2e.test.ts` (7 tests):
  - T7: returns drift report, result is consistent across calls, enforces
    operator RBAC.
  - T8: rotate returns new secret, two rotations produce different secrets,
    cross-org 404, webhooks scope required.

### Validated

- `npm run build` (5 packages). `npm test`: **419 tests across 63 suites**.
  `npm audit --audit-level=high`: **0 vulnerabilities**.

---

## v0.7.24 - Retention / cleanup jobs

Scheduled daily sweep keeps the hot `messages`, `events`, and `audit_log` tables
lean by purging bodies and rows that are past configurable retention windows.

### Added

- `packages/shared/src/retention.ts`: `runRetention(opts?)` performs five
  cleanup passes in a single call:
  - **Inline body purge** — nulls `html_body`/`text_body` on terminal messages
    (`delivered`, `hard_bounced`, `failed`, `suppressed`) older than
    `RETENTION_BODY_DAYS` (default 90 days). Message rows are kept.
  - **Offloaded body purge** — deletes the body object from the store (fs / S3)
    and clears `body_object_key` only when every message referencing that
    content-addressed key is past retention. Shared objects used by a live
    message are preserved.
  - **Events purge** — deletes `events` rows older than `RETENTION_EVENT_DAYS`
    (default 90 days).
  - **Audit log purge** — deletes `audit_log` rows older than
    `RETENTION_AUDIT_DAYS` (default 365 days).
  - **Review queue purge** — deletes resolved/rejected `review_queue` entries
    older than `RETENTION_REVIEW_QUEUE_DAYS` (default 30 days).
- Daily scheduler job `daily_retention` wired into
  `packages/worker/src/scheduler.ts` (24 h interval, distributed-lock guarded).
- Admin endpoint `POST /admin/retention/run` (requires `operator` role):
  accepts optional per-window overrides, logs an audit event, returns
  `RetentionResult`.
- Test helpers in `testkit.ts`: `seedOldMessage`, `seedOldEvent`,
  `seedOldAuditEntry`, `countAuditEntries`.

### Tests

- `e2e/retention.e2e.test.ts` (9 tests):
  - Inline body purge: nulls body on old terminal messages; skips recent;
    skips non-terminal regardless of age.
  - Offloaded body purge: deletes object when all referencing messages are
    past retention; preserves object when a live message still references the
    same content-addressed key.
  - Event purge: removes old event rows; keeps recent ones.
  - Audit log purge: removes old entries; keeps recent entries.
  - Admin endpoint: runs retention and returns structured result; accepts empty
    body (env defaults); enforces operator RBAC.

### Validated

- `npm run build` (5 packages). `npm test`: **404 tests across 61 suites**.
  `npm audit --audit-level=high`: **0 vulnerabilities**.

## v0.7.23 - Admin MFA (TOTP)

Admin password login now supports authenticator-app MFA for privileged
back-office accounts.

### Added

- Migration `020_admin_mfa.sql`: `admin_users.totp_secret` and
  `admin_users.totp_enabled`.
- Admin TOTP helpers in `admin.ts`: begin enrollment, confirm enrollment,
  verify login codes, and disable MFA.
- TOTP secrets are encrypted at rest with the existing secret-encryption helper.
- Password login now enforces TOTP when enabled, returning stable
  `mfa_required` and `mfa_invalid` errors.
- Self-service admin MFA endpoints:
  - `POST /admin/auth/mfa/enroll`
  - `POST /admin/auth/mfa/confirm`
  - `POST /admin/auth/mfa/disable`
- `docs/ADMIN.md` MFA enrollment and login notes.

### Tests

- `e2e/admin-mfa.e2e.test.ts`: enroll, confirm with computed TOTP, verify
  encrypted-at-rest secret storage, enforce login code, reject bad/missing
  codes, disable MFA, and confirm login no longer requires a code.
- Existing `totp.test.ts` RFC 6238 vectors continue to verify the TOTP
  implementation directly.

### Validated

- `npm run build` (5 packages). `npm test`: **395 tests across 60 suites**.
  `npm audit --audit-level=high`: **0 vulnerabilities**.

## v0.7.22 - Dead-letter queue admin recovery

Dead-lettered jobs are no longer an opaque Redis queue. Operators can inspect,
replay, and purge exhausted jobs through the admin plane.

### Added

- Shared DLQ helpers in `queues.ts`: `listDeadLetter`, `getDeadLetter`,
  `replayDeadLetter`, `purgeDeadLetter`, and `purgeAllDeadLetters`.
- Admin endpoints behind `requireAdmin('operator')`:
  - `GET /admin/dlq` for paginated inspection with truncated payload previews.
  - `GET /admin/dlq/:id` for full job detail.
  - `POST /admin/dlq/:id/replay` to enqueue a fresh job onto the original
    `send`, `events`, or `webhooks` queue and remove the DLQ entry.
  - `DELETE /admin/dlq/:id` to purge one entry.
  - `POST /admin/dlq/purge` with `{ "confirm": true }` to clear the DLQ.
- Admin audit events for DLQ replay/delete/purge.

### Tests

- `e2e/dlq.e2e.test.ts` (4): list/detail; replay to original queue and removal
  from DLQ; delete + confirmed purge; operator RBAC enforcement.

### Validated

- `npm run build` (5 packages). `npm test`: **394 tests across 59 suites**.
  `npm audit --audit-level=high`: **0 vulnerabilities**.

## v0.7.21 - Multi-provider billing registry + PayPal scaffold

Billing now supports provider selection per customer instead of a single global
Stripe-or-mock singleton.

### Added

- Migration `019_billing_provider.sql`: `customers.billing_provider` with
  `stripe`, `paypal`, and `mock` values.
- A provider registry in `billing-provider.ts`:
  `registerBillingProvider(name, factory)` and `getBillingProviderFor(name)`,
  with cached provider instances per name. `getBillingProvider()` and
  `setBillingProvider()` remain for back-compat and tests.
- `PayPalBillingProvider`, using PayPal OAuth + subscription REST scaffolding
  and a portal-equivalent account-management URL. PayPal metered usage is a
  deliberate no-op because PayPal subscriptions do not have Stripe-style usage
  records.
- Checkout, portal, overview, subscription-state, and metered-usage helpers now
  select the provider from the customer row.
- Provider-keyed billing webhooks:
  `POST /v1/billing/webhook/:provider`, with `/v1/billing/webhook` preserved as
  the Stripe-compatible legacy path.
- OpenAPI coverage for billing webhooks and an updated `docs/BILLING.md`.

### Tests

- `e2e/billing-multiprovider.e2e.test.ts` (4): checkout routes to Stripe vs
  PayPal by `billing_provider`; registry instances are distinct and cached;
  Stripe webhook signatures accept/reject correctly; PayPal webhook signatures
  accept/reject correctly.
- Existing `e2e/billing-outbound.e2e.test.ts` remains green against the
  back-compatible `setBillingProvider()` override.

### Validated

- `npm run build` (5 packages). `npm test`: **390 tests across 58 suites**.
  `npm audit --audit-level=high`: **0 vulnerabilities**.

### Note

- Stripe and PayPal live REST/webhook paths are implemented behind seams but not
  credential-verified in this sandbox. Live verification with Stripe test keys
  and a PayPal sandbox app is a deploy-time step.

## v0.7.20 - Body offload: filesystem + S3-compatible storage (no AWS lock-in)

The body store was defined but never wired in, and only sketched an AWS S3
integration. This makes it real, vendor-neutral, and actually used by the send
path -- so large message bodies stop bloating the hot `messages` table.

### Added

- **Three real backends** behind the stable `BodyStore` seam:
  - `inline` (default) -- unchanged; bodies stay in Postgres.
  - `fs` -- local filesystem; zero external dependency / zero extra cost,
    ideal for single-node.
  - `s3` -- **any S3-compatible store** (AWS S3, Cloudflare R2, Backblaze B2,
    Wasabi, MinIO, ...) selected purely by endpoint + credentials. No provider
    lock-in; switching is a config change, not a code change.
- Bodies are **content-addressed** (sharded by hash) so one campaign to many
  recipients dedupes to a single object. `delete()` added for lifecycle / GDPR
  erase.
- The S3 backend is built on a small injectable `ObjectClient`
  (`S3ObjectClient` over `@aws-sdk/client-s3`; `InMemoryObjectClient` for tests),
  so its logic is verifiable without a live bucket or network.
- **Wired into the send path**: bodies are offloaded once before the insert
  transaction (never holding a txn open across object I/O), the message stores a
  pointer instead of the inline body, and the send worker reads it back
  transparently via `loadMessageBody()`.
- Migration `018_body_storage_fs.sql` (extend the `body_storage` check to allow
  `fs`); `setBodyStore()` for runtime override; `docs/STORAGE.md`.

### Tests

- `storage.test.ts` (6): filesystem round-trip + content-addressed dedupe +
  delete; S3 store via in-memory client (put/get/delete + JSON payload); the
  `loadMessageBody` resolver; default selection.
- `e2e/send-body-offload.e2e.test.ts` (2): a real send with the filesystem store
  clears the inline columns, persists the pointer, and the body is retrievable;
  and the default still keeps bodies inline (existing behavior unchanged).

### Validated

- `npm run build` (5 packages). `npm test`: **385 tests across 57 suites**.
  `npm audit --audit-level=high`: **0 vulnerabilities**.

### Note

- The S3 path is verified in-memory; pointing it at a live R2/B2/MinIO bucket and
  confirming the round trip is a credentialed deploy step (the sandbox has no
  egress to object-storage endpoints). The filesystem path is exercised
  end-to-end here.

## v0.7.19 - Outbound billing: charge customers via the provider seam

Billing previously only *received* webhooks -- there was no way to actually put a
customer on a paid plan. This adds the outbound side behind a provider seam, so
the platform can take money. Built mock-first so it is fully testable without
Stripe credentials or network.

### Added

- **`BillingProvider` seam** (`billing-provider.ts`): `MockBillingProvider`
  (default; records calls, deterministic ids/urls) and `StripeBillingProvider`
  (real Stripe REST: customers, checkout sessions, billing portal, usage
  records), selected by `STRIPE_SECRET_KEY`. `get/setBillingProvider()`.
- **Outbound helpers** in `billing.ts`: `ensureBillingCustomer` (lazy, race-safe,
  persists `stripe_customer_id`), `startCheckout`, `startBillingPortal`,
  `getBillingOverview`, and `reportMeteredUsage` (reports the day's `delivered`
  count to the metered subscription item, idempotency-keyed).
- **Customer endpoints** under `/v1/account/billing` (capability
  `billing:manage`): `GET /account/billing`, `POST /account/billing/checkout`,
  `POST /account/billing/portal`. Registered in server + harness; documented in
  OpenAPI (with schemas) and `docs/BILLING.md`.
- Migration `017_billing_subscription_item.sql` +
  `customers.stripe_subscription_item_id`; `applySubscriptionState` now stores
  the metered item id from the subscription event.

### Tests

- `e2e/billing-outbound.e2e.test.ts` (7): overview; checkout provisions and
  persists a provider customer **exactly once** across repeated calls; portal;
  body validation; auth required; metered usage reports the delivered count to
  the provider; and no-ops cleanly when no metered item exists.

### Validated

- `npm run build` (5 packages). `npm test`: **377 tests across 55 suites**.
  `npm audit --audit-level=high`: **0 vulnerabilities**.

### Note

- The live Stripe path (`StripeBillingProvider`) is exercised in mock form here;
  wiring it to real Stripe test keys + verifying the round trip is a
  credentialed deploy-time step (the sandbox has no Stripe network egress).

## v0.7.18 - Developer guides + SDK send-response fix

Added the task-oriented guide content a SendGrid/Mailgun-style docs portal is
built from (the hosted site itself remains a frontend/build concern), and fixed
an SDK type that didn't match the real send response.

### Added (docs/guides/)

- **Getting started** -- key -> verify domain -> first email, with curl/Node/Python.
- **Authentication** -- API keys, secret vs publishable, scopes, rotation.
- **Sending email** -- full field reference, idempotency, templates, behavior.
- **Webhooks** -- event catalog, payload shape, a correct HMAC-SHA256
  signature-verification walkthrough (Node + Python), and retry/at-least-once
  delivery semantics.
- **Errors** -- the error envelope and a status/code table verified against the
  actual routes.
- **Rate limits** -- per-minute limits, `x-ratelimit-*` headers, backoff.
- **Deliverability** -- SPF/DKIM/DMARC, warmup, bounce/complaint/suppression
  handling, list hygiene.
- Guides index + README link.

### Fixed

- **SDK `SendResult` type** now matches the real API response
  (`{ accepted, rejected, message_ids[], suppressed?, scheduled_for? }`) instead
  of a non-existent `{ message_id, status }`. The guide examples were corrected
  to read `message_ids[0]`.

### Tests

- `e2e/sdk.e2e.test.ts`: added a real `messages.send` case (seeded verified
  domain) asserting `accepted` + `message_ids` -- the coverage gap that let the
  wrong type ship.

### Validated

- Error codes, status codes, suppression reasons, the webhook signature
  algorithm/header, and the send response were each cross-checked against the
  implementation while writing.
- `npm run build` passed (5 packages). `npm test`: **370 tests across 54
  suites**. `npm audit --audit-level=high`: **0 vulnerabilities**.

## v0.7.17 - Documentation: complete OpenAPI contract + official SDK

Completed the documentation surface on the backend side: the public OpenAPI
spec now covers the full customer API, and there is a real, tested SDK package
instead of a descriptive markdown file -- the pieces a SendGrid/Mailgun-style
hosted reference and client libraries are built from.

### Added

- **Full public OpenAPI coverage.** Added the operations that existed as routes
  but were missing from the spec: `DELETE /domains/{id}`,
  `DELETE /suppressions/{email}`, `/templates/{id}` (GET/PUT/DELETE),
  `DELETE /webhooks/{id}`, and `POST /support/tickets/{id}/rate` (+ its schema).
  Every operation now carries an `operationId`, so the spec at
  `GET /v1/openapi.json` is codegen-ready for other languages.
- **Official SDK** (`@platform/sdk`): a dependency-free, fully typed Node/TS
  client mirroring the contract -- `messages` (send with Idempotency-Key, get,
  activity), `suppressions`, `domains`, `templates`, `webhooks`. Non-2xx
  responses throw a typed `MailPlatformError` (status + code + body); a custom
  `fetch` and per-request `timeoutMs` are injectable.
- `docs/SDK.md` rewritten for the real package (install, send, every resource,
  error handling, codegen note).

### Tests

- `openapi.test.ts`: +2 assertions locking the new CRUD surface and requiring an
  `operationId` on every operation (15 total).
- `e2e/sdk.e2e.test.ts`: drives the SDK against the real API through an injected
  fetch -- suppression CRUD, template create/get, 401 error mapping, and 403
  scope enforcement.

### Validated

- `npm run build` passed (shared, api, worker, tracker, sdk).
- `npm test` passed: **369 tests across 54 suites**.
- `npm audit --audit-level=high` passed with **0 vulnerabilities**.

### Note

- This is the backend documentation foundation. The hosted docs *site* and
  rendered interactive reference are a frontend/build concern (out of scope per
  request); the contract + SDK they consume are now complete.

## v0.7.16 - Support desk: SLA, CSAT, canned responses, AI suggested replies

Completed the support module end-to-end. Status workflow, priority, category,
assignment, internal notes, and AI triage already existed; this adds the
SendGrid/Zendesk-class pieces it was missing.

### Added

- **SLA tracking.** First-response and resolution due times are derived from
  priority at creation (urgent 1h/8h, high 4h/24h, normal 24h/72h, low 48h/120h)
  and re-anchored on priority change. `first_responded_at` is stamped on the
  first non-internal agent reply. `GET /admin/support-tickets/sla-breaches`
  returns the open/pending tickets past SLA, each with a computed
  `firstResponseBreached`/`resolutionBreached` flag.
- **CSAT.** `POST /v1/support/tickets/:id/rate` lets a customer rate a
  resolved/closed ticket 1-5 with an optional comment; rating an open ticket
  returns `409`.
- **Canned responses (agent macros).** Full CRUD under
  `/admin/support/canned-responses` (create/list/patch by support; delete by
  operator), filterable by category.
- **AI suggested reply.** `POST /admin/support-tickets/:id/suggest-reply`
  returns an editable draft grounded in the latest customer message + category.
  It is only returned to the agent -- never posted or sent. Added
  `suggestSupportReply` to the `InferenceProvider` seam with a local-heuristic
  default (swappable for a real LLM, no route changes).
- Migration `016_support_sla_csat.sql` (SLA + CSAT columns;
  `support_canned_responses` table).
- `docs/SUPPORT.md`: data model, both endpoint sets, SLA policy, AI assist, CSAT.
- `e2e/support-desk.e2e.test.ts`: 5 tests -- SLA due-times + first-response
  stamp, breach queue, suggested-reply (and that it is NOT posted), canned-
  response CRUD, and CSAT (allowed only after resolution).

### Validated

- `npm run build` passed (shared, api, worker, tracker).
- `npm test` passed: **363 tests across 53 suites**.
- `npm audit --audit-level=high` passed with **0 vulnerabilities**.

### Next

- Documentation: hosted reference from OpenAPI + real SDK packaging.

## v0.7.15 - Admin back-office: complete authenticated operator plane

Made the admin plane usable end-to-end. It previously had RBAC, audit, and
support/review tooling, but no way to actually authenticate (only an unwired
OIDC seam), so no operator could log in. Added password auth, admin-user
management, customer plan/quota control, a platform overview, and a bootstrap
CLI -- a SendGrid/Mailgun-style internal back-office, API-only.

### Added

- **Admin authentication (password).** `POST /admin/auth/login` (email +
  password, bcrypt at rest) issues an opaque, hashed 8h session token;
  `GET /admin/auth/me` resolves the caller; `POST /admin/auth/logout` revokes
  the session. OIDC/SSO remains supported in parallel.
- **Admin user management (superadmin).** `GET/POST /admin/admins`,
  `PATCH /admin/admins/:id` (role/disable/name), `POST /admin/admins/:id/password`.
  Disabling or password-resetting an admin revokes all their live sessions; a
  superadmin cannot self-demote/lock out (`cannot_self_demote`).
- **Customer plan/quota management.** `PATCH /admin/customers/:id` sets
  `tier` / `daily_quota` / `monthly_quota` (operator+), complementing the
  existing suspend/reinstate.
- **Platform overview.** `GET /admin/overview` returns customers-by-status,
  24h message volume by status, bounce/delivery rates, live send-queue depth,
  and suppression totals -- dashboard data over the existing metrics.
- **Bootstrap CLI** `create-admin` (password via `ADMIN_PASSWORD` env, never
  argv; idempotent — rotates the password if the admin already exists) so the
  first superadmin can be provisioned with no self-signup.
- Migration `015_admin_auth.sql` (adds `admin_users.password_hash`).
- `docs/ADMIN.md`: roles, auth flow, bootstrap, and full endpoint reference.
- `e2e/admin-flow.e2e.test.ts`: 13 tests — login/me/logout, RBAC enforcement,
  admin-user lifecycle with session revocation + self-demote guard, customer
  plan/quota updates, and the overview.

### Validated

- `npm run build` passed (shared, api, worker, tracker); `create-admin` CLI
  smoke-tested against a live DB.
- `npm test` passed: **358 tests across 52 suites**.
- `npm audit --audit-level=high` passed with **0 vulnerabilities**.

### Next

- Same end-to-end completion pass for chat support, then documentation
  (hosted reference + SDKs), per the module roadmap.

## v0.7.14 - Real OpenTelemetry tracing

Replaced the dependency-free tracing shim with a real OpenTelemetry SDK, keeping
the existing `startSpan` / `withSpan` / `startTracing` API so no callers changed.

### Added

- `tracing.ts` now backs spans with `@opentelemetry/api` + `@opentelemetry/sdk-node`.
  Span-creation uses the global tracer unconditionally: with no provider
  registered the OTel API returns non-recording (no-op) spans, so dev/test runs
  keep zero overhead. `startTracing()` registers a `NodeSDK` with an OTLP/HTTP
  trace exporter and auto-instrumentation for HTTP, Postgres (pg) and Redis
  (ioredis) -- still gated on `OTEL_EXPORTER_OTLP_ENDPOINT`, so it is a no-op
  until configured.
- `stopTracing()` flushes and shuts the tracer down on graceful exit.
- Tracing is now started in all three long-running services (api, worker,
  tracker); previously only the worker initialized it. Each flushes on SIGINT/
  SIGTERM.
- `withSpan` records exceptions, sets the span status to ERROR on throw, and
  always ends the span; child spans nest under the active span.
- `tracing.test.ts`: verifies real spans via an in-memory exporter -- attributes
  recorded, exceptions captured with ERROR status, and child/parent nesting.

### Dependencies

- Added `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`,
  `@opentelemetry/instrumentation-{http,pg,ioredis}`, `@opentelemetry/resources`,
  `@opentelemetry/semantic-conventions` to `@platform/shared`. `npm audit`
  remains at 0 vulnerabilities.

### Validated

- `npm run build` passed (shared, api, worker, tracker).
- Runtime smoke: `startTracing` initializes the NodeSDK + OTLP exporter +
  instrumentations, emits a span, and `stopTracing` shuts down cleanly.
- `npm test` passed: **345 tests across 51 suites**.
- `npm audit --audit-level=high` passed with **0 vulnerabilities**.

## v0.7.13 - Event-worker idempotency (exactly-once usage accounting)

Closes the last item from the worker-hardening follow-up: a retried or
duplicated event must not double-count `usage_daily` or insert a duplicate
event row.

### Fixed

- **Event processing was not idempotent.** If a step after the event insert
  failed and the job retried -- or a producer emitted the same event twice --
  the event row was re-inserted and the `usage_daily` delivered/bounced/
  complained counters double-counted. Usage drives billing, so this was a
  correctness bug. The event insert and the usage bump now commit together in a
  single transaction, gated on a fresh insert via `ON CONFLICT (event_key) DO
  NOTHING`.

### Added

- Migration `014_event_idempotency.sql`: `events.event_key TEXT` + a full unique
  index. (Full, not partial: Postgres treats NULLs as distinct so pre-existing
  keyless rows are unaffected, while `ON CONFLICT` can still infer the index --
  a partial index cannot be inferred without repeating its predicate.)
- Optional `event_key` on `EventJobData`; the usage-affecting producers (Haraka
  outbound delivered/soft/hard-bounce, Haraka inbound bounce/complaint) now mint
  a `crypto.randomUUID()` key per emit. Events without a key (opens/clicks,
  which are naturally multi-occurrence and don't touch usage) insert normally.
- Deterministic webhook fan-out job id (`wh:{webhook_id}:{event_row_id}`) so a
  re-run can't enqueue a duplicate delivery for the same event.
- `e2e/event-idempotency.e2e.test.ts`: same `event_key` twice -> one event row,
  usage counted once; distinct keys -> distinct rows and incremented usage.

### Design note

- The idempotency key is a **producer-supplied UUID**, deliberately NOT the
  BullMQ job id. A job id is a per-queue counter that resets on a Redis
  flush/failover; keying on it would make a new event collide with a recycled
  old id and be silently dropped. (This was caught in testing before shipping.)

### Validated

- `npm run build` passed (shared, api, worker, tracker); Haraka plugins
  `node --check` clean.
- `npm test` passed twice for stability: **341 tests across 50 suites**.
- `npm audit --audit-level=high` passed with **0 vulnerabilities**.

## v0.7.12 - Event & webhook worker hardening

A reliability sweep of the event and webhook workers, applying the same
bug-hunting that hardened the send worker. Found and fixed a real connection
leak plus two silent-failure gaps.

### Fixed

- **Webhook worker leaked connections.** The `undici` response body was never
  consumed, so each delivery pinned its connection until GC. Under load this
  exhausts the connection pool and stalls all webhook delivery. The body is now
  always drained (`res.body.dump()`) on every path. *(Verified at runtime: a
  2 KB response body delivers cleanly with no stall.)*
- **Webhook worker retried permanent client errors.** A `404`/`410`/`400` was
  retried like a `5xx`, hammering a dead endpoint and burning the whole retry
  budget. Now only `408`, `429`, and `5xx` are retried; other `4xx` are recorded
  and dropped. *(Verified: a `404` produces exactly one delivery attempt even
  with `attempts:3`.)*
- **Exhausted webhook/event jobs vanished silently.** Unlike the send worker,
  neither the webhook nor the event worker dead-lettered on retry exhaustion, so
  a permanently failing endpoint or poison event disappeared with no record.
  Both now dead-letter on exhaustion and increment `dead_letter_total`. *(Verified:
  a `500` with `attempts:1` lands in the dead-letter queue.)*

### Added

- `isRetryableStatus` exported from the webhook worker, with
  `webhook-retry.test.ts` (4 unit tests covering the 4xx/408/429/5xx
  classification).

### Known follow-up (not in this step)

- The event worker is not fully idempotent: if a step after the event insert
  fails and the job retries, the event row is re-inserted and `usage_daily`
  counters double-count. Doing this correctly needs an idempotency key + a
  unique constraint (a schema migration), so it's deferred rather than rushed.
  `writeClickhouseEvent` already swallows its own errors, so a ClickHouse outage
  is *not* a trigger; the window is a partial failure after the event insert.

### Validated

- `npm run build` passed (shared, api, worker, tracker).
- `npm test` passed: **339 tests across 49 suites**.
- `npm audit --audit-level=high` passed with **0 vulnerabilities**.

## v0.7.11 - Send-pipeline reliability fixes

A correctness pass on the send worker and outbox drain, closing two stranding
bugs and one concurrency race (the latter had surfaced as a flaky test).

### Fixed

- **Message stranded at `sending` on a preparation error.** In the send worker,
  message preparation (tracking-link rewrite, open-pixel injection, return-path
  build) ran *outside* the try/catch that handles delivery failures. If any of
  those threw, the job died with the row already flipped to `sending`; every
  retry then hit the `not in queued state — skipping` guard, so the message was
  stuck at `sending` forever. Preparation now runs inside the try, so a prep
  error follows the same path as a transport error.
- **Message left at `queued` after exhausting retries.** On retry exhaustion the
  job was dead-lettered but the row stayed `queued` with nothing left to
  re-drive it. The failure handler now moves the message to a terminal `failed`
  state (guarded so it never clobbers an `accepted`/`failed` row) and records a
  `failed` event.
- **Outbox double-claim race.** `drainSendOutbox` locked rows with `FOR UPDATE
  SKIP LOCKED` but only flipped them out of `pending` *after* the transaction
  committed. In the window after commit, a concurrent drainer could re-claim the
  same rows (double-incrementing attempts) while skipping others. Rows are now
  claimed (`status='enqueued'`) inside the transaction; the BullMQ enqueue
  still runs after commit and resets to `pending` on failure. Deterministic
  `jobId` dedup had prevented duplicate *jobs*, so no mail was double-sent — but
  the bookkeeping race was real and made the concurrent-drain test flaky
  (passing ~2/3). Now green 5/5 in isolation and across full runs.

### Added

- `e2e/send-stranding.e2e.test.ts` — 3 regression tests against the real worker
  (enqueued with `attempts:1` for instant exhaustion): transport failure ends
  `failed` (not `sending`), a `failed` event is recorded, and a preparation
  failure (forced via unset `VERP_SECRET`) also ends `failed` rather than
  stranding.

### Validated

- `npm run build` passed (shared, api, worker, tracker).
- `npm test` passed twice for stability: **335 tests across 48 suites**.
- `npm audit --audit-level=high` passed with **0 vulnerabilities**.

## v0.7.10 - Dashboard domain management

Sending domains were manageable only via an API key (`requireScope('domains')`).
The console now manages them from a human session too, sharing one org-scoped
service so the DKIM/DNS logic can't diverge, plus a detail endpoint that
re-surfaces the DNS records to publish.

### Added

- `domains.ts` in `@platform/shared` — org-scoped service: `listDomains`,
  `getDomainWithDnsRecords`, `addDomain` (DKIM keypair + DNS records;
  `domain_exists` carries the existing id), `verifyDomain` (DNS checks + flag
  persistence), `deleteDomain`, plus pure helpers `buildDomainDnsRecords` and
  `dkimPublicDnsValue`. Reuses the existing `generateDkimKeypair`; private keys
  stay encrypted at rest. Every query filters by `customer_id`.
- `routes/account-domains.ts` — session-authed endpoints gated by
  `domains:manage` (owner / admin / developer):
  - `GET /v1/account/domains`
  - `GET /v1/account/domains/:id` (detail with DNS records — new vs the API-key route)
  - `POST /v1/account/domains`
  - `POST /v1/account/domains/:id/verify`
  - `DELETE /v1/account/domains/:id`
- Audit events `domain.added` / `domain.verify_attempted` / `domain.deleted`.
- OpenAPI coverage (5 operations + `DomainAddRequest`) and an `API.md`
  "Dashboard Domains" section.
- Tests: `domains-service.test.ts` (12 DB-backed: add + 5 DNS records, encrypted
  private key, lowercasing, duplicate-with-id, same domain across orgs, listing,
  detail/null cross-org, unverified verification + flag persistence, delete,
  pure helpers) and `e2e/account-domains.e2e.test.ts` (6 HTTP-flow: lifecycle,
  duplicate 409 with domain_id, invalid domain 400, auth required,
  domains:manage denies an analyst, cross-org 404) plus an OpenAPI regression
  test.

### Changed

- `routes/domains.ts` (the API-key route) refactored to use the shared service.
  External behavior unchanged: same endpoints, same `201`/`204`/`404`, same
  `409 domain_exists` (still including `domain_id`).

### Validated

- `npm run build` passed (shared, api, worker, tracker).
- `npm test` passed: **332 tests across 47 suites**.
- `npm audit --audit-level=high` passed with **0 vulnerabilities**.

## v0.7.9 - Dashboard webhook management

Webhooks were manageable only via an API key (`requireScope('webhooks')`). The
console now manages them from a human session too, sharing one org-scoped
service so the two paths can't diverge, and adding the enable/disable and
secret-rotation controls a dashboard needs.

### Added

- `webhooks.ts` in `@platform/shared` — org-scoped service (`listWebhooks`,
  `createWebhook`, `updateWebhook`, `deleteWebhook`, `rotateWebhookSecret`,
  `WEBHOOK_EVENT_TYPES`, `WebhookError`). Every query filters by `customer_id`;
  the SSRF guard (`resolveAndAssertPublicUrl`) runs at create and on url change.
- `routes/account-webhooks.ts` — session-authed endpoints gated by
  `settings:manage` (owner / admin):
  - `GET /v1/account/webhooks`
  - `POST /v1/account/webhooks`
  - `PATCH /v1/account/webhooks/:id` (url / events / enabled)
  - `POST /v1/account/webhooks/:id/rotate-secret`
  - `DELETE /v1/account/webhooks/:id`
- Audit events `webhook.created` / `webhook.updated` / `webhook.secret_rotated`
  / `webhook.deleted`.
- OpenAPI coverage (5 operations + `WebhookCreateRequest` / `WebhookUpdateRequest`)
  and an `API.md` "Dashboard Webhooks" section.
- Tests: `webhooks-service.test.ts` (10 DB-backed: create + SSRF rejection +
  event validation, org-scoped listing, partial update with SSRF re-check,
  secret rotation, delete, cross-org isolation) and
  `e2e/account-webhooks.e2e.test.ts` (5 HTTP-flow: full lifecycle, SSRF 400,
  auth required, settings:manage denies a developer, cross-org 404) plus an
  OpenAPI regression test.

### Changed

- `routes/webhooks.ts` (the API-key route) refactored to use the shared
  service. External behavior is unchanged: same endpoints, same `201`/`204`
  responses, same `invalid_webhook_url` rejection.

### Validated

- `npm run build` passed (shared, api, worker, tracker).
- `npm test` passed: **313 tests across 45 suites**.
- `npm audit --audit-level=high` passed with **0 vulnerabilities**.

## v0.7.8 - Active session management

Users can now see and control their own login sessions. The session primitives
existed (revoke-current, revoke-all) but there was no way to list active
sessions or end a specific one — a standard account-security feature.

### Added

- Session service functions in `@platform/shared/user-sessions.ts`:
  - `listUserSessions(userId)` — active (non-revoked, non-expired) sessions,
    most-recently-active first, metadata only (never the token hash).
  - `revokeUserSessionById(userId, sessionId)` — owner-scoped per-session
    revocation; idempotent; refuses other users' sessions.
  - `revokeOtherUserSessions(userId, keepSessionId)` — "log out everywhere
    else", returning the count revoked.
- Session-authed endpoints (`requireFullUser`):
  - `GET /v1/auth/sessions` — list, flagging the current request's session.
  - `POST /v1/auth/sessions/revoke-others` — keep current, revoke the rest.
  - `DELETE /v1/auth/sessions/:id` — revoke one (404 if not the caller's).
- Audit events `user.session_revoked` and `user.sessions_revoked_others`.
- OpenAPI coverage (`listUserSessions`, `revokeOtherUserSessions`,
  `revokeUserSession`) and an `API.md` "Active Sessions" section.
- Tests: `session-management.test.ts` (9 DB-backed: listing ordering/metadata,
  exclusion of revoked/expired, owner-scoped revoke, idempotency, cross-user
  refusal, revoke-others count + isolation) and
  `e2e/account-sessions.e2e.test.ts` (5 HTTP-flow: list with current flag,
  per-session revoke invalidates that token, revoke-others keeps current,
  cross-user 404, auth required) plus an OpenAPI regression test.

### Validated

- `npm run build` passed (shared, api, worker, tracker).
- `npm test` passed: **297 tests across 43 suites**.
- `npm audit --audit-level=high` passed with **0 vulnerabilities**.

## v0.7.7 - Self-service API key management

Customers can now manage their own API keys from a dashboard session, instead of
keys being mintable only via the admin token / admin sessions. This is a core
prerequisite for the customer console.

### Added

- `apikey-management.ts` in `@platform/shared` — org-scoped service:
  `listCustomerApiKeys`, `createCustomerApiKey`, `revokeCustomerApiKey`,
  `rotateCustomerApiKey`, and `validateScopes`, plus `API_KEY_SCOPES` /
  `API_KEY_TYPES`. Every query filters by `customer_id`, so one org can never
  see or mutate another's keys. Plaintext is returned only once, at
  creation/rotation; listings are metadata-only.
- `routes/keys.ts` — session-authed endpoints gated by `apikeys:manage`
  (owner / admin / developer):
  - `GET /v1/account/api-keys`
  - `POST /v1/account/api-keys`
  - `POST /v1/account/api-keys/:id/rotate`
  - `DELETE /v1/account/api-keys/:id`
- Rotation mirrors the admin overlap behavior: the old key expires after
  `KEY_ROTATION_OVERLAP_HOURS` (default 48) so clients can cut over with no
  downtime.
- Publishable keys are forbidden from holding the `send` scope (defense in
  depth for client-embeddable keys).
- OpenAPI coverage (`listAccountApiKeys`, `createAccountApiKey`,
  `rotateAccountApiKey`, `revokeAccountApiKey`, `ApiKeyCreateRequest`) and an
  `API.md` "Self-service API Keys" section.
- Tests: `apikey-management.test.ts` (16 DB-backed: validation, create, list
  metadata-only, status derivation, revoke idempotency + cross-org refusal,
  rotation with overlap + cross-org/revoked guards) and
  `e2e/account-keys.e2e.test.ts` (6 HTTP-flow: create/list/rotate/revoke,
  created key authenticates, publishable+send rejected, anonymous 401, analyst
  denied by capability, cross-org 404) plus an OpenAPI regression test.

### Validated

- `npm run build` passed (shared, api, worker, tracker).
- `npm test` passed: **282 tests across 41 suites**.
- `npm audit --audit-level=high` passed with **0 vulnerabilities**.

## v0.7.6 - Platform transactional email (verify / reset / invite)

The human-auth flows now actually deliver email. Email verification, password
reset, and team invites previously only exposed `_dev_*` tokens in non-prod
responses with no delivery path; they now send real mail through a pluggable
platform mailer, while keeping the `_dev_*` tokens for local development.

### Added

- `mailer.ts` in `@platform/shared` — a `PlatformMailer` provider abstraction
  (same pattern as `inference.ts` / `kms.ts`) with three implementations:
  - `TransportPlatformMailer` — real delivery via the configured `Transport`
    (SES or Haraka). Used in production.
  - `LoggingPlatformMailer` — logs the rendered mail; local-dev default.
  - `CapturingPlatformMailer` — records sent mail in memory for tests.
- Env-based provider selection (`PLATFORM_MAIL_DELIVERY` = `transport|log|capture`;
  defaults to transport in production, capture under test, log otherwise) plus
  `getPlatformMailer()` / `setPlatformMailer()`.
- Three rendered transactional templates (html + text) with token-bearing,
  URL-encoded links to `APP_BASE_URL`: `sendEmailVerificationEmail`,
  `sendPasswordResetEmail`, `sendTeamInviteEmail`.
- New env vars documented in `.env.example`: `PLATFORM_MAIL_DELIVERY`,
  `PLATFORM_MAIL_FROM`, `APP_BASE_URL`.
- `mailer.test.ts` (9 unit tests) and `e2e/auth-mail.e2e.test.ts` (5 HTTP-flow
  tests) covering provider behavior, template links, recipient targeting,
  no-enumeration on unknown forgot, and best-effort resilience.

### Changed

- `POST /v1/auth/register` sends a verification email; `POST
  /v1/auth/password/forgot` sends a reset email (only for known accounts — the
  always-200 anti-enumeration response is unchanged); `POST /v1/team/invites`
  sends an invite email including the org name. All sends are best-effort: a
  mailer failure is logged and never breaks the request, and `_dev_*` token
  exposure outside production is preserved.

### Notes

- Platform mail is sent on its own thin path, deliberately separate from
  customer `/v1/send` mail — it never counts against customer quota or hits the
  abuse pipeline. A future step can move sends onto the existing BullMQ for
  async retry; today they are awaited best-effort.

### Validated

- `npm run build` passed (shared, api, worker, tracker).
- `npm test` passed: **259 tests across 39 suites**.
- `npm audit --audit-level=high` passed with **0 vulnerabilities**.

## v0.7.5 - Atomic account registration

Closed the last known data-integrity gap in the identity layer. `POST
/v1/account/auth/register` previously created the user, the org (`customers`
row), and the owner membership as three separate non-atomic writes, so a
mid-sequence failure could leave an orphaned user, an org with no owner, or a
user with no membership. All three writes now commit together or roll back
together.

### Added

- `registerOrgWithOwner` in `@platform/shared` — wraps user + customer + owner
  membership creation in a single Postgres transaction, preserving the distinct
  `email_exists` / `org_exists` errors as typed `IdentityError`s.
- Optional transaction-executor parameter on `createUser` and `addMembership`
  (mirroring the `executor` convention in `outbox.ts`) so identity writes can
  enlist in a caller's transaction.
- `register-atomic.test.ts` — DB-backed integration tests, including the
  headline guarantee that a customer-email collision rolls back the user insert
  and leaves **no orphan user** behind.

### Changed

- `account.ts` register handler now delegates to `registerOrgWithOwner`. The
  HTTP contract is unchanged: same request shape, same `201` response, same
  `409` `email_exists` / `org_exists` error codes.

### Validated

- `npm run build` passed (shared, api, worker, tracker).
- `npm test` passed: **245 tests across 37 suites**.
- `npm audit --audit-level=high` passed with **0 vulnerabilities**.

## v0.7.4 - Customer support OpenAPI contract


Added the customer support ticket API surface to the published OpenAPI spec so
typed SDKs and contract consumers can discover the human-session support flows.

### Added

- `userSessionAuth` bearer scheme for `mpu_…` human session tokens.
- `/support/tickets` list/create operations.
- `/support/tickets/unread-count` unread-count operation.
- `/support/tickets/{id}` detail operation.
- `/support/tickets/{id}/read` read-marker operation.
- `/support/tickets/{id}/messages` reply operation.
- OpenAPI regression tests for support operation IDs, schemas, and session auth.

### Validated

- `npm run build` passed.
- `npm test` passed: **239 tests across 36 suites**.
- `npm audit --audit-level=high` passed with **0 vulnerabilities**.
- Rebuilt/restarted the API container and verified live `/openapi.json` includes
  the support paths and `userSessionAuth`.
- Live `/health` passed with Postgres, Redis, and queue checks OK.

## v0.7.3 - Migration runner regression coverage

Added automated coverage for the tracked migration paths introduced in v0.7.2.

### Added

- DB-backed migration tests that create temporary databases and verify:
  - a fresh database applies all 13 migrations and records checksums;
  - a raw-SQL initialized database can be baselined without replaying migrations.

### Validated

- `npm run build` passed.
- `npm test` passed: **236 tests across 36 suites**.
- `npm audit --audit-level=high` passed with **0 vulnerabilities**.
- Live `/health` passed with Postgres, Redis, and queue checks OK.

## v0.7.2 - End-to-end validation and tracked Docker migrations

Validated the platform across build, tests, live Docker health checks, migration
state, security audit, and MTA startup logs.

### Fixed

- Docker app services now run the checksum-tracked migration runner before
  starting, and images include `infra/migrations`.
- Removed the raw Postgres `/docker-entrypoint-initdb.d` migration mount from
  Compose so fresh container databases use tracked migrations from day one.
- Added `npm run migrate:baseline` for older local databases that were already
  initialized by raw SQL before `schema_migrations` was populated.
- Added inbound Haraka `log.ini` and `tls.ini`, replaced deprecated
  `data.headers` with `headers`, and made log format explicit for both MTAs.
- Removed the obsolete Compose `version` key.

### Validated

- Existing local DB baselined with all 13 migration checksums.
- Fresh temporary DB applied all 13 migrations through `npm run migrate`.
- Rebuilt and restarted API, worker, tracker, inbound Haraka, and outbound
  Haraka containers.
- Live `/health` passed with Postgres, Redis, and queue checks OK.
- `npm run build`, `npm test`, `npm audit --audit-level=high`, and
  `docker compose config --quiet` passed.

## v0.7.1 - Support inbox read state

Added per-viewer support ticket read markers so both customer and admin inboxes
can show reliable unread counts.

### Added

- `support_ticket_reads` migration with per-customer-user and per-admin read
  markers.
- Customer endpoints: `GET /v1/support/tickets/unread-count` and
  `POST /v1/support/tickets/:id/read`.
- Admin endpoints: `GET /admin/support-tickets/unread-count` and
  `POST /admin/support-tickets/:id/read`.
- E2E coverage for customer unread/read behavior while keeping internal admin
  notes hidden.

### Fixed

- Hardened unread counting with explicit grouped predicates so tenant filters
  cannot be bypassed by SQL `AND`/`OR` precedence.

Validated with `npm run build` and `npm test`: **234 tests across 35 suites**.

## v0.7.0 — External audit bug batch (12 fixes + E2E race)

Verified and fixed a 12-item bug report plus the headline E2E race condition.
Every item was checked against the actual code before fixing; one (VERP parsing)
was initially in doubt and confirmed real by testing Haraka's real Address class.
Test count 142 -> **156 across 23 suites**; build clean; 0 vulnerabilities.

### Fixed — critical / high

- **Inbound VERP bounce parsing (bug 1, critical).** `extractMessageIdFromVerp`
  split `envelope.original`, which keeps angle brackets (`<bounce+enc.sig@...>`),
  so the local part was `<bounce+enc.sig` and the VERP regex failed every time —
  meaning hard bounces would never suppress, risking delivery loops and IP
  reputation damage. Now uses Haraka's pre-parsed `envelope.user` (bracket-free),
  with a bracket-stripping fallback. Confirmed against the real `address-rfc2821`
  Address class.
- **Classifier shared RegExp race (bug 2).** Module-level `/g` regex carried
  mutable `lastIndex` across concurrent `extractDomains` calls. Switched to a
  per-call regex with `matchAll`.
- **Quota cold-seed race (bug 3).** Concurrent requests could INCR a cold key to
  0 before the Postgres baseline was seeded, discarding it. Seeding is now atomic
  (Lua set-or-add-baseline) and losers wait for the seed instead of racing it.
- **List-quality param-limit crash (bug 4).** `where('domain','in', …)` with
  >65k unique domains exceeded Postgres' bind-parameter limit. Chunked to 5000.
- **DKIM grace period bypass (bug 5).** Retirement compared `activated_at`, so a
  key active >TTL retired immediately on demotion. Added `retiring_at`
  (migration 006), set at demotion, and retire based on it.

### Fixed — medium / low

- **Sequential suppression import (bug 6).** Replaced the per-address await loop
  with `addSuppressionsBulk`: chunked multi-row INSERTs + pipelined Redis.
- **Soft-bounce double-write (bug 7).** Increment and window-reset folded into a
  single atomic upsert with SQL CASE.
- **Stripe multi-item price (bug 8).** Webhook now selects the item whose price
  maps to a known tier instead of blindly `items[0]`.
- **Template PUT validation (bug 9).** PUT now runs the same Handlebars
  `validateTemplate` check as POST.
- **Migration advisory lock (bug 10).** `runMigrations` wraps work in
  `pg_advisory_lock` so concurrent worker boots serialize.
- **Pagination NaN crash (bug 11).** `limit`/`offset` sanitized with parseInt +
  bounded fallbacks.
- **Default admin token (bug 12).** Added `dev-admin-token-change-me` (and the
  default pepper) to the config-guard blocklist.

### Fixed — E2E race (headline)

- The send worker set `status='accepted'` before `bumpUsage`, so a reader seeing
  `accepted` could observe usage=0. Reordered: event + usage are committed
  before the status flips to `accepted`, closing the race at the source.


## v0.6.3 — Haraka connection.ini completed (relay no longer crashes)

The outbound relay crashed per-connection with
`TypeError: Cannot read properties of undefined (reading 'greeting')` at
`connection.js:787`, leaving messages stuck cycling `queued -> sending -> queued`.
Same root cause as the earlier `haproxy.hosts` crash: Haraka 3.2.x reads several
`connection.ini` sections at connection time without fully guarding their
absence, and our file only defined some of them.

### Fixed

- Completed `connection.ini` in both Haraka packages with **all six sections
  `connection.js` reads**: `[main]`, `[haproxy]`, `[headers]`, `[message]`,
  `[uuid]`, `[max]`. Previously only `[haproxy]`/`[headers]` (v0.6.1) and
  `[message]`/`[uuid]` were present/added; `[main]` (read during EHLO/MAIL/RCPT
  as `cfg.main.smtputf8` / `cfg.main.strict_rfc1869`) was still missing and would
  have crashed on the next protocol phase. Verified by diffing against the code's
  `cfg.<section>` accesses and replaying the exact `connect_respond` greeting
  logic — all sections now resolve.

### Note

This is the last of the Haraka config/version issues in the startup+connect
path. Messages now relay through outbound Haraka. Actual delivery to external
recipients still depends on sender-IP reputation (e.g. residential IPs are on
Spamhaus ZEN) and real DNS — expected, and outside the application code.


## v0.6.2 — Outbound Haraka plugin fix

Fixes the outbound Haraka container, which still exited after v0.6.1 (inbound and
Grafana were fixed; outbound failed later in startup for a different reason).

### Fixed

- **`Loading plugin auth/auth_flat_file failed: No plugin with this name found`**
  — Haraka 3.2.x renamed the bundled flat-file auth plugin from
  `auth/auth_flat_file` to `auth/flat_file`. Updated
  `packages/haraka-outbound/config/plugins` to the new name.
- **Worker SMTP AUTH would have failed silently** — the renamed plugin reads
  credentials from a `[users]` section, but `auth_flat_file.ini` had the worker
  credential at the top level. Moved it under `[users]`. Verified outbound Haraka
  now loads all plugins and progresses to binding its listener (the previous
  crash point is gone).


## v0.6.1 — Deployment fixes (Grafana provisioning, Haraka startup)

Fixes three issues that surfaced bringing the full Docker stack up from a clean
unzip. No application logic changed; all 142 tests still pass.

### Fixed

- **Grafana provisioning files used `//` comments** in YAML, which Grafana's
  parser rejects (`provider.yml error: yaml: line 3: mapping values are not
  allowed`), so the container exited and dashboards never loaded. Switched both
  `provisioning/datasources/prometheus.yml` and
  `provisioning/dashboards/provider.yml` to `#` comments. Verified they parse as
  valid YAML.
- **Haraka (inbound + outbound) crashed on startup** with
  `TypeError: Cannot read properties of undefined (reading 'hosts')` at
  `connection.js:40`. Haraka 3.2.x reads `[haproxy] hosts[]` from `connection.ini`
  at load time and does not guard against the section being absent; our config
  dirs had no `connection.ini`. Added a minimal `connection.ini` (empty
  `hosts[]`) to both `packages/haraka-inbound/config` and
  `packages/haraka-outbound/config`. Verified `connection.js` loads cleanly
  against the new config.
- **Haraka version was an unpinned `^3.0.5`** (floating to latest, which is how
  the breaking change slipped in). Pinned to `3.2.1` in both Haraka packages for
  reproducible builds.


## v0.6.0 — Open/click bot detection + monitoring completion

Adds end-to-end bot/machine-event detection for opens and clicks, and completes
the Prometheus/Grafana monitoring so the dashboards work out of the box. Test
count rises to **142 across 21 suites**; clean build; `npm audit` clean.

### Added — bot detection

- **`bot-detection.ts`** — multi-signal classifier (`human` / `bot` /
  `suspicious` + confidence) blending: known machine user-agents (Apple MPP,
  Gmail/Yahoo image proxies, Proofpoint/Mimecast/Barracuda/Defender scanners,
  curl/python/headless), datacenter/proxy IP CIDR ranges, sub-2s prefetch
  timing, and click-without-human-open patterns.
- **Tracker** classifies every open/click at request time (using delivery
  timing + prior-open state) and attaches the verdict to the event.
- **Event worker** persists the verdict on the event row and routes human events
  to `human_opened_at` / `human_clicked_at` while machine events set
  `machine_opened_at` — raw events are never dropped, just flagged.
- **Migration `005_bot_detection.sql`** — `events.bot_verdict` / `bot_score`,
  message human/machine engagement timestamps, and an analytics index.
- **API** — messages list now returns `human_opened_at` / `human_clicked_at`;
  the event timeline includes `bot_verdict` / `bot_score`.
- 24 new tests (18 classifier unit + 6 end-to-end through the event worker).

### Added / fixed — monitoring

- **Grafana auto-provisioning** — datasource (`provisioning/datasources`) and
  dashboard provider (`provisioning/dashboards`) so the bundled dashboard and
  Prometheus source load with no manual setup. (Previously the dashboard JSON
  was mounted but nothing loaded it.)
- **Tracker `/metrics`** endpoint added and registered as a Prometheus scrape
  target (previously only API + worker were scraped).
- New **`mp_engagement_events_total{event_type,verdict}`** metric and a Grafana
  panel charting human/bot/suspicious opens & clicks.
- Monitoring runs behind the `monitoring` compose profile:
  `docker compose --profile monitoring up -d`. Grafana on `:3001`
  (`admin`/`admin`), Prometheus on `:9090`. Documented in the README.


## v0.5.0 — Test hardening across untested subsystems

Expands automated coverage from 79 → **118 tests across 19 suites**, targeting
the subsystems that previously had code but no direct tests, and fixes a config
defect plus a flaky-test race. All packages typecheck clean; `npm audit` reports
0 vulnerabilities.

### Added (tests)

- **Quota** (`quota.test.ts`) — atomic daily/monthly reservation, exact-boundary
  enforcement, partial-consumption rejection, release, and a concurrent
  no-oversell test that proves the Lua check-and-incr never sells past the limit.
- **Suppression + soft-bounce** (`suppression-softbounce.test.ts`) — add/detect/
  remove with case-insensitivity, per-customer scoping, idempotent inserts, and
  soft-bounce escalation to suppression at the configured limit with counter
  reset on delivery.
- **Bounce/complaint parser** (`bounce-parser.test.ts`) — the inbound Haraka
  DSN/ARF parser against realistic Gmail/Yahoo/Outlook bounce bodies (structured
  Status, SMTP-code fallback, attachment-delivered DSNs) and **forged-VERP
  rejection** (tampered/wrong-secret tokens must not suppress recipients).
- **Templates** (`templates.test.ts`) — Handlebars rendering across
  subject/html/text, missing-variable behavior, nested vars, and HTML-escaping
  (injection safety) plus malformed-template validation.
- **Reputation guard** (`reputation.test.ts`) — auto-pause at >5% bounce,
  throttle at elevated-but-sub-threshold, ok when healthy, and publication of the
  decision to Redis for the send path to honor.

### Fixed

- **Postgres healthcheck** (`docker-compose.yml`) — `pg_isready -U mail` had no
  `-d`, so it connected to a nonexistent database named `mail` and logged
  `FATAL: database "mail" does not exist` every 5s. Now targets `mail_platform`.
- **Flaky concurrent-quota test** — pre-warms the counter so the test isolates
  the atomic-INCR boundary rather than the cold-start seeding race; now
  deterministic (exactly 6 of 10 pass) across repeated runs.

### Changed

- Exposed the bounce parser's pure functions via `_internal` for unit testing
  (no behavior change to the Haraka hooks).
- Added `seedMessages`, `getPoolAction`, `clearPoolMessages` test-kit helpers.


Adds a full end-to-end test layer that boots the real API + send worker against
live Postgres/Redis, and fixes latent defects that the new integration coverage
surfaced. All packages typecheck clean and **79 tests pass across 14 suites**
(54 unit + 25 end-to-end).

### Fixed (correctness — found by the new E2E layer)

- **`db` lazy Proxy returned unbound methods** (`packages/shared/src/db.ts`).
  Calling `db.insertInto(...)` (and any other method) executed with `this` set to
  the Proxy rather than the Kysely instance, throwing "Cannot read private member
  #props" whenever `db` was the immediate call receiver. Methods are now bound to
  the real instance.
- **`db.fn.sum` / `db.fn.count` were stripped** by method binding — `db.fn` is a
  callable carrying helper methods, and a naïve `.bind()` dropped them, breaking
  monthly-quota reconciliation. Own-properties are now preserved on bound
  callables.
- **Migration CLI path resolution** — `node …/bin/migrate.js` resolved
  `infra/migrations` relative to `process.cwd()`, which failed when invoked via
  `npm --workspace`. CI now passes the directory explicitly.

### Changed (security / dependencies)

- Upgraded **Fastify 4 → 5** (API + tracker) with matching plugin majors
  (`@fastify/rate-limit` 10, `@fastify/sensible` 6, `@fastify/cors` 10,
  `@fastify/formbody` 8), **nodemailer 6 → 8**, **kysely 0.27 → 0.28**, and
  **vitest 1 → 4**. This closes 7 high-severity advisories (Kysely SQL-injection
  vectors, nodemailer SMTP command-injection) and the dev-time esbuild/vite
  advisory. `npm audit` now reports **0 vulnerabilities** (prod and dev).
- Fastify 5 breaking changes addressed: error-handler `err` typing and the
  `reply.redirect(url, code)` argument order in the tracker.

### Changed (consistency)

- **Unified API-key issuance on the typed HMAC v2 scheme.** Public signup, the
  admin key-creation route, and the seed script now use `generateApiKeyV2` and
  persist `key_type` (`secret` / `test` / `publishable`) instead of the legacy
  bcrypt `generateApiKey`. The verifier still accepts legacy bcrypt hashes for a
  migration window. Admin key creation accepts an optional `key_type`.

### Added

- `packages/tests/e2e/` — end-to-end suite (send pipeline, auth/validation,
  quota, idempotency, suppression, abuse, resource CRUD, signup) plus a harness
  that assembles the real app and worker.
- `packages/shared/src/testkit.ts` — integration seeding/query helpers that run
  in the shared module realm.
- `docs/TESTING.md`; `npm test`, `npm run test:e2e`, `npm run test:unit`
  scripts; CI now runs the full unit + E2E suite with Postgres/Redis services.


## v0.3.0 — Phase 1 code hardening

Correctness, security, and reliability fixes that move the platform toward
production. All packages typecheck clean (`tsc --noEmit`) and the unit suite
passes (`vitest`, 22 tests). These still require a full `docker compose` build
and integration test in a real environment before carrying customer traffic.

### Changed (security / correctness)

- **DKIM signing** rewritten to use the `mailauth` library instead of
  hand-rolled canonicalization, and made **fail-closed**: the outbound MTA now
  `DENYSOFT`s (retries) rather than delivering unsigned mail when signing fails.
  The Postgres lookup uses a pooled, auto-reconnecting client.
  (`packages/haraka-outbound/plugins/customer_dkim.js`)
- **Signed VERP bounce tokens** — return-paths are HMAC-SHA256 signed and
  verified on inbound, so forged bounces can no longer suppress arbitrary
  recipients. Requires `VERP_SECRET` to match across API, worker, and inbound.
  (`buildVerpToken` / `verifyVerpToken` in `packages/shared/src/crypto.ts`)
- **`held` message status** — content flagged for review is set to `held`
  (not `queued`), so the send worker never picks it up. Fixes a latent
  `'queued'/'queued'` dead branch. (migration `003_hardening.sql`)
- **Idempotency keys** on `POST /v1/send` — `Idempotency-Key` header reserves,
  replays, or rejects (on body mismatch) duplicate requests.
  (`packages/shared/src/idempotency.ts`)
- **Startup secrets guard** — refuses to boot in `NODE_ENV=production` with
  known-default or too-short secrets. (`packages/shared/src/config-guard.ts`)
- **Dead-letter queue** for jobs that exhaust retries, with a `mp_dead_letter_total`
  metric. (`packages/shared/src/queues.ts`, send worker `failed` handler)
- **Standard error envelope** `{error, message, request_id}` plus a request-id
  on every response/log line. (`packages/api/src/plugins/error-envelope.ts`)
- **Deep health checks** — `/health` and `/ready` verify Postgres, Redis, and
  the queue; `/live` is a cheap liveness probe. (`packages/api/src/server.ts`)
- **HTML tracking transform** rewritten with a real parser (`cheerio`) in a
  single pass, with `tracked_links` batch-inserted in one statement instead of
  one round-trip per link. (`packages/worker/src/send-worker.ts`)

### New environment variables

- `VERP_SECRET` (required in prod, >=16 chars, identical across API/worker/inbound)
- `DKIM_REQUIRED` (default `true`; set `false` only for local dev)
- `DKIM_PG_POOL_MAX` (default 4), `IDEMPOTENCY_TTL_HOURS` (default 24)

### Migration note

On an **existing** database, apply `infra/migrations/003_hardening.sql` by hand
(`npm run migrate` now applies all migrations in order). Fresh volumes auto-run it.

---

## v0.2.0 — Production-hardening pass

This release closes the biggest gaps between "working skeleton" and "shippable
service." Every package compiles (`tsc` clean) and the unit test suite passes
(`vitest`, 15 tests).

### Added

**Pluggable delivery transport** (`packages/shared/src/transport.ts`)
- Switch between Amazon SES and self-hosted Haraka via `DELIVERY_TRANSPORT` env var
- SES path offloads IP reputation to Amazon — the recommended way to launch
- Same code path for both; migrate to your own IPs later without rewrites

**DKIM key encryption at rest** (`packages/shared/src/encryption.ts`)
- AES-256-GCM envelope encryption for DKIM private keys
- Matching decryption in the Haraka signing plugin
- Backwards-compatible: legacy plaintext keys still readable during migration

**Abuse prevention** (`packages/shared/src/abuse.ts`)
- Content scanning with a weighted spam-phrase classifier (allow/review/block)
- Volume-anomaly detection comparing hourly rate against a rolling baseline
- Flagged messages routed to a `review_queue` instead of sending
- Anomalous senders auto-routed to the `quarantine` IP pool

**IP warming scheduler** (`packages/shared/src/warmup.ts`)
- Per-pool daily send caps that ramp over a 17-stage schedule
- Enforced at send time; over-cap sends get `429 pool_capacity_exceeded`
- Hourly cron in the worker advances stages based on real usage

**Observability** (`packages/shared/src/metrics.ts`)
- Prometheus metrics across API and worker (`/metrics` endpoints)
- Counters: accepted, sent, delivered, bounced, complaints, blocked
- Queue-depth gauge, send-duration histogram, webhook outcomes
- Prometheus + Grafana services in compose (`--profile monitoring`)
- Alert rules for bounce rate >5%, complaint rate >0.3%, queue backlog

**Templates** (`packages/shared/src/templates.ts`, `routes/templates.ts`)
- Handlebars templates with variable substitution
- Full CRUD API, compile-time validation
- Reference by `template_id` + `variables` in `POST /v1/send`

**Billing** (`routes/billing.ts`)
- Stripe-style webhook with signature verification
- Maps subscription events to tier / quota / billing_status
- Monthly quota enforcement alongside daily

**Usage & analytics** (`routes/usage.ts`)
- `GET /v1/usage` — daily sent/delivered/bounced/complained + computed rates
- `GET /v1/stats` — event-type aggregates over a window
- Surfaces complaint-rate health against the 0.3% ISP threshold

**API-key scope enforcement** (`plugins/scope.ts`)
- Every route now checks the key's scopes
- `admin` scope grants all; granular scopes (`send`, `domains`, etc.) otherwise

**Tests** (`packages/tests/`)
- Vitest suite covering encryption round-trip, abuse classification, warmup
  schedule, message-ID encoding
- Lazy DB connection so importing `@platform/shared` needs no live database

### Changed

- `messages` table: added `template_id`, `provider_message_id`, `risk_score`
- `customers` table: added `monthly_quota`, `stripe_customer_id`, `billing_status`
- DB connection is now lazy (proxy-based) — no DB required just to import shared code
- Send worker uses the transport abstraction + records metrics, usage, warmup counters
- Event worker records delivery/bounce/complaint metrics and usage

### Migration

Run both migrations in order:
```
psql $DATABASE_URL -f infra/migrations/001_init.sql
psql $DATABASE_URL -f infra/migrations/002_product.sql
```
(Docker Compose runs both automatically on first boot.)

### New environment variables

See `.env.example`. Key additions:
- `DELIVERY_TRANSPORT` (`ses` | `haraka`)
- `ENCRYPTION_KEY` (32-byte hex — generate with `openssl rand -hex 32`)
- `SES_SMTP_HOST/PORT/USER/PASS` (when using SES)
- `STRIPE_WEBHOOK_SECRET`
- `WORKER_METRICS_PORT`

### Honest status

This is now a credible ~7/10 codebase: it builds, tests pass, and the
deliverability/abuse/security/observability gaps that made the skeleton
unshippable are addressed in code. The remaining path to a true production
launch is operational, not code: real IPs + PTR records (or commit to SES),
ISP postmaster registrations, a customer-facing dashboard, ClickHouse for
events at scale, and load testing. See `docs/PRODUCTION_CHECKLIST.md`.
