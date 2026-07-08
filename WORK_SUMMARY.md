# Work Summary

## T1 - Multi-provider billing registry + PayPal provider

Status: done.

Implemented:

- Migration `019_billing_provider.sql` adds `customers.billing_provider`.
- `BillingProvider` registry with `registerBillingProvider()` and
  `getBillingProviderFor()`.
- Back-compatible `getBillingProvider()` / `setBillingProvider()`.
- `PayPalBillingProvider` REST scaffold with OAuth and subscription approval.
- Customer checkout, portal, overview, metered usage, and subscription state now
  select providers from the customer row.
- Provider-keyed webhook route `POST /v1/billing/webhook/:provider`, with
  `POST /v1/billing/webhook` preserved as the Stripe path.
- OpenAPI and billing docs updated.

Tests added:

- `packages/tests/e2e/billing-multiprovider.e2e.test.ts` (4 tests).
- `packages/tests/openapi.test.ts` assertion for billing webhooks.

Validation:

- `npm run build`: passed.
- `npm test`: 390 tests across 58 suites passed.
- `npm audit --audit-level=high`: 0 vulnerabilities.

Live-path caveat:

- Stripe and PayPal live REST/webhook calls are implemented behind seams but not
  credential-verified in this sandbox. Verify with Stripe test keys and a PayPal
  sandbox app during deployment.

## T2 - Dead-letter queue admin inspection/replay/purge

Status: done.

Implemented:

- Shared helpers for DLQ list/detail/replay/delete/purge in
  `packages/shared/src/queues.ts`.
- Admin endpoints under `/admin/dlq`, gated by `requireAdmin('operator')`.
- Replay re-enqueues a fresh job to the original `send`, `events`, or
  `webhooks` queue and removes the DLQ entry.
- Purge requires an explicit `{ "confirm": true }` body.
- Admin audit events for DLQ replay/delete/purge.

Tests added:

- `packages/tests/e2e/dlq.e2e.test.ts` (4 tests).

Validation:

- `npm run build`: passed.
- Targeted DLQ/admin E2E passed: 17 tests across 2 suites.
- `npm test`: 394 tests across 59 suites passed.
- `npm audit --audit-level=high`: 0 vulnerabilities.

## T3 - Admin MFA (TOTP)

Status: done.

Implemented:

- Migration `020_admin_mfa.sql` adds `admin_users.totp_secret` and
  `admin_users.totp_enabled`.
- Shared admin MFA helpers for enroll/confirm/verify/disable in
  `packages/shared/src/admin.ts`.
- TOTP secrets are encrypted at rest with the existing secret encryption helper.
- Admin password login now returns `mfa_required` when a code is missing and
  `mfa_invalid` when a code is wrong.
- Self-service authenticated admin endpoints:
  `/admin/auth/mfa/enroll`, `/admin/auth/mfa/confirm`, and
  `/admin/auth/mfa/disable`.
- `docs/ADMIN.md` updated.

Tests added:

- `packages/tests/e2e/admin-mfa.e2e.test.ts` (1 end-to-end flow).

Validation:

- `npm run build`: passed.
- Targeted customer-support/admin/MFA/TOTP/migration tests passed: 33 tests
  across 5 suites.
- `npm test`: 395 tests across 60 suites passed.
- `npm audit --audit-level=high`: 0 vulnerabilities.

## T4 - Retention / cleanup jobs

Status: done.

Implemented:

- `packages/shared/src/retention.ts`: `runRetention(opts?)` with five cleanup
  passes: inline body purge, offloaded body purge (content-addressed safe),
  events purge, audit log purge, and review queue purge.
- All windows configurable via env vars (`RETENTION_BODY_DAYS`, etc.) and
  per-call overrides (useful for admin-triggered manual runs and E2E tests).
- Daily `daily_retention` job wired into `packages/worker/src/scheduler.ts`
  (24 h, distributed-lock guarded).
- Admin endpoint `POST /admin/retention/run` (`operator` role), with optional
  per-window override body and audit event.
- Test helpers `seedOldMessage`, `seedOldEvent`, `seedOldAuditEntry`,
  `countAuditEntries` added to `testkit.ts`.

Tests added:

- `packages/tests/e2e/retention.e2e.test.ts` (9 tests across 4 suites).

Validation:

- `npm run build`: passed.
- Targeted retention E2E: 9 tests passed.
- `npm test`: 404 tests across 61 suites passed.
- `npm audit --audit-level=high`: 0 vulnerabilities.

## T5 - Readiness checks + graceful worker drain

Status: done.

Implemented:

- `/live` liveness probe in `packages/worker/src/index.ts` — returns `200`
  immediately, no dependency checks.
- `/health` and `/ready` probes perform real checks on Postgres, Redis, and
  the BullMQ send queue; return `503` with a per-dependency `checks` map when
  degraded.
- Graceful drain: `SIGTERM`/`SIGINT` handlers race all BullMQ worker `.close()`
  calls against a `WORKER_DRAIN_TIMEOUT_MS` (default 30 s) force-exit timer via
  `Promise.race`. In-flight jobs are allowed to complete; the process never
  blocks indefinitely.
- Test harness (`packages/tests/e2e/harness.ts`) updated: `/health`, `/ready`,
  and `/metrics` registered in `buildTestApp()` with real dependency checks so
  E2E tests can exercise them without hitting the production server.

Tests added:

- `packages/tests/e2e/healthcheck.e2e.test.ts` (5 tests): liveness, health
  check with dependency map, readiness status, structured check shape, Prometheus
  metrics format.

Validation:

- `npm run build`: passed.
- Targeted healthcheck E2E: 5 tests passed.
- `npm test`: 419 tests across 63 suites passed.
- `npm audit --audit-level=high`: 0 vulnerabilities.

## T6 - Backup / restore drill

Status: done.

Implemented:

- `scripts/backup-restore-drill.sh`: idempotent Bash script that:
  - Runs `pg_dump` inside the Postgres Docker container.
  - Creates a scratch database and restores the dump into it.
  - Verifies `schema_migrations`, `customers`, `messages` row counts.
  - Cleans up the scratch database on exit via a `trap`.
- Root `package.json` script `"backup-drill": "bash scripts/backup-restore-drill.sh"`.

Validation:

- Script reviewed for correctness; operational test requires a running Docker
  Compose stack (`docker compose up -d`) and `npm run backup-drill`.

## T7 - Billing reconciliation alerting job

Status: done.

Implemented:

- `metering_reconcile` scheduler job (`packages/worker/src/scheduler.ts`) now:
  - Writes `billing:reconciliation_drift` to `audit_log` when drift is detected.
  - Fires optional external webhook `POST` to `BILLING_ALERT_WEBHOOK_URL` with
    the full drift payload; delivery failures are caught and logged.
- Admin endpoint `POST /admin/billing/reconcile` (`operator` role) in
  `packages/api/src/routes/admin.ts`: runs `reconcileMetering()` on demand,
  records an audit event, returns `{ ok, total_drift, by_customer, alert }`.

Tests added:

- 3 tests in `packages/tests/e2e/billing-reconcile-webhook-rotation.e2e.test.ts`:
  drift report shape, call consistency (deterministic result), RBAC enforcement.

Validation:

- `npm run build`: passed.
- Targeted E2E: 7 tests passed (T7 + T8 file).
- `npm test`: 419 tests across 63 suites passed.
- `npm audit --audit-level=high`: 0 vulnerabilities.

## T8 - Customer webhook secret rotation

Status: done.

Implemented:

- `rotateWebhookSecret(customerId, webhookId)` in `packages/shared/src/webhooks.ts`:
  generates a new `whsec_`-prefixed secret, updates `customer_webhooks`, and
  returns the row; returns `null` if the webhook doesn't exist or belongs to a
  different customer.
- API endpoint `POST /v1/webhooks/:id/rotate-secret` (`webhooks` scope) in
  `packages/api/src/routes/webhooks.ts`:
  - Returns `201` with the updated webhook row plus a `note` reminder.
  - Returns `404` for cross-org access.
  - Returns `403` for missing scope.

Tests added:

- 4 tests in `packages/tests/e2e/billing-reconcile-webhook-rotation.e2e.test.ts`:
  rotate returns new secret, two rotations produce different secrets, cross-org
  404, webhooks scope enforcement.

Validation:

- `npm run build`: passed.
- Targeted E2E: 7 tests passed (T7 + T8 file).
- `npm test`: 419 tests across 63 suites passed.
- `npm audit --audit-level=high`: 0 vulnerabilities.
