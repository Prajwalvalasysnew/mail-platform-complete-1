# Production Checklist (post Phase 2-4)

This file tracks the 14-section roadmap. Items marked ✅ are implemented in
this repo; ⚠ are wired but need provider credentials/config to be live; ◻
are deliberately out of scope (covered by external services or future work).

## 1. Public API surface ✅
- ✅ Tiered rate limits (global per key + per-endpoint on `/v1/send`) with `Retry-After` headers
- ✅ CORS allowlist via `CORS_ALLOWED_ORIGINS` (defaults to off)
- ✅ Backpressure: 503 + `Retry-After` when send queue depth > `SEND_QUEUE_BACKPRESSURE`
- ✅ `GET /openapi.json` (OpenAPI 3.1)
- ✅ Sunset / Deprecation headers via `V1_SUNSET_DATE`
- ✅ Idempotency keys on `/v1/send` (`Idempotency-Key` header)
- ✅ Standard error envelope (`error`, `message`, `request_id`)

## 2. Authentication & authorization ✅
- ✅ Fast HMAC-SHA256 keyed API-key verification (replaces bcrypt on hot path)
- ✅ `mp_test_` / `mp_pub_` / `mp_live_` key types
- ✅ Test-mode key routes to sandbox transport (no real delivery)
- ✅ Scope enforcement on every authenticated route
- ✅ Admin authz plane: separate sessions, OIDC subject mapping, role hierarchy, all actions audit-logged
- ✅ Production admin password login disable switch (`ADMIN_PASSWORD_LOGIN_DISABLED=true`) so deployments can enforce SSO-only admin access
- ✅ Audited key rotation with 48h overlap window
- ✅ Email verification for API-first customers (`POST /v1/verify-email`; blocks live-key sends until verified)
- ✅ Resend verification endpoint (`POST /v1/resend-verification`)
- ⚠ OIDC verification — wire `OIDC_ISSUER_URL` + `OIDC_CLIENT_ID` to your identity provider; required by the production compose contract

## 3. Data model & scale ✅
- ✅ Migration runner with checksum drift detection (`schema_migrations`)
- ✅ Atomic daily + monthly quota counters in Redis, durable-seeded from `usage_daily`
- ✅ Message-body offload abstraction (`BODY_STORAGE=inline|s3`)
- ✅ ClickHouse event firehose (dual-write, best-effort)
- ⚠ S3 wire-up — `BODY_STORAGE=s3` raises a clear "configure me" error at the integration site
- ⚠ Postgres PITR — operate via managed Postgres; documented in runbooks

## 5. DKIM ✅
- ✅ Selector rotation lifecycle (`pending` → `active` → `retiring` → `retired`)
- ✅ Private keys encrypted via KMS-pluggable encryption
- ✅ Scheduler retires old selectors after `DKIM_RETIRE_DAYS`
- ◻ ARC signing — Haraka `mailauth` plugin supports it; enable via config

## 6. Deliverability ✅
- ✅ Per-pool reputation guard (auto-pause / throttle based on 24h bounce + complaint rate)
- ✅ DNSBL monitoring (Spamhaus, SpamCop, Barracuda, SORBS) on a 6h schedule
- ✅ Per-IP warmup ramp (advanced only on real usage)
- ✅ Google Postmaster Tools + Microsoft SNDS polling (`ingestPostmaster()`, daily `postmaster_ingest` scheduler job + k8s CronJob)
- ⚠ Google Postmaster + SNDS credentials — set `GOOGLE_POSTMASTER_SA_KEY_JSON` and `SNDS_API_KEY` in secrets
- ✅ IP warmup operational runbook at `docs/runbooks/IP_WARMUP.md`

## 7. Abuse & compliance ✅
- ✅ Regex pre-filter + Bayesian classifier + URL reputation blended into a single 0-100 score
- ✅ Spam-trap and disposable-domain detection at send time
- ✅ List-quality scoring on bulk suppression import
- ✅ Durable volume baselines (Redis-flush-resistant)
- ✅ KYC tiers gating new-account daily caps
- ✅ GDPR / CCPA recipient deletion endpoint with auditable log (`POST /v1/privacy/delete-recipient`)
- ✅ GDPR Article 15 right-to-access export (`GET /v1/privacy/export-recipient?email=...`)
- ✅ Held-for-review queue with admin approve/reject + customer webhook notification on decision
- ✅ CAN-SPAM §5(a)(5): physical postal address stored per-customer (`PATCH /v1/profile`), appended to every outgoing message footer, and **enforced at send time** — live sends with no address set are rejected with a permanent error (`physical_address_required`)
- ✅ Stale `sending` recovery: scheduler job resets messages stranded in `sending` state for >10 minutes back to `queued` (worker crash safety)
- ✅ Bayesian classifier training corpus expanded to 30 spam + 30 ham examples covering 10+ distinct spam categories (lottery, pharma, phishing, crypto, advance-fee, adult, debt, weight-loss, tech-support-scam, MLM, counterfeit) and diversified ham (transactional, auth, billing, onboarding, shipping, support, notifications)
- ⚠ **Action required before launch**: update `TIER_BY_PRICE` in `packages/shared/src/billing.ts` with your real Stripe price IDs (`price_free`, `price_starter`, `price_pro`, `price_enterprise` are placeholders)
- ⚠ **Action required before launch**: set `physical_address` for every customer via `PATCH /v1/profile` or the admin panel — live sends will be permanently rejected until set. Use `SKIP_PHYSICAL_ADDRESS_CHECK=true` only during a phased rollout.

## 8. Bounce + complaint handling ✅
- ✅ DSN parser handles structured `Status:`, `Action:`, and SMTP-code fallbacks (tested against Gmail/Yahoo/Outlook formats)
- ✅ ARF complaint parser with VERP body Message-ID forgery detection (attacker-controlled header never used alone)
- ✅ Soft-bounce escalation to suppression after N bounces in M days
- ✅ Clear-on-delivery resets the soft-bounce counter
- ✅ VERP envelope-from HMAC-signed with timing-safe comparison
- ✅ `haraka-inbound` bounce_parser uses `QUEUE_PREFIX` env var (consistent with all other queue clients)

## 9. Security ✅
- ✅ KMS-pluggable master key — production-supported providers:
  - `env`: `ENCRYPTION_KEY` (dev / single-host)
  - `aws`: `DecryptCommand` on `AWS_KMS_ENCRYPTED_KEY` (pre-wrapped via `aws kms encrypt`); stable key, not GenerateDataKey
  - `vault`: Vault Transit `decrypt` HTTP call on `VAULT_ENCRYPTED_KEY` (no external SDK, uses native fetch)
  - All providers share a 5-min in-process cache (`KMS_CACHE_TTL_MS`)
  - API and worker fail startup if the selected remote key cannot be preloaded;
    `env` is refused in production unless `KMS_ALLOW_ENV_IN_PRODUCTION=true`
  - GCP KMS is not currently selectable because its client dependency tree did
    not pass the production vulnerability gate
- ✅ Constant-time API-key comparison
- ✅ CSRF token on browser unsubscribe POST
- ✅ RFC 8058 one-click POST accepted from mail clients
- ✅ Stripe webhook signature verified with timestamp tolerance
- ✅ CI: `npm audit` gate + CycloneDX SBOM artifact
- ✅ SSRF guard on all outbound URLs (`assertPublicHttpUrl` / `resolveAndAssertPublicUrl`) including billing alert webhooks
- ✅ Rate-limiter Redis failover (`skipOnError: true` — fails open, never hard-blocks on Redis outage)
- ✅ mTLS manifests at `infra/k8s/istio-mtls.yaml` (apply after Istio sidecar injection)
- ✅ TLS cert automation manifests at `infra/k8s/cert-manager.yaml` (ClusterIssuer + Certificate CRs)

## 10. Observability ✅
- ✅ Per-pool bounce_rate / complaint_rate / paused gauges
- ✅ DSN parse outcome metrics, backpressure rejections, dead-letter counts, metering drift
- ✅ API-key verify latency histogram
- ✅ Prometheus alerts for every operational hazard
- ✅ Grafana dashboard JSON
- ✅ OpenTelemetry tracing shim (set `OTEL_EXPORTER_OTLP_ENDPOINT` to enable)

## 11. Reliability ✅
- ✅ K8s manifests: HPA, PDB, rolling updates with `maxUnavailable=0`
- ✅ Graceful shutdown across API, workers, and tracker
- ✅ Dead-letter queue + DLQ metrics
- ✅ Backpressure shed at the edge
- ✅ CronJob alternatives to the in-process scheduler
- ✅ Stale `sending` state recovery (10-minute timeout, reset to `queued`, events queue notification)
- ✅ Kubernetes NetworkPolicy: default-deny + per-service allow rules (requires Calico/Cilium/Weave)

## 12. Testing & CI ✅
- ✅ 54 unit tests across 10 suites
- ✅ GitHub Actions: build → migrate → test → audit → SBOM
- ✅ k6 load test with SLO thresholds (p99 < 500ms, accept rate > 99%)
- ✅ Migration ordering check in CI

## 13. Billing ✅
- ✅ Idempotent webhook event log (`billing_events`; replay-safe)
- ✅ Subscription state machine maps to `customers.tier` / quotas
- ✅ Metering reconciliation: `usage_daily.sent` ↔ `invoices.billed_quantity`, drift as a metric
- ✅ Quota-threshold notifications at 80% / 100% (once per period)
- ⚠ Stripe SDK calls (invoice creation, usage reporting) — webhook reception ships; outbound lives in your billing flow

## 14. Docs & DevEx ✅
- ✅ `GET /openapi.json` — usable with openapi-generator for typed SDKs
- ✅ Runbooks: BLOCKLIST, KEY_COMPROMISE, QUEUE_BACKPRESSURE, DKIM_FAILURE
- ✅ README "What's new" matrix maps every Phase 2-4 capability to its file
- ✅ `.env.example` documents every new env var with sensible defaults
- ✅ `infra/k8s/secrets.example.yaml` documents the secret contract
- ✅ SDK `verifyWebhookSignature()` / `verifyWebhookSignatureAsync()` — dependency-free helpers for both Node and edge runtimes

## 15. On-call & status page
- ✅ Alertmanager routing config at `infra/alertmanager/alertmanager.yml` (PagerDuty + OpsGenie + Slack)
- ✅ Status page heartbeat CronJob at `infra/k8s/statuspage-heartbeat.yaml` (set `STATUS_HEARTBEAT_URL` in secrets)
- ⚠ PagerDuty/OpsGenie — replace `REPLACE_PAGERDUTY_INTEGRATION_KEY` in alertmanager.yml
- ⚠ Slack webhook — replace `REPLACE/REPLACE/REPLACE` in alertmanager.yml
- ⚠ Status page provider — create a heartbeat monitor and set `STATUS_HEARTBEAT_URL` in k8s secrets

## 16. Data-layer HA/DR (see docs/HA_DR.md)
- ✅ CloudNativePG example manifest with sync replica + WAL archiving + nightly backups (`infra/k8s/postgres-cnpg.yaml`); prefer managed Postgres where available
- ✅ PITR drill script measuring RPO/RTO evidence (`scripts/pitr-drill.sh`)
- ✅ Read-replica seam (`DATABASE_REPLICA_URL` → `getReadDb()`)
- ✅ PgBouncer transaction-pooling compatibility (tenant RLS uses `SET LOCAL` inside explicit transactions)
- ✅ Data-layer Prometheus alerts (default-partition strays, pool saturation, legal-hold backlog)
- ⚠ **Published targets — fill in after each quarterly drill:**
  - RPO ≤ 5 min / RTO ≤ 30 min (PITR at production size); failover RTO ≤ 2 min
  - Last PITR drill: `____-__-__`, measured restore: `____s`
  - Last backup-restore drill: `____-__-__`; last Redis failover drill: `____-__-__`
- ⚠ ClickHouse replication (ReplicatedMergeTree + Keeper or ClickHouse Cloud) + nightly `clickhouse-backup`
- ⚠ Provider-side alerts: replication lag > 60s, WAL-archive failure, backup age > 24h

## Things deferred by design
- Real Stripe SDK integration (only the webhook side ships)
- Managed Postgres backup policy (handled by RDS / Cloud SQL better than cron)

## Production compose contract
- Use `docker-compose.production.yml` with a secret-managed `.env.production`
  file for production-like deployments.
- Run `npm run prod:check -- .env.production` before deployment; CI validates
  the template contract with `npm run prod:check`.
- `docker-compose.yml` remains the local development default and intentionally
  contains development placeholders.
- See `docs/ENTERPRISE_DEPLOYMENT.md` for the required secrets, rotation notes,
  and Braze/HubSpot-class maturity gaps.
