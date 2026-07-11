# Ultra Deep Module Gap Analysis

Date: 2026-06-25  
Repo: `mail-platform-COMPLETE (1)`  
Goal: identify exactly where the platform is lacking at package, module, submodule, and sub-submodule level, with score out of 10 and concrete steps to reach 10.

## How To Read This Report

Each line is scored as:

- 10: production proven, secure by default, operationally validated.
- 8-9: strong implementation, remaining gaps are bounded.
- 6-7: implemented but incomplete for SaaS/enterprise scale.
- 4-5: partial or mostly scaffolding.
- 0-3: missing or unsafe.

Important distinction:

- "Implemented" means code exists.
- "Production grade" means code exists, tests pass, configuration is fail-closed, deployed topology is safe, and real-world operations have been proven.
- This repo has many implemented controls, but several are not fully operationally proven.

## Verification Snapshot

Commands and observations used:

| Check | Result | Meaning |
|---|---:|---|
| `npm run build` | Pass | TypeScript build is clean. |
| `npm run prod:check` | Pass in template mode | Production contract exists, but this does not validate real secrets. |
| `npm audit --omit=dev --audit-level=moderate --json` | 27 moderate, 0 high, 0 critical | Supply chain is not clean enough for strict enterprise 10/10. |
| Full test suite after applying 33 migrations | 510 pass, 3 skip, 1 cleanup failure | Product code is broadly tested; local test harness has defects. |
| Isolated RLS test after cleanup | 3 pass | RLS policies work when tenant context is set. |
| `rg "withTenant(" packages` | No production usage found | RLS mechanism is not integrated into API route execution. |
| Running local API `/live` | 200 | API container is alive. |
| Running local API `/health` | 200 | API sees Postgres, Redis, queue locally. |
| Running tracker `/health` | 200 | Tracker is alive. |
| API/tracker `/metrics` unauthenticated | 401 | Metrics token protection is active locally. |
| Docker inspect api/worker/tracker | user=node, no restart policy, no Docker healthcheck | Non-root is good; compose-level production resilience is incomplete. |

## Top 20 Deepest Gaps To Resolve First

| Rank | Area | Current Score | Gap |
|---:|---|---:|---|
| 1 | Tenant isolation/RLS integration | 6.0 | RLS policies exist but API routes do not use `withTenant()` transactions. |
| 2 | Test harness reliability | 6.5 | `.env.test` is not auto-loaded and test DB port is inconsistent. |
| 3 | Dependency hygiene | 6.5 | 27 moderate advisories remain. |
| 4 | Real billing launch | 6.0 | Placeholder price IDs, provider sandbox/live proof missing. |
| 5 | Deliverability proof | 5.5 | Warmup/reputation code exists but real inbox placement is unproven. |
| 6 | Production migrations | 6.5 | App containers still run migrations; Helm also has migration job. |
| 7 | HA/DR proof | 5.5 | Managed Postgres/Redis HA and restore drills are documented more than proven. |
| 8 | Consent ledger | 5.5 | Suppressions exist, but consent history/preference center is incomplete. |
| 9 | Enterprise SSO/SCIM for customers | 5.0 | Admin OIDC exists; customer enterprise SSO/SCIM is not complete. |
| 10 | Immutable audit | 6.0 | Audit exists but is not tamper-evident. |
| 11 | Load proof | 6.5 | Local load findings exist; cluster-scale k6 proof is missing. |
| 12 | Object storage production proof | 7.0 | S3 implementation exists; IAM, lifecycle, replication, MinIO CI proof missing. |
| 13 | ClickHouse analytics reliability | 6.5 | Best-effort dual write can lose analytics events. |
| 14 | Provider failure taxonomy | 7.0 | SMTP/SES errors are not classified deeply enough for ISP-grade retry shaping. |
| 15 | Abuse intelligence | 6.5 | Classifier/rules exist; real threat-intel feeds and feedback loop missing. |
| 16 | Customer-facing operations UI | 6.5 | Admin APIs exist, but self-serve dashboards/replays/preferences are incomplete. |
| 17 | Runtime image hardening | 6.5 | Non-root exists; image slimming, digest pinning, read-only FS, SBOM strictness missing. |
| 18 | On-call integration proof | 6.5 | Alertmanager config has placeholders. |
| 19 | Data residency/legal hold | 5.0 | Privacy endpoints exist; residency/legal hold/backup erasure not complete. |
| 20 | Public API version lifecycle | 7.0 | Sunset header exists, but compatibility enforcement is incomplete. |

---

# 1. Repository And Runtime Topology

## 1.1 Package Hierarchy - 8.0/10

### 1.1.1 `packages/api` - 8.0/10

Role:

- Fastify REST API.
- Public signup/billing webhook routes.
- API-key routes for sending, domains, templates, messages, privacy, usage, webhooks.
- User-session routes for account/team/keys/billing/support.
- Admin routes for operators/support/superadmins.

Lacking:

- Route count is high and `admin.ts` is very large, increasing review and regression risk.
- Tenant-scoped transaction integration is missing.

To reach 10:

- Split `admin.ts` into modules: `admin-auth`, `admin-customers`, `admin-review`, `admin-support`, `admin-dlq`, `admin-deliverability`, `admin-billing`, `admin-audit`.
- Introduce route metadata for auth type, tenant scope, required capability, and audit requirement.
- Add a test that every tenant route has tenant context and scope/capability declared.

### 1.1.2 `packages/shared` - 8.0/10

Role:

- Domain logic and reusable infrastructure.
- Auth, billing, deliverability, queues, storage, metrics, migrations, schemas.

Lacking:

- Many service functions directly import global `db`, making tenant transaction/RLS integration harder.
- Cross-cutting concerns like audit and metrics are not uniformly enforced by interface.

To reach 10:

- Refactor service functions to accept `DatabaseExecutor` (`db` or `trx`).
- Add context object: `{ db, tenantId, actor, requestId }`.
- Add lint rule forbidding global `db` in tenant-scoped services.

### 1.1.3 `packages/worker` - 8.0/10

Role:

- Send worker.
- Event worker.
- Webhook worker.
- Scheduler.

Lacking:

- In-process scheduler is convenient but production scheduling should be separate.
- Worker fleet scaling and failover not proven.

To reach 10:

- Run scheduler jobs as Kubernetes CronJobs in production.
- Add queue-age autoscaling.
- Add chaos tests for worker crash, Redis failover, and SMTP outage.

### 1.1.4 `packages/tracker` - 8.0/10

Role:

- Open pixel.
- Click redirect.
- Unsubscribe UI and one-click POST.
- Metrics and health.

Lacking:

- Public-facing tracker abuse/load hardening needs proof.
- Branded tracking domains per tenant are not fully surfaced.

To reach 10:

- Add per-tenant tracking domains and verification.
- Add high-volume load tests for opens/clicks.
- Add bot/scanner feedback dashboards.

### 1.1.5 `packages/haraka-outbound` - 7.5/10

Role:

- Outbound MTA plugins.
- Customer DKIM signing.
- Header cleanup.
- Event emission.

Lacking:

- Production MTA operation is a specialized discipline: queue handling, TLS reporting, ISP throttles, PTR/rDNS, feedback loops, and deliverability are not proven by code alone.

To reach 10:

- Add outbound MTA runbook with live queue commands.
- Add TLS policy/reporting.
- Add provider-specific deferral classification and throttling.
- Validate PTR/rDNS and HELO consistency.

### 1.1.6 `packages/haraka-inbound` - 8.0/10

Role:

- Inbound DSN/FBL bounce parser.

Lacking:

- Real provider corpus and FBL enrollment proof are missing.

To reach 10:

- Build test corpus from major mailbox providers.
- Add source provider field and parsing confidence.
- Add unparsed bounce triage workflow.

### 1.1.7 `packages/sdk` - 7.5/10

Role:

- TypeScript client.
- Webhook signature helpers.

Lacking:

- Only one SDK language.
- SDK release/versioning maturity not proven.

To reach 10:

- Generate SDKs from OpenAPI for JS, Python, Go, Java.
- Add retry/idempotency helpers.
- Add semantic-versioned SDK release pipeline.

### 1.1.8 `packages/docs` and `docs` - 7.5/10

Role:

- Docusaurus docs.
- Guides, runbooks, architecture, API reference.

Lacking:

- Some docs claim production completeness while also containing action-required placeholders.

To reach 10:

- Separate "code implemented", "configured", "validated in staging", and "validated in production".
- Add evidence links per checklist item.

### 1.1.9 `infra` - 7.0/10

Role:

- Migrations.
- Helm/K8s.
- Monitoring.
- Nginx.
- Alerting.
- Load test.

Lacking:

- Infra is a starting point, not a proven reference production architecture.

To reach 10:

- Add cloud-specific production examples for AWS/GCP/Azure.
- Add ExternalSecrets/secret manager integration.
- Add HA managed DB/Redis patterns.
- Add Terraform or equivalent IaC.

### 1.1.10 Running Docker topology - 7.0/10

Observed:

- `mail-api`, `mail-worker`, `mail-tracker`, `mail-haraka-out`, `mail-haraka-in`, Postgres, Redis, Mailpit, Prometheus, Grafana are running.
- API/tracker health endpoints return 200.
- Metrics endpoints return 401 unauthenticated.
- API/worker/tracker run as `node`.

Lacking:

- Docker inspect shows no container healthcheck for API/worker/tracker.
- Restart policy is `no`.
- Compose runtime is dev-like, not enterprise HA.

To reach 10:

- Add healthchecks to Compose.
- Add restart policies for production-like compose.
- Keep Postgres/Redis private in production.
- Use managed DB/Redis for real production.

---

# 2. API Package Deep Hierarchy

## 2.1 API Server Core - 8.0/10

### 2.1.1 Boot and config guard - 8.0/10

Evidence:

- `enforceConfig()` runs at startup.
- Production guard blocks weak/default secrets.

Lacking:

- `rlsIsEnforced()` is not visibly enforced at startup.
- Production provider-specific config checks are partial.

To reach 10:

- Fail production startup if DB role is superuser/BYPASSRLS.
- Fail startup if selected billing/storage/transport provider is not fully configured.
- Fail startup if `BODY_STORAGE=s3` lacks bucket/credentials/region or IAM role.

### 2.1.2 Request identity and logging - 7.5/10

Evidence:

- `genReqId` honors `x-request-id` and generates UUID.
- Pino/Fastify logging exists.

Lacking:

- Central log schema and PII redaction are not enforced.

To reach 10:

- Add structured log contract.
- Redact auth headers, tokens, email body, recipient PII by default.
- Add tests that sensitive fields never appear in logs.

### 2.1.3 CORS - 8.0/10

Evidence:

- CORS defaults off unless origins configured.

Lacking:

- Customer dashboard origin management not visible.

To reach 10:

- Add deployment checklist for dashboard origins.
- Add route-level CORS tests for disallowed origins.

### 2.1.4 Security headers - 8.0/10

Evidence:

- CSP, HSTS in production, nosniff, frame deny, permissions policy, cache-control.

Lacking:

- CSP is API-oriented; docs/dashboard might need separate policy.

To reach 10:

- Add security header tests for every public service and docs site.
- Add TLS/HSTS smoke test in deployment pipeline.

### 2.1.5 Health and readiness - 8.0/10

Evidence:

- `/live`, `/health`, `/ready`.
- Health checks Postgres, Redis, queue.

Lacking:

- Worker readiness and tracker readiness are simpler.
- Health endpoint does not prove downstream transport readiness.

To reach 10:

- Add transport health check.
- Add object storage and ClickHouse health where enabled.
- Add Kubernetes startup probes.

### 2.1.6 Metrics endpoint - 8.5/10

Evidence:

- `/metrics` requires token if configured and fails closed in production.
- Local unauthenticated request returns 401.

Lacking:

- No mTLS/private-network proof for metrics.

To reach 10:

- Put `/metrics` behind internal ingress only.
- Require Prometheus bearer token and network policy.

## 2.2 API Plugins

### 2.2.1 API-key auth plugin - 8.0/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Bearer parsing | 8.5 | No structured auth telemetry by failure reason. | Add auth failure metrics and alerting. |
| Key type detection | 8.5 | Publishable key policy needs more browser threat modeling. | Restrict publishable scopes to non-secret read/create flows only. |
| Prefix lookup | 8.5 | Prefix length is practical but collision handling is not exposed. | Add collision metric and admin search tooling. |
| HMAC verification | 9.0 | Pepper rotation is manual. | Add dual-pepper rotation. |
| Account status gate | 8.5 | Suspended/banned semantics need product workflows. | Add suspension reasons, appeals, automated abuse state transitions. |
| Expiry/revocation | 8.5 | Customer alerting for expiring keys missing. | Add key expiry notifications. |
| Last-used tracking | 8.0 | Redis gate can lose update on Redis outage. | Add async batch updater and metric for skipped updates. |
| Tenant context | 5.5 | Does not start `withTenant()` transaction. | Inject tenant executor/context into downstream handlers. |

### 2.2.2 Session auth plugin - 8.0/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Session resolution | 8.0 | No risk/device signal. | Add device fingerprints and session risk metadata. |
| MFA enforcement | 8.0 | Tenant policy enforcement limited. | Add per-tenant MFA required flags. |
| Capability checks | 8.0 | Capabilities are static. | Add policy engine and audit for denied access. |
| Active org handling | 7.5 | RLS context not applied. | Scope DB executor to current org. |

### 2.2.3 Scope plugin - 8.0/10

Lacking:

- API key scopes are practical but coarse.

To reach 10:

- Add fine-grained scopes: `messages:send`, `messages:read`, `suppressions:write`, `domains:verify`, `webhooks:replay`.
- Add route-scope matrix test.

### 2.2.4 Error envelope - 7.5/10

Lacking:

- Error code registry is not fully formal.

To reach 10:

- Publish stable error codes.
- Add error compatibility tests.

## 2.3 Public API Routes

### 2.3.1 Signup and email verification (`customers.ts`) - 7.5/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Public signup | 7.5 | Abuse protection for mass signup is basic. | Add CAPTCHA/risk scoring/email reputation/payment gating. |
| API-first customer creation | 8.0 | Needs launch policy for free-tier abuse. | Add KYC state machine and fraud checks. |
| Email verification | 8.0 | Delivery of verification mail depends on configured platform mail. | Add bounce handling for verification emails. |
| Resend verification | 7.5 | Rate limiting and abuse telemetry should be explicit. | Add per-email resend limit and metrics. |
| Legacy admin API key route | 5.5 | `/admin/api-keys` under customer routes is risky/confusing. | Remove or move behind admin plane only. |

### 2.3.2 Billing webhooks (`billing.ts`) - 7.0/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Stripe webhook | 7.5 | Needs real sandbox/live proof. | Add Stripe CLI/sandbox integration tests. |
| PayPal webhook support | 6.5 | Provider semantics are partial. | Add PayPal webhook verification and state mapping tests. |
| Cashfree webhook support | 6.5 | Plan mapping and webhook proof missing. | Add Cashfree sandbox tests. |
| Missing secret behavior | 8.0 | Fail-closed in production, but config paths can be confusing. | Make selected provider fail closed everywhere except explicit dev. |
| Idempotency | 8.0 | Event retention/replay tooling limited. | Add billing event replay admin tool. |

### 2.3.3 Human account auth (`account.ts`) - 8.0/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Register org with owner | 8.0 | Fraud/KYC checks limited. | Add risk scoring and domain/payment verification gates. |
| Login | 8.0 | Device/risk-based auth missing. | Add login alerts and impossible-travel/risk engine. |
| MFA challenge | 8.0 | Tenant-required MFA missing. | Enforce per-org MFA policy. |
| Logout | 8.0 | Good basic behavior. | Add session event audit visibility. |
| Sessions list/revoke | 8.0 | Device metadata limited. | Add device, IP, UA, geo, last activity. |
| Switch org | 7.5 | No tenant DB context. | Set tenant context after active org switch. |
| Password forgot/reset | 7.5 | Abuse/rate telemetry not fully visible. | Add per-email/IP throttles and alerts. |
| Email verification | 8.0 | Good base. | Add enterprise custom verification domains. |

## 2.4 User Account Management Routes

### 2.4.1 Team and invites (`team.ts`) - 7.5/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Member list | 8.0 | Needs audit export and filters. | Add pagination, role filters, audit correlation. |
| Invite creation | 8.0 | Invite risk controls limited. | Add domain allowlist and expiry policies. |
| Invite acceptance | 8.0 | Good single-use token model. | Add SSO-bound invite acceptance. |
| Role update | 7.5 | Static role model. | Add custom roles/policies for enterprise. |
| Member removal | 8.0 | Last-owner guard exists in shared logic. | Add transfer ownership workflow. |

### 2.4.2 Account API keys (`keys.ts`) - 8.0/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| List keys | 8.0 | No anomaly status. | Add last used IP/UA, risk flags. |
| Create key | 8.0 | Scope model coarse. | Add fine-grained scopes and expiry defaults. |
| Rotate key | 8.5 | 48h overlap exists. | Add customer notifications and forced rotation campaigns. |
| Revoke key | 8.5 | Good base. | Add bulk revoke by leaked prefix/risk. |

### 2.4.3 Account domains (`account-domains.ts`) - 8.0/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| List/get domains | 8.0 | Need DNS health summary. | Add latest DNS check and DMARC policy display. |
| Add domain | 8.0 | Domain ownership abuse checks limited. | Add disposable/free-domain restrictions and brand validation. |
| Verify domain | 8.0 | No periodic re-verification. | Add scheduled DNS rechecks and alerts. |
| Delete domain | 7.5 | Needs send impact warnings. | Prevent deletion if active scheduled sends exist. |

### 2.4.4 Account webhooks (`account-webhooks.ts`) - 8.0/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| List/create/update | 8.0 | Endpoint challenge missing. | Add verification challenge. |
| Rotate secret | 8.0 | Overlap window not clear. | Add dual-secret transition. |
| Delete | 8.0 | Basic good. | Add event delivery pause/resume. |

### 2.4.5 Account billing (`account-billing.ts`) - 6.5/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Billing overview | 7.0 | Plan mapping placeholder. | Replace price IDs and expose real plan data. |
| Checkout | 6.5 | Provider sandbox proof missing. | Add Stripe/PayPal/Cashfree sandbox tests. |
| Portal | 6.5 | PayPal/Cashfree portal is generic. | Add provider-specific customer portal flows. |

## 2.5 API-Key Customer Routes

### 2.5.1 Send single (`send.ts` `/send`) - 8.5/10

Deep submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Request schema | 8.5 | Message categories and attachments absent. | Add category/policy schema, attachment policy if needed. |
| Body limits | 8.5 | Render complexity limit absent. | Add template render timeout/complexity budget. |
| Idempotency pre-handler | 8.5 | Needs metrics by idempotency outcome. | Add counters and dashboard. |
| Global queue backpressure | 8.5 | Needs queue age not just depth. | Reject based on queue age/SLO. |
| Template resolution | 8.0 | Template versioning absent. | Add immutable versions and draft/publish. |
| Domain verification | 8.0 | No periodic DNS drift enforcement. | Add send-time recent DNS status threshold. |
| Email verification gate | 8.0 | Good base. | Add domain-based enterprise verification alternatives. |
| Billing gate | 7.0 | Billing lifecycle incomplete. | Add dunning/grace policies. |
| KYC/new account cap | 7.5 | KYC model basic. | Add payment/business verification workflow. |
| Per-customer queue depth | 8.0 | Counter approximate. | Add reconciliation from BullMQ and queue age. |
| Quota reserve | 8.5 | Redis HA proof missing. | Run failover tests. |
| Abuse scan | 7.0 | Threat intel and feedback loop missing. | Add external URL/domain intel and reviewer labels. |
| Pool action | 7.5 | Pool routing logic basic. | Add per-ISP throttling and pool assignment policy. |
| Suppression batch | 8.0 | Consent/preference state missing. | Add consent ledger and preference center. |
| Body offload | 8.0 | S3 production proof missing. | Add MinIO CI and IAM docs. |
| Outbox insert | 8.5 | Good pattern. | Add outbox lag metrics. |
| Response recording | 8.0 | Idempotent error replay policy needs docs. | Document replay semantics for failures. |

### 2.5.2 Send batch (`send.ts` batch route) - 8.0/10

Deep submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Batch validation | 8.0 | Per-message policy controls limited. | Add per-message category and template version policy. |
| Bulk body offload | 8.0 | Fixed regression exists, but object storage proof missing. | Add S3 integration test. |
| Batch suppression/refunds | 8.0 | Partial success semantics need public docs. | Document accepted/suppressed/reviewed/blocked result contract. |
| Batch review queue | 7.5 | Admin review UX/evidence limited. | Add review evidence payload. |
| Batch performance | 7.5 | Only local load proof. | Run 1000-recipient staging load tests. |

### 2.5.3 Domains API (`domains.ts`) - 8.0/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| List | 8.0 | No health summary. | Add DNS health snapshots. |
| Add | 8.0 | Domain abuse checks limited. | Add sender/domain reputation checks. |
| Verify | 8.0 | DNS resolver edge cases need live proof. | Add resolver integration and periodic checks. |
| Delete | 7.5 | Deletion impact controls missing. | Add dependency checks before delete. |

### 2.5.4 Templates API (`templates.ts`) - 7.5/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| List/get | 8.0 | No folder/tags/version lifecycle. | Add template organization and versions. |
| Create/update | 7.5 | Missing required variables render empty. | Add variable schema and preview validation. |
| Validation | 7.0 | No render complexity/time budget. | Add complexity guard. |
| Delete | 7.5 | Send dependency checks missing. | Prevent delete of templates used by scheduled sends. |

### 2.5.5 Suppressions and unsubscribe groups (`suppressions.ts`) - 8.0/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Suppression list | 8.0 | Need reason history. | Add append-only suppression events. |
| Add/delete suppression | 8.0 | Manual action audit could be stronger. | Audit every manual mutation. |
| Bulk import | 7.5 | Consent/list quality gates limited. | Add import quarantine and validation report. |
| Export | 8.0 | Good base. | Add signed export job for large lists. |
| Groups CRUD | 8.0 | Preference center missing. | Connect to hosted preferences. |
| Group members | 8.0 | Good base. | Add import/export and audit history. |

### 2.5.6 Messages API (`messages.ts`) - 7.5/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| List messages | 7.5 | Large-scale pagination/performance proof missing. | Add cursor-only pagination and index tests. |
| Message detail | 8.0 | Good base. | Add customer-facing diagnostic explanations. |
| Activity list | 8.0 | Good filters. | Add export jobs for high volume. |
| Scheduled messages | 7.5 | Recurrence/campaign features missing. | Add scheduled send management controls. |
| Cancel scheduled | 8.0 | Good base. | Add cancellation audit and event. |

### 2.5.7 Analytics API (`analytics.ts`) - 7.0/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Time-series stats | 7.5 | Postgres analytics may not scale. | Shift heavy analytics to ClickHouse with reliable pipeline. |
| Top recipients/domains | 7.0 | Privacy and cardinality controls needed. | Add aggregation thresholds and privacy rules. |
| Event analytics | 7.0 | Bot/human split needs product UX. | Expose bot-filtered analytics and confidence. |

### 2.5.8 Usage API (`usage.ts`) - 7.5/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Quota snapshot | 8.0 | Redis snapshot can be stale/incomplete. | Reconcile with durable ledger. |
| Usage history | 7.5 | Revenue-grade ledger missing. | Add append-only usage events. |
| Stats | 7.5 | Needs SLO/latency and deliverability metrics. | Add customer-facing health and reputation summary. |

### 2.5.9 Privacy API (`privacy.ts`) - 7.5/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Delete recipient | 8.0 | Backup/ClickHouse/legal hold treatment incomplete. | Add data inventory and erasure propagation. |
| Deletion log | 8.0 | Audit immutability missing. | Add tamper-evident retention. |
| Export recipient | 8.0 | Completeness must track future tables. | Add PII table registry tests. |
| Body object erasure | 8.0 | S3 lifecycle proof missing. | Add object-store integration tests. |

### 2.5.10 Profile API (`profile.ts`) - 8.0/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Get profile | 8.0 | Basic. | Add compliance readiness status. |
| Update physical address | 8.0 | Address validation missing. | Add postal address validation and audit. |

### 2.5.11 Customer webhooks API (`webhooks.ts`) - 8.0/10

Submodules:

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Create/list/delete | 8.0 | Endpoint verification missing. | Add challenge-response verify. |
| Rotate secret | 8.0 | No dual-secret overlap. | Add previous/current secret acceptance window. |
| Deliveries list | 8.0 | Good base. | Add customer replay and payload redaction controls. |
| Replay delivery | 7.5 | Needs rate and idempotency controls. | Add replay audit and dry-run. |

## 2.6 Admin API Routes (`admin.ts`) - 7.5/10

### 2.6.1 Admin auth - 8.0/10

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| OIDC login | 7.5 | Needs real IdP validation and JWKS caching review. | Add integration tests with OIDC test provider. |
| Password login | 7.5 | Disabled in prod, still exists for bootstrap. | Add break-glass process and expiry. |
| MFA enroll/confirm/disable | 8.5 | Good TOTP replay protections. | Add admin-enforced MFA policy and recovery workflow. |
| Admin sessions | 8.0 | Device/risk metadata limited. | Add session inventory and revoke-all on role change. |

### 2.6.2 Customer operations - 7.5/10

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| List/get customer | 7.5 | Search/scaling/privacy controls limited. | Add paginated filtered search with PII masking by role. |
| Patch customer | 7.5 | High-risk changes need approvals. | Add two-person approval for quota/status/billing overrides. |
| Suspend/reinstate | 8.0 | Good base. | Add reason taxonomy, appeal state, automatic triggers. |
| Support notes | 7.5 | Not immutable. | Add audit/tamper-evident notes. |

### 2.6.3 Review queue - 7.5/10

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| List/stats | 7.5 | Needs reviewer workload tools. | Add SLA, assignment, priority queues. |
| Approve/reject | 8.0 | Good base. | Feed decisions back to classifier. |
| Bulk review | 7.0 | High-risk bulk actions need safeguards. | Add sampled confirmation and approval for bulk. |

### 2.6.4 DLQ operations - 8.0/10

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| List/get DLQ | 8.0 | Good base. | Add root-cause grouping. |
| Replay | 8.0 | Needs dry-run and safety filters. | Add replay preview and batch replay controls. |
| Purge | 7.5 | Destructive operation needs approval. | Add two-person approval and retention policy. |

### 2.6.5 Deliverability admin - 7.0/10

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Pool health | 7.5 | Real ISP health limited. | Add per-ISP/domain metrics. |
| Reputation pools | 7.0 | Operational workflow immature. | Add pool pause/resume and incident tracking. |
| Blocklist scan | 7.5 | Manual scan exists. | Add scheduled incident creation and delisting status. |

### 2.6.6 Billing admin - 6.5/10

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Reconcile | 7.0 | Drift is detected, not fully resolved. | Add invoice correction workflow. |
| Subscription overrides | 6.5 | Enterprise approval/audit needed. | Add approval and customer notification. |

### 2.6.7 Retention/admin audit - 7.0/10

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Retention run | 7.5 | Manual trigger exists. | Add dry-run and change summary. |
| Audit list | 7.0 | Not immutable/tamper-evident. | Add WORM/external audit sink. |

### 2.6.8 Support desk admin - 7.5/10

| Sub-submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Ticket CRUD | 8.0 | Good base. | Add assignments, macros, customer timeline. |
| SLA breaches | 7.5 | Good base. | Add plan-specific SLA policies. |
| Suggested reply | 6.5 | Local heuristic AI by default. | Add governed AI provider, redaction, and approval. |
| Canned responses | 8.0 | Good base. | Add versioning and usage analytics. |

---

# 3. Shared Package Deep Hierarchy

## 3.1 Database, Schema, And Migrations - 7.5/10

### 3.1.1 `db.ts` connection - 7.5/10

Lacking:

- Global singleton is simple but complicates tenant transaction/RLS.
- Pool sizing is static.

To reach 10:

- Add request context executor.
- Add pool metrics.
- Tune pool per service and deployment size.

### 3.1.2 `schema.ts` type coverage - 8.0/10

Lacking:

- Schema types must stay aligned with migrations manually.

To reach 10:

- Generate schema types from DB or add drift tests.

### 3.1.3 `migrate.ts` runner - 7.5/10

Lacking:

- Forward-only only.
- No expand/contract enforcement.
- Production app images also run migrations.

To reach 10:

- Use dedicated migration job only.
- Add destructive migration detector.
- Add migration safety checklist.

### 3.1.4 `tenant-context.ts` RLS - 6.0/10

Lacking:

- Mechanism exists but not used in production routes.

To reach 10:

- Make tenant context mandatory for all tenant routes and services.
- Enforce non-BYPASSRLS DB role.

## 3.2 Identity And Auth Shared Services - 8.0/10

### 3.2.1 `apikeys.ts` - 8.5/10

Strong:

- HMAC keyed hash.
- Constant-time compare.
- Typed key prefixes.

Lacking:

- Pepper rotation.

To reach 10:

- Dual-pepper support and rehash on use.

### 3.2.2 `apikey-management.ts` - 8.0/10

Lacking:

- Scope granularity and policy constraints.

To reach 10:

- Fine-grained scopes and default expiry.

### 3.2.3 `passwords.ts` - 8.5/10

Strong:

- scrypt, NFKC, self-describing format.

Lacking:

- Breached password checks absent.

To reach 10:

- Add HaveIBeenPwned k-anonymity check or internal denylist.

### 3.2.4 `tokens.ts` - 8.0/10

Strong:

- HMAC token storage.

Lacking:

- Pepper rotation.

To reach 10:

- Dual-token pepper rotation.

### 3.2.5 `users.ts` - 7.5/10

Lacking:

- Enterprise identity lifecycle incomplete.

To reach 10:

- Add SCIM, SSO binding, user deprovisioning, audit.

### 3.2.6 `user-sessions.ts` - 8.0/10

Lacking:

- Device/session metadata limited.

To reach 10:

- Add device, IP, UA, geo, risk, revoke reason.

### 3.2.7 `mfa.ts` and `totp.ts` - 8.5/10

Strong:

- TOTP enrollment.
- Recovery codes.
- Replay prevention via last-used step.

Lacking:

- WebAuthn/FIDO2 not present.

To reach 10:

- Add passkeys/WebAuthn for enterprise users/admins.

### 3.2.8 `admin.ts` - 8.0/10

Lacking:

- JIT admin access, break-glass, immutable audit not complete.

To reach 10:

- Add time-bound elevation and approval.

### 3.2.9 `memberships.ts` and `invites.ts` - 7.5/10

Lacking:

- Static roles only.

To reach 10:

- Add custom roles and policy engine for enterprise.

## 3.3 Sending And Mail Core - 8.0/10

### 3.3.1 `quota.ts` - 8.5/10

Strong:

- Atomic Redis Lua.
- Durable seed.
- Queue-depth counters.

Lacking:

- Redis HA not proven.

To reach 10:

- Add Redis failover tests and quota reconciliation job.

### 3.3.2 `outbox.ts` - 8.5/10

Strong:

- Transactional outbox pattern.
- `FOR UPDATE SKIP LOCKED`.

Lacking:

- Operational lag metrics and manual repair not complete.

To reach 10:

- Add outbox lag/age dashboard and repair tools.

### 3.3.3 `queues.ts` - 8.0/10

Strong:

- Send/events/webhooks/DLQ queues.
- Replay/purge DLQ functions.

Lacking:

- Queue topology under Redis failover not proven.

To reach 10:

- Add failover tests and queue age autoscaling.

### 3.3.4 `transport.ts` - 7.5/10

Lacking:

- Transport abstraction exists, but provider-specific classification is shallow.

To reach 10:

- Add SMTP enhanced status code mapping.
- Add SES/API transport with structured provider errors.

### 3.3.5 `mailer.ts` - 7.5/10

Lacking:

- Platform transactional mail depends on configured transport.

To reach 10:

- Add template/versioning for platform mails and bounce handling.

### 3.3.6 `templates.ts` - 7.0/10

Lacking:

- Missing required variables render empty.
- No template versioning.

To reach 10:

- Add variable schema, preview, test render, draft/publish/versioning.

## 3.4 Domains And DKIM - 8.0/10

### 3.4.1 `domains.ts` - 8.0/10

Lacking:

- Periodic DNS drift detection and deep diagnostics.

To reach 10:

- Add DNS health scanner and customer alerts.

### 3.4.2 `dkim-rotation.ts` - 8.0/10

Lacking:

- Real KMS provider proof missing.

To reach 10:

- Add cloud KMS integration tests and key-compromise workflow.

### 3.4.3 `crypto.ts` VERP/webhook helpers - 8.0/10

Lacking:

- Secret rotation windows not complete.

To reach 10:

- Add current/previous secret verification for VERP and webhooks.

## 3.5 Abuse, Reputation, And Deliverability - 7.0/10

### 3.5.1 `abuse.ts` - 7.0/10

Lacking:

- Rules are local and limited.

To reach 10:

- Add real threat intel, customer reputation, and adaptive controls.

### 3.5.2 `classifier.ts` - 6.5/10

Lacking:

- Bayesian classifier is not production-scale abuse ML.

To reach 10:

- Add training pipeline, reviewer feedback, model evaluation, false-positive tracking.

### 3.5.3 `listquality.ts` - 7.0/10

Lacking:

- Disposable/trap intel likely static/manual.

To reach 10:

- Integrate external list quality providers and real-time trap feeds.

### 3.5.4 `reputation.ts` - 7.0/10

Lacking:

- Good scaffolding, unproven real postmaster/SNDS ops.

To reach 10:

- Add real credentialed ingestion, inbox placement, per-ISP throttling.

### 3.5.5 `warmup.ts` - 7.0/10

Lacking:

- Warmup algorithm not proven against real mailbox providers.

To reach 10:

- Execute and record real warmup evidence.

### 3.5.6 `bot-detection.ts` - 7.5/10

Lacking:

- Needs continuous tuning from live scanner data.

To reach 10:

- Add model evaluation against labeled open/click scanner corpus.

## 3.6 Suppression, Bounce, And DSN - 8.0/10

### 3.6.1 `suppression.ts` - 8.0/10

Lacking:

- No append-only suppression event ledger.

To reach 10:

- Add suppression history table.

### 3.6.2 `softbounce.ts` - 8.0/10

Lacking:

- Thresholds need ISP-specific tuning.

To reach 10:

- Add domain/provider-specific soft bounce policy.

### 3.6.3 `dsn.ts` - 8.0/10

Lacking:

- Real-world parser corpus must grow continuously.

To reach 10:

- Add production DSN corpus and unknown parser triage.

## 3.7 Storage, Privacy, Retention - 7.5/10

### 3.7.1 `storage.ts` - 7.5/10

Lacking:

- S3 production lifecycle/IAM proof missing.

To reach 10:

- Add MinIO CI integration and cloud IAM policy docs.

### 3.7.2 `retention.ts` - 7.5/10

Lacking:

- Legal hold and backup erasure policy missing.

To reach 10:

- Add legal hold and retention policy matrix.

### 3.7.3 `clickhouse.ts` - 6.5/10

Lacking:

- Best-effort write can lose analytics.

To reach 10:

- Add analytics outbox and reconciliation.

## 3.8 Billing - 6.5/10

### 3.8.1 `billing-provider.ts` - 6.5/10

Lacking:

- Mock fallback, partial PayPal/Cashfree usage semantics.

To reach 10:

- Add provider capability enforcement and sandbox integration tests.

### 3.8.2 `billing.ts` - 6.5/10

Lacking:

- Placeholder `price_*` IDs.
- No tax/dunning/refund/proration completeness.

To reach 10:

- Real price config, invoice lifecycle, dunning, tax, refund workflows.

## 3.9 Support - 7.5/10

### 3.9.1 `support.ts` ticket lifecycle - 7.5/10

Lacking:

- Live chat and helpdesk integrations absent.

To reach 10:

- Add integrations, attachments, escalation, plan-specific SLA.

### 3.9.2 AI triage/suggested reply - 6.5/10

Lacking:

- Local heuristic provider by default.
- Governance/redaction missing.

To reach 10:

- Add PII redaction, approval, provider audit, human-in-loop controls.

## 3.10 Observability And Security Utilities - 7.5/10

### 3.10.1 `metrics.ts` - 8.0/10

Lacking:

- SLOs not formalized.

To reach 10:

- Add SLO metrics and burn-rate alerts.

### 3.10.2 `tracing.ts` - 7.0/10

Lacking:

- OTel dependency advisories remain.

To reach 10:

- Upgrade OTel and deploy collector/sampling config.

### 3.10.3 `ssrf.ts` - 8.5/10

Lacking:

- Needs network-layer egress enforcement too.

To reach 10:

- Add egress proxy/allowlist and audit.

### 3.10.4 `kms.ts` and `encryption.ts` - 7.5/10

Lacking:

- Cloud/Vault providers need live integration proof.

To reach 10:

- Add real provider integration tests and key rotation playbook.

### 3.10.5 `config-guard.ts` - 8.0/10

Lacking:

- Does not enforce every provider's deep production config.

To reach 10:

- Expand guard for storage, transport, billing, OIDC, KMS, ClickHouse.

---

# 4. Worker Package Deep Hierarchy

## 4.1 Send worker (`send-worker.ts`) - 8.5/10

| Submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Job lookup/state guard | 8.5 | Race handling good, but no tenant context. | Add service-role posture docs and RLS bypass role isolation. |
| Sending state transition | 8.5 | Good `sending_at`. | Add state transition metrics. |
| Body loading | 8.0 | Object storage proof missing. | Add S3 integration and failure handling policy. |
| HTML transform | 8.0 | URL safety scanning absent. | Add optional safe-browsing checks. |
| VERP return path | 8.5 | Secret rotation missing. | Dual-secret rotation. |
| Physical address enforcement | 8.0 | Address validation absent. | Postal validation and tenant policy. |
| Transport send | 7.5 | Provider error taxonomy shallow. | Enhanced SMTP/SES classification. |
| Usage/event update | 8.0 | Event ordering good. | Add outbox for usage if needed. |
| Failure handling | 8.0 | Retry policy could be provider-aware. | Adaptive retry by SMTP status/ISP. |

## 4.2 Event worker (`event-worker.ts`) - 8.0/10

| Submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Event idempotency | 8.5 | Good event key support. | Add metrics for duplicates. |
| Status precedence | 8.5 | Prevents downgrades. | Add formal state machine diagram and tests for every edge. |
| Delivery/bounce/complaint handling | 8.0 | Provider coverage proof missing. | Add live provider corpus. |
| Suppression integration | 8.0 | Consent ledger absent. | Append-only suppression events. |
| ClickHouse firehose | 6.5 | Best effort. | Durable analytics outbox. |

## 4.3 Webhook worker (`webhook-worker.ts`) - 8.5/10

| Submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Retry classification | 8.0 | Good base. | Per-endpoint circuit breaker. |
| SSRF delivery check | 9.0 | Strong DNS pinning. | Add dispatcher pooling. |
| Signature | 8.5 | No dual-secret window. | Add previous/current secret support. |
| Delivery log | 8.0 | Good base. | Add customer replay UI/API. |
| DLQ | 8.0 | Good base. | Add batch replay and grouping. |

## 4.4 Scheduler (`scheduler.ts`) - 8.0/10

| Job | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Send outbox drain | 8.5 | Lag metrics limited. | Add queue age/outbox age SLO. |
| Reputation guard | 7.5 | Real ISP proof missing. | Add per-ISP shaping. |
| Blocklist monitor | 7.5 | Delisting workflow missing. | Add incident state machine. |
| Warmup advance | 7.0 | Real warmup proof missing. | Add warmup evidence tracking. |
| DKIM retire | 8.0 | Good base. | Add admin visibility. |
| Idempotency sweep | 8.0 | Good base. | Add metrics. |
| Metering reconcile | 7.0 | Drift not auto-resolved. | Add billing correction workflow. |
| Retention | 7.5 | Legal hold missing. | Add legal hold. |
| Postmaster ingest | 6.5 | Credentials optional/unproven. | Prove live integrations. |
| Volume baseline update | 7.0 | Risk model basic. | Add abuse intelligence feedback. |
| Stale send recovery | 8.5 | Good base. | Add alert if recovery count spikes. |
| Review timeout | 7.5 | Good base. | Add customer/operator notifications. |

## 4.5 Worker index/runtime (`index.ts`) - 7.5/10

Lacking:

- Runtime process orchestration and health checks need hardening.

To reach 10:

- Add worker `/ready` or metrics health.
- Add Kubernetes probes and queue worker liveness checks.

---

# 5. Tracker Package Deep Hierarchy

## 5.1 Tracker boot and middleware - 7.5/10

Lacking:

- No `/ready` dependency check.
- Rate limiting is per-IP but public tracking traffic can be huge and proxy-skewed.

To reach 10:

- Add readiness check for DB/Redis/queue.
- Add edge/CDN strategy and scanner-aware rate handling.

## 5.2 Open pixel - 7.5/10

Lacking:

- Open tracking reliability is inherently weak due privacy proxies.

To reach 10:

- Always report open metrics split by human/bot/suspicious.
- Add customer education in analytics UI.

## 5.3 Click redirect - 8.0/10

Lacking:

- No URL reputation/safe-browsing at redirect.

To reach 10:

- Add optional redirect-time threat check for high-risk URLs.
- Add branded tracking domain verification.

## 5.4 Unsubscribe - 8.5/10

Lacking:

- Preference center absent.

To reach 10:

- Add hosted preference center with consent history.

## 5.5 Metrics and health - 8.0/10

Lacking:

- Health endpoint is too shallow.

To reach 10:

- Add dependency readiness and tracker queue lag metrics.

---

# 6. Haraka Packages Deep Hierarchy

## 6.1 Outbound Haraka - 7.5/10

### 6.1.1 `customer_dkim.js` - 8.0/10

Strong:

- Customer-domain DKIM signing.
- Encrypted key support.

Lacking:

- Haraka plugin runtime behavior under key lookup failures and high throughput needs live proof.

To reach 10:

- Add Haraka integration tests with real SMTP session.
- Add DKIM signing failure metrics and alerts.

### 6.1.2 `event_emitter.js` - 7.5/10

Lacking:

- Provider event semantics may vary.

To reach 10:

- Normalize deferred/bounce/delivered into richer event model with SMTP enhanced codes.

### 6.1.3 `header_cleanup.js` - 7.5/10

Lacking:

- Header policy should be centralized with send API validation.

To reach 10:

- Add canonical allowed/blocked header policy shared by API and MTA.

### 6.1.4 Haraka config - 7.0/10

Lacking:

- Real TLS, auth, queue, outbound retry tuning are deployment-specific.

To reach 10:

- Add production Haraka hardening guide and smoke tests.

## 6.2 Inbound Haraka - 8.0/10

### 6.2.1 `bounce_parser.js` - 8.0/10

Strong:

- DSN/FBL parser integration.
- Deterministic event key.
- VERP verification.

Lacking:

- Real-world malformed bounce corpus limited.

To reach 10:

- Add provider corpus and unknown bounce quarantine.

### 6.2.2 Inbound config - 7.0/10

Lacking:

- Production MX/TLS/spam filtering posture not proven.

To reach 10:

- Add inbound MX hardening, rate limits, and abuse controls.

---

# 7. SDK Deep Hierarchy

## 7.1 Client core - 7.5/10

Lacking:

- Retry/idempotency convenience not fully visible.
- Only TypeScript SDK.

To reach 10:

- Add retry policy, idempotency helper, pagination helper.
- Add generated SDKs for multiple languages.

## 7.2 Error handling - 7.5/10

Lacking:

- Error taxonomy depends on API consistency.

To reach 10:

- Generate typed errors from OpenAPI error registry.

## 7.3 Webhook verification - 8.5/10

Strong:

- Sync and async signature verification helpers.

Lacking:

- Secret rotation overlap support should match server.

To reach 10:

- Support multiple active secrets and timestamp tolerance config.

---

# 8. Infra Deep Hierarchy

## 8.1 Migrations - 7.5/10

Lacking:

- No rollback/down.
- No expand/contract policy.

To reach 10:

- Add migration risk classification.
- Add backwards-compatible deploy policy.

## 8.2 Dockerfiles - 6.5/10

Lacking:

- Use `npm install`, not `npm ci`.
- Runtime images include full workspace.
- Migrations run on app startup.
- No digest pinning.

To reach 10:

- Multi-stage slim runtime with production deps only.
- Pin `node:20-alpine` digest.
- Remove production startup migrations from app command.
- Add read-only root filesystem where possible.

## 8.3 Docker Compose production overlay - 7.0/10

Lacking:

- Good env enforcement but not HA.
- Restart/health policies not enough.

To reach 10:

- Add healthchecks and restart policies.
- Document it as small/self-host mode, not enterprise HA.

## 8.4 Helm/Kubernetes - 7.5/10

Submodules:

| Submodule | Score | Lacking | To reach 10 |
|---|---:|---|---|
| Deployments | 7.5 | SecurityContext/read-only FS missing. | Add seccomp, runAsNonRoot, readOnlyRootFilesystem. |
| HPA | 7.0 | CPU-only. | Add queue age/custom metrics autoscaling. |
| PDB | 8.0 | Good base. | Validate disruption during real rolling deploy. |
| Ingress | 7.5 | Host placeholders. | Add prod values and TLS smoke tests. |
| NetworkPolicy | 7.5 | Namespace assumptions. | Add tested CNI profile and egress restrictions. |
| Migration job | 8.0 | Good base. | Ensure app images do not also migrate. |

## 8.5 Monitoring infra - 7.5/10

Lacking:

- Alertmanager placeholders.
- No alert fire-drill evidence.

To reach 10:

- Configure real PagerDuty/OpsGenie/Slack.
- Run alert game days.

## 8.6 Load test infra - 6.5/10

Lacking:

- k6 script exists but no staging run evidence.

To reach 10:

- Run k6 in CI/staging with published thresholds and artifacts.

---

# 9. Tests Deep Hierarchy

## 9.1 Unit tests - 8.0/10

Strong:

- Broad coverage: auth, keys, quotas, RLS, SSRF, templates, storage, webhooks, reputation, support.

Lacking:

- Some tests require DB env but harness does not self-configure.

To reach 10:

- Make test infra one-command.

## 9.2 E2E tests - 8.0/10

Strong:

- Real Fastify API and workers in many flows.

Lacking:

- Local test run initially failed without manual env/migration.

To reach 10:

- Add global setup to load `.env.test`, apply migrations, and isolate DB.

## 9.3 Security tests - 7.5/10

Strong:

- SSRF, webhook pinning, TOTP replay, config guard, security headers.

Lacking:

- No DAST, fuzzing, dependency clean gate at moderate level.

To reach 10:

- Add fuzz tests for parsers and public endpoints.
- Add OWASP ZAP/DAST on staging.

## 9.4 Load/concurrency tests - 6.5/10

Strong:

- Local concurrency tests and load findings exist.

Lacking:

- Not production-like.

To reach 10:

- Add sustained load, failover, queue-drain, and soak tests.

---

# 10. Docs And Runbooks Deep Hierarchy

## 10.1 User docs - 7.5/10

Lacking:

- Need clearer distinction between self-host/dev and production.

To reach 10:

- Add launch guide by persona: developer, ops, compliance, deliverability.

## 10.2 API docs - 7.5/10

Lacking:

- Need generated examples and SDK alignment.

To reach 10:

- Generate examples from OpenAPI tests.

## 10.3 Runbooks - 7.5/10

Lacking:

- Runbooks exist but fire-drill proof missing.

To reach 10:

- Add last-tested date, owner, escalation path, expected commands, rollback.

## 10.4 Enterprise deployment docs - 7.0/10

Lacking:

- Identifies gaps but does not implement them.

To reach 10:

- Turn every hard requirement into automated checks.

---

# 11. Final Hierarchical Score Summary

## 11.1 By Package

| Package/Area | Score |
|---|---:|
| `packages/api` | 8.0 |
| `packages/shared` | 8.0 |
| `packages/worker` | 8.0 |
| `packages/tracker` | 8.0 |
| `packages/haraka-outbound` | 7.5 |
| `packages/haraka-inbound` | 8.0 |
| `packages/sdk` | 7.5 |
| `packages/docs` and `docs` | 7.5 |
| `infra` | 7.0 |
| `scripts` | 7.0 |
| Runtime Docker topology | 7.0 |

## 11.2 By Product Capability

| Capability | Score |
|---|---:|
| API platform | 8.0 |
| API-key auth | 8.5 |
| Human auth | 8.0 |
| Admin auth | 8.0 |
| Tenant isolation | 6.0 |
| Send acceptance | 8.5 |
| Batch sending | 8.0 |
| Worker delivery | 8.5 |
| Event processing | 8.0 |
| Webhooks | 8.5 |
| Tracking/unsubscribe | 8.0 |
| Domains/DKIM | 8.0 |
| Deliverability operations | 7.0 |
| Abuse prevention | 7.0 |
| Billing | 6.5 |
| Privacy/retention | 7.5 |
| Support/admin ops | 7.5 |
| Observability | 7.5 |
| Infrastructure | 7.0 |
| Testing | 7.5 |
| Compliance evidence | 5.5 |

## 11.3 Exact Work Plan To Move Toward 10

### Phase A: Fix code-level enterprise blockers

1. Wire RLS into API route execution.
2. Refactor shared tenant services to accept transaction/context.
3. Enforce non-BYPASSRLS DB role in production startup.
4. Fix `.env.test` loading and port mismatch.
5. Fix RLS test role cleanup order.
6. Upgrade or risk-accept all moderate dependency advisories.

### Phase B: Make production deployment safe

1. Remove startup migrations from app containers in production.
2. Slim Docker images and use `npm ci`.
3. Pin image digests.
4. Add Kubernetes security contexts.
5. Add queue-age autoscaling.
6. Add secret manager integration.

### Phase C: Make SaaS product complete

1. Replace billing placeholder prices.
2. Add real provider sandbox tests.
3. Add preference center and consent ledger.
4. Add customer webhook replay UI/API.
5. Add template versioning and preview validation.
6. Add customer-facing deliverability diagnostics.

### Phase D: Prove operations

1. Run staging k6 load test.
2. Run Redis failover test.
3. Run Postgres restore drill.
4. Run object storage failure test.
5. Run alert fire drills.
6. Record RPO/RTO evidence.

### Phase E: Earn deliverability

1. Execute real IP warmup.
2. Configure Google Postmaster and SNDS.
3. Enroll FBLs.
4. Add inbox placement monitoring.
5. Add blocklist remediation workflow.
6. Add per-ISP adaptive throttling.

### Phase F: Enterprise compliance

1. Add SSO/SAML/OIDC and SCIM for customer tenants.
2. Add tamper-evident audit sink.
3. Add legal hold and data residency.
4. Add external pentest.
5. Add SOC 2 control evidence.
6. Add DPA/privacy operational evidence.

## Final Honest Deep Verdict

This is a strong codebase with real production engineering patterns. The deepest weakness is not that the send API is missing. It is that enterprise-grade proof is incomplete:

- Tenant isolation is not fully wired into production request execution.
- Real-world deliverability is not proven.
- Billing is not launch-complete.
- HA/DR and load limits are not proven.
- Compliance evidence is not complete.
- Supply-chain posture has unresolved moderate advisories.

Current deep rating:

- Codebase architecture: 8.0/10
- Core transactional send pipeline: 8.5/10
- SaaS business platform: 7.0/10
- Enterprise customer readiness: 6.5/10
- SendGrid-class operational maturity: 5.5/10

---

# 12. 10/10 Remediation Blueprint

This section turns the gap analysis into a direct engineering plan. For every
major module and deeper submodule, it states:

- What is missing.
- What to build or change.
- Which files or areas are likely involved.
- Which tests or proof are required.
- What "10/10 done" means.

## 12.1 Production-Grade Definition For This Project

For this mail platform, a module is 10/10 only when all five conditions are true:

1. Code path is implemented and typed.
2. Failure modes are fail-closed or safely degraded.
3. Unit and E2E tests prove the critical behavior.
4. Deployment config proves the behavior in production topology.
5. Operational evidence exists: load, failover, alert, runbook, or real provider proof.

Most current gaps are not "missing code" gaps. They are "missing integration",
"missing production proof", or "missing enterprise workflow" gaps.

---

# 13. Package-Level 10/10 Plan

## 13.1 `packages/api` 10/10 Plan

Current score: 8.0/10  
Target: API is tenant-isolated, modular, policy-declared, contract-tested, and production-safe.

### 13.1.1 API Route Modularity

Missing:

- `admin.ts` is too large and combines unrelated operational domains.
- Route metadata is implicit.
- No automated guarantee that every route declares auth, tenant scope, capability, and audit policy.

Implementation:

- Split `packages/api/src/routes/admin.ts` into:
  - `admin-auth.ts`
  - `admin-customers.ts`
  - `admin-support.ts`
  - `admin-review.ts`
  - `admin-dlq.ts`
  - `admin-deliverability.ts`
  - `admin-billing.ts`
  - `admin-retention.ts`
  - `admin-audit.ts`
- Add route metadata helper:

```ts
type RouteSecurity = {
  auth: 'public' | 'api_key' | 'user_session' | 'admin_session';
  tenantScoped: boolean;
  requiredScope?: string;
  requiredCapability?: string;
  adminRole?: string;
  audit: 'none' | 'safe' | 'required';
};
```

- Wrap route registration through a local helper so metadata is declared near route code.

Tests required:

- Static route inventory test that scans all registered routes and checks metadata.
- Test that no tenant-scoped route has `tenantScoped=false`.
- Test that mutating routes declare audit behavior.

10/10 acceptance:

- Every route has machine-checkable security metadata.
- Admin routes are split by domain.
- A missing auth/scope/audit declaration fails CI.

### 13.1.2 Tenant Context Integration

Missing:

- RLS exists, but production API routes do not use `withTenant()`.
- Shared services import global `db`, so tenant transactions are hard to enforce.

Implementation:

- Add a shared type in `packages/shared/src/db.ts`:

```ts
export type DbExecutor = Kysely<Database> | Transaction<Database>;
```

- Refactor tenant-scoped shared services from:

```ts
export async function listDomains(customerId: string) {
  return db.selectFrom(...);
}
```

to:

```ts
export async function listDomains(ctx: TenantCtx) {
  return ctx.db.selectFrom(...).where('customer_id', '=', ctx.customerId);
}
```

- Add:

```ts
export interface TenantCtx {
  db: DbExecutor;
  customerId: string;
  actor?: AuditActor;
  requestId?: string;
}
```

- For API-key routes, wrap handler logic in:

```ts
return withTenant(req.auth!.customer_id, async (trx) => {
  const ctx = { db: trx, customerId: req.auth!.customer_id, actor, requestId: req.id };
  return handler(ctx);
});
```

- For user-session org routes, use `req.user!.current_customer_id`.
- Keep workers/admin service roles separate and explicit.

Files likely involved:

- `packages/shared/src/tenant-context.ts`
- `packages/shared/src/db.ts`
- `packages/api/src/plugins/auth.ts`
- `packages/api/src/plugins/session-auth.ts`
- `packages/api/src/routes/*.ts`
- `packages/shared/src/domains.ts`
- `packages/shared/src/webhooks.ts`
- `packages/shared/src/apikey-management.ts`
- `packages/shared/src/support.ts`
- `packages/shared/src/billing.ts`
- `packages/shared/src/audit.ts`

Tests required:

- E2E test that injects a deliberately buggy route/query without `customer_id` filter and proves RLS still blocks cross-tenant rows.
- Startup test that production refuses superuser or BYPASSRLS API DB role.
- Static test that tenant services do not import global `db`.

10/10 acceptance:

- API runs as non-superuser/non-BYPASSRLS role.
- Tenant routes execute in transaction-local `app.customer_id`.
- Cross-tenant leak remains impossible even if a query omits `customer_id`.

### 13.1.3 Public API Contract

Missing:

- OpenAPI exists, but route-to-spec parity and backward compatibility enforcement are incomplete.

Implementation:

- Generate OpenAPI from route schemas, or add route-spec parity tests.
- Add API compatibility CI:
  - Current spec vs previous release spec.
  - Fails on removed path, removed response field, changed required field, narrowed enum, changed status code.
- Add public error-code registry:

```md
error_code | HTTP | retryable | message stability | docs link
```

Tests required:

- `openapi-route-parity.test.ts`
- `openapi-breaking-change.test.ts`
- `error-registry.test.ts`

10/10 acceptance:

- Every public route appears in OpenAPI.
- Every documented error code is tested.
- Breaking changes fail CI unless version is bumped.

---

## 13.2 `packages/shared` 10/10 Plan

Current score: 8.0/10  
Target: shared logic is context-aware, testable, provider-safe, and production-configurable.

### 13.2.1 Database Access Pattern

Missing:

- Many files import global `db`.
- This prevents enforcing tenant transactions consistently.

Implementation:

- Introduce context types:

```ts
export interface SystemCtx { db: DbExecutor; actor?: AuditActor; requestId?: string; }
export interface TenantCtx extends SystemCtx { customerId: string; }
```

- Refactor tenant modules:
  - `domains.ts`
  - `webhooks.ts`
  - `apikey-management.ts`
  - `message-activity.ts`
  - `support.ts` customer-facing parts
  - `billing.ts` customer-facing parts
  - `suppression.ts`
  - `templates.ts`
  - `audit.ts`

- Allow global `db` only in:
  - workers using service role
  - schedulers
  - migration runner
  - testkit

Tests required:

- Static import test:

```txt
tenant-scoped service files must not import { db } from './db.js'
```

10/10 acceptance:

- Tenant service functions accept context.
- Route handlers pass transaction-scoped context.
- RLS is active for API reads/writes.

### 13.2.2 Config Guard Expansion

Missing:

- `config-guard.ts` checks core secrets, but provider-specific production checks are not complete.

Implementation:

Add production validation for:

- `DELIVERY_TRANSPORT=ses`
  - `SES_SMTP_HOST`
  - `SES_SMTP_USER`
  - `SES_SMTP_PASS`
  - `SES_MAX_CONNECTIONS`
- `BODY_STORAGE=s3`
  - bucket
  - region/endpoint
  - credentials or IAM mode
- `KMS_PROVIDER=aws|gcp|vault`
  - provider-specific wrapped key and connection details
- `BILLING_PROVIDER=stripe|paypal|cashfree`
  - provider credentials
  - webhook secret
  - plan map
- `EVENTS_CLICKHOUSE_URL`
  - credentials and database config if enabled
- `OTEL_EXPORTER_OTLP_ENDPOINT`
  - must be HTTPS or internal allowlisted endpoint in production

Files:

- `packages/shared/src/config-guard.ts`
- `packages/tests/config-guard.test.ts`
- `scripts/production-readiness-check.mjs`

Tests required:

- One negative test per missing provider setting.
- One positive test per fully configured provider.

10/10 acceptance:

- Production cannot boot in a half-configured provider state.
- Mock providers cannot be selected accidentally in production.

### 13.2.3 Secret Rotation

Missing:

- API key pepper, user token pepper, webhook secrets, and VERP secret do not have a full dual-secret rotation model.

Implementation:

- Add current/previous env convention:
  - `API_KEY_PEPPER_CURRENT`
  - `API_KEY_PEPPER_PREVIOUS`
  - `USER_SESSION_PEPPER_CURRENT`
  - `USER_SESSION_PEPPER_PREVIOUS`
  - `VERP_SECRET_CURRENT`
  - `VERP_SECRET_PREVIOUS`
- Verification accepts current or previous.
- New tokens are signed with current.
- On successful verification with previous, rehash/reissue when possible.

Files:

- `apikeys.ts`
- `tokens.ts`
- `crypto.ts`
- `webhooks.ts`
- `admin.ts`
- `user-sessions.ts`

Tests required:

- Old token works during rotation window.
- Old token fails after previous is removed.
- New token uses current only.

10/10 acceptance:

- Every long-lived secret has a documented and tested rotation path.

---

## 13.3 `packages/worker` 10/10 Plan

Current score: 8.0/10  
Target: queue processing is observable, replayable, provider-aware, and HA-tested.

### 13.3.1 Send Worker Provider Error Taxonomy

Missing:

- Transport errors are not classified deeply enough for ISP-grade retry behavior.

Implementation:

- Add `packages/shared/src/delivery-errors.ts`:

```ts
export type DeliveryFailureClass =
  | 'temporary_mailbox'
  | 'temporary_provider'
  | 'rate_limited'
  | 'policy_block'
  | 'auth_failure'
  | 'invalid_recipient'
  | 'domain_not_found'
  | 'content_rejected'
  | 'permanent_unknown'
  | 'temporary_unknown';
```

- Parse SMTP enhanced status codes:
  - `4.x.x` temporary
  - `5.1.1` invalid recipient
  - `5.2.x` mailbox/full/policy depending code
  - `5.7.x` policy/auth/content
- Store `failure_class`, `enhanced_status_code`, `provider_code` on events or messages.
- Retry based on class, not only thrown error.

Files:

- `packages/worker/src/send-worker.ts`
- `packages/shared/src/transport.ts`
- migration for failure columns if needed

Tests required:

- SMTP 421 retries.
- SMTP 450 retries.
- SMTP 550 invalid recipient suppresses.
- SMTP 554 content rejected triggers review/failed.
- Auth failure alerts operator and does not hammer provider.

10/10 acceptance:

- Customer can see why delivery failed.
- Worker retries only retryable classes.
- Alerts trigger on provider auth/config failures.

### 13.3.2 Queue Age SLO

Missing:

- Backpressure uses depth, but queue age is a better SLO signal.

Implementation:

- Record oldest waiting job age for send/events/webhooks.
- Export metrics:
  - `mp_queue_oldest_job_age_seconds{queue=...}`
  - `mp_queue_processing_latency_seconds`
- Backpressure when oldest send job age exceeds threshold.
- HPA should scale on queue age/custom metric, not only CPU.

Files:

- `packages/shared/src/metrics.ts`
- `packages/worker/src/index.ts`
- `packages/api/src/routes/send.ts`
- Helm HPA templates

Tests required:

- Simulated old queue job triggers backpressure.
- Metrics expose queue age.

10/10 acceptance:

- Queue has age-based SLO and autoscaling signal.

### 13.3.3 DLQ Replay Safety

Missing:

- DLQ replay exists, but batch replay/dry-run/root-cause grouping is incomplete.

Implementation:

- Add DLQ dry-run endpoint.
- Group by:
  - source queue
  - error class
  - first seen time
  - customer
  - provider
- Add batch replay with filters and max limit.
- Require admin approval for purge/bulk replay.

Files:

- `packages/shared/src/queues.ts`
- `packages/api/src/routes/admin.ts` or split `admin-dlq.ts`
- tests under `packages/tests/e2e/dlq.e2e.test.ts`

10/10 acceptance:

- Operator can safely inspect, dry-run, replay, or purge DLQ with audit trail.

### 13.3.4 Scheduler Production Split

Missing:

- Scheduler is in-process inside worker.

Implementation:

- Add separate CLI entrypoints:
  - `scheduler-job reputation_guard`
  - `scheduler-job blocklist_monitor`
  - `scheduler-job warmup_advance`
  - `scheduler-job dkim_retire`
  - `scheduler-job retention`
  - `scheduler-job postmaster_ingest`
- Add Kubernetes CronJobs for each.
- Keep in-process scheduler only for local/dev.

Files:

- `packages/worker/src/scheduler.ts`
- new `packages/worker/src/scheduler-cli.ts`
- Helm templates for CronJobs

10/10 acceptance:

- Production scheduled tasks are independently observable CronJobs.
- Missed job triggers alert.

---

## 13.4 `packages/tracker` 10/10 Plan

Current score: 8.0/10  
Target: public tracking is high-volume, branded, scanner-aware, and privacy-transparent.

### 13.4.1 Branded Tracking Domains

Missing:

- Tracker uses global `TRACKING_DOMAIN`.
- Per-tenant branded tracking domain is not complete.

Implementation:

- Add table:

```sql
tracking_domains (
  id uuid,
  customer_id uuid,
  domain text,
  cname_verified boolean,
  tls_status text,
  created_at timestamptz
)
```

- Add DNS records for CNAME target.
- Select tracking domain per message/customer.
- Enforce verified tracking domain for enterprise tenants.

Files:

- migrations
- `domains.ts` or new `tracking-domains.ts`
- `send-worker.ts`
- `tracker/server.ts`
- account route for tracking domain management

Tests:

- Message links use tenant tracking domain.
- Unverified tracking domain cannot be used.
- Tracker resolves message correctly across domains.

10/10 acceptance:

- Enterprise customers can use branded tracking domains with verified TLS.

### 13.4.2 Tracker Readiness And Load

Missing:

- Tracker `/health` is shallow.
- Public high-volume load proof missing.

Implementation:

- Add `/ready` checking DB, Redis, queue.
- Add tracker k6 script:
  - open pixel load
  - click redirect load
  - unsubscribe POST load
- Add CDN/proxy deployment notes.

10/10 acceptance:

- Tracker has p99 latency SLO under expected open/click volume.

### 13.4.3 Preference Center

Missing:

- One-click unsubscribe exists, but no full preference center.

Implementation:

- Add hosted page:
  - global unsubscribe
  - group unsubscribe
  - resubscribe if allowed
  - consent history view
- Add signed preference token.
- Add tenant branding settings.

Files:

- `packages/tracker/src/server.ts`
- `packages/shared/src/suppression.ts`
- new consent ledger migrations

10/10 acceptance:

- Recipient can manage preferences, and every change is auditable.

---

## 13.5 Haraka 10/10 Plan

Current score: outbound 7.5/10, inbound 8.0/10  
Target: MTAs are operationally ready, provider-classified, observable, and hardened.

### 13.5.1 Outbound MTA Hardening

Missing:

- Real MTA operations are not proven.
- TLS/PTR/HELO consistency and queue behavior are not deeply validated.

Implementation:

- Add startup checks:
  - hostname/HELO configured
  - PTR matches sending IP
  - TLS cert valid
  - DKIM key load works
- Add Haraka metrics:
  - outbound queue size
  - deferred count
  - bounce count
  - DKIM failures
  - TLS failures
- Add provider-specific deferral classification.

Tests:

- SMTP session test through Haraka outbound.
- DKIM signature validates with generated public key.
- Deferred event emits correct class.

10/10 acceptance:

- Outbound MTA can be operated with dashboards, alerts, and clear failure classes.

### 13.5.2 Inbound Bounce/FBL Hardening

Missing:

- Real-world bounce corpus is incomplete.

Implementation:

- Add fixtures:
  - Gmail hard bounce
  - Gmail soft bounce
  - Outlook deferral
  - Yahoo complaint
  - malformed DSN
  - oversized attachment DSN
- Add unknown report quarantine queue.
- Add provider/source classification.

10/10 acceptance:

- Unknown DSN/FBL formats are visible and triageable, not silently lost.

---

# 14. Product Capability 10/10 Plan

## 14.1 Deliverability 10/10

Current score: 5.5-7.0/10 depending submodule.

### Missing Production Reality

Deliverability cannot be made 10/10 by code alone. It needs operational evidence:

- Dedicated/shared IP pools with PTR.
- Real IP warmup executed over time.
- Google Postmaster verified domains.
- Microsoft SNDS configured.
- FBL enrollment.
- Blocklist monitoring and delisting workflow.
- Inbox placement tests.
- ISP-specific throttling.

### Implementation Plan

1. Add `deliverability_incidents` table:

```sql
deliverability_incidents (
  id uuid,
  type text,
  provider text,
  ip inet,
  domain text,
  severity text,
  status text,
  opened_at timestamptz,
  resolved_at timestamptz,
  metadata jsonb
)
```

2. Add per-ISP send shaping:

```ts
type IspPolicy = {
  domainPattern: string;
  maxConcurrent: number;
  hourlyLimit: number;
  retryBackoff: number[];
};
```

3. Add warmup evidence table:

```sql
ip_warmup_daily (
  ip inet,
  usage_date date,
  sent int,
  delivered int,
  hard_bounced int,
  complained int,
  inbox_placement numeric,
  stage int
)
```

4. Add inbox placement provider integration or seed-list import.

5. Add admin pages/API:
   - IP pool status.
   - ISP throttles.
   - Blocklist incidents.
   - Warmup progress.
   - Postmaster/SNDS snapshots.

Acceptance criteria:

- 30+ days warmup evidence for each production IP.
- Complaint rate below 0.3%.
- Hard bounce rate below 5%.
- Inbox placement target defined and measured.
- Blocklist incident runbook tested.

## 14.2 Billing 10/10

Current score: 6.5/10.

### Missing

- Placeholder price IDs.
- Tax/VAT/GST.
- Dunning.
- Refunds/credits.
- Invoice PDFs.
- Provider sandbox/live proof.
- Metered ledger immutability.

### Implementation Plan

1. Move `TIER_BY_PRICE` to config/database:

```sql
billing_plans (
  id uuid,
  provider text,
  provider_price_id text,
  plan_key text,
  tier text,
  daily_quota int,
  monthly_quota int,
  features jsonb,
  active boolean
)
```

2. Add usage ledger:

```sql
usage_ledger (
  id bigserial,
  customer_id uuid,
  message_id text,
  usage_type text,
  quantity int,
  occurred_at timestamptz,
  source text,
  idempotency_key text unique
)
```

3. Add dunning state:

```sql
billing_dunning_events (
  id uuid,
  customer_id uuid,
  provider_event_id text,
  state text,
  grace_ends_at timestamptz,
  action_taken text
)
```

4. Add provider integration tests:
   - Stripe checkout.
   - Stripe webhook subscription created/updated/deleted.
   - Stripe usage reporting.
   - PayPal fixed-plan checkout.
   - Cashfree fixed-plan checkout.

Acceptance criteria:

- No placeholder prices.
- Provider sandbox CI can prove lifecycle.
- Usage ledger reconciles exactly to invoices.
- Failed payment behavior is deterministic and documented.

## 14.3 Consent And Compliance 10/10

Current score: 5.5-7.5/10.

### Missing

- Consent ledger.
- Preference center.
- Legal hold.
- Data residency.
- Backup erasure policy.
- Immutable audit.

### Implementation Plan

1. Add consent ledger:

```sql
recipient_consent_events (
  id uuid,
  customer_id uuid,
  email text,
  event_type text,
  source text,
  ip inet,
  user_agent text,
  consent_text text,
  lawful_basis text,
  occurred_at timestamptz,
  metadata jsonb
)
```

2. Add legal hold:

```sql
legal_holds (
  id uuid,
  customer_id uuid,
  scope text,
  reason text,
  created_by uuid,
  released_at timestamptz
)
```

3. Add audit hash chain:

```sql
audit_log_hashes (
  audit_id bigint,
  previous_hash text,
  row_hash text,
  created_at timestamptz
)
```

4. Add data inventory:

```ts
const piiRegistry = [
  { table: 'messages', columns: ['to_address', 'from_address', 'subject'] },
  { table: 'events', columns: ['ip', 'user_agent'] },
  ...
];
```

5. Add tests that DSAR export/delete covers every table in registry.

Acceptance criteria:

- Every consent/unsubscribe/suppression change has an event.
- Erasure/export tests fail when a new PII table is added but not handled.
- Audit log tampering is detectable.
- Legal hold blocks destructive erasure where required.

---

# 15. Infrastructure 10/10 Plan

## 15.1 Docker Images

Current score: 6.5/10.

Missing:

- `npm install` instead of deterministic `npm ci`.
- Full workspace copied into runtime.
- No image digest pinning.
- App containers run migrations.
- No read-only root FS posture.

Implementation:

- Use multi-stage Dockerfile:
  - build with `npm ci`
  - prune dev deps
  - copy only `dist`, package metadata, production node_modules
- Pin base image:

```dockerfile
FROM node:20-alpine@sha256:<digest>
```

- Remove migration from CMD:

```dockerfile
CMD ["node", "packages/api/dist/server.js"]
```

- Add separate migration image/job.

Acceptance criteria:

- Reproducible image builds.
- Smaller runtime images.
- Trivy high/critical clean.
- App containers do not mutate schema at startup.

## 15.2 Kubernetes

Current score: 7.5/10.

Missing:

- SecurityContext hardening.
- Queue-age autoscaling.
- ExternalSecrets.
- Cloud-specific reference.

Implementation:

- Add to deployments:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  seccompProfile:
    type: RuntimeDefault
```

- Use KEDA or custom metrics for BullMQ queue age.
- Add ExternalSecrets templates.
- Add production values:
  - `values.aws.yaml`
  - `values.gcp.yaml`
  - `values.azure.yaml`

Acceptance criteria:

- Pods meet restricted Pod Security Standard.
- Worker autoscaling responds to queue age.
- Secrets are sourced from managed secret store.

## 15.3 HA And DR

Current score: 5.5/10.

Missing:

- RPO/RTO evidence.
- Restore drill evidence.
- Redis failover evidence.
- Object storage recovery.
- ClickHouse recovery.

Implementation:

- Define:
  - RPO: maximum acceptable data loss.
  - RTO: maximum restore time.
- Add quarterly drill script:
  - restore Postgres to new DB
  - verify migrations
  - verify sample customer/messages/events
  - verify body objects
  - verify Redis can be rebuilt or safely cold-started
- Add failover runbook for Redis and DB.

Acceptance criteria:

- Latest restore drill date in docs.
- Restore completes within RTO.
- Data loss within RPO.
- Drill evidence attached to release checklist.

---

# 16. Testing 10/10 Plan

## 16.1 Fix Test Harness

Current score: 6.5/10.

Missing:

- `.env.test` not auto-loaded.
- Test DB port mismatch.
- Migrations manual.
- RLS role cleanup order can fail.

Implementation:

1. Fix `.env.test`:

```env
DATABASE_URL=postgresql://mail_test:mailtest@localhost:5434/mail_test
```

2. Load dotenv in `vitest.config.ts` or global setup:

```ts
import dotenv from 'dotenv';
dotenv.config({ path: '../../.env.test' });
dotenv.config({ path: '../../.env.test.local', override: true });
```

3. Add test setup command:

```json
"test:infra": "docker compose -f docker-compose.test.yml up -d",
"test:migrate": "cross-env DATABASE_URL=... npm run migrate",
"test:full": "npm run test:infra && npm run test:migrate && npm test"
```

4. Fix RLS test:

- Before dropping role, run:
  - `DROP OWNED BY rls_app_test_role`
  - then `DROP ROLE`

Acceptance criteria:

- Fresh clone can run one command and get green tests.
- No manual env export required.

## 16.2 Add Deep Production Test Suites

Missing:

- No DAST/fuzz.
- No cloud-provider integration.
- No failover tests.

Implementation:

Add suites:

- `tests/fuzz/dsn-fuzz.test.ts`
- `tests/fuzz/webhook-url-fuzz.test.ts`
- `tests/integration/minio-storage.test.ts`
- `tests/integration/stripe-sandbox.test.ts`
- `tests/chaos/redis-failover.test.ts`
- `tests/chaos/worker-crash-recovery.test.ts`
- `tests/load/k6-staging.md` with artifacts.

Acceptance criteria:

- Parser fuzzing runs in CI.
- MinIO proves object store paths.
- Staging load test artifacts exist per release.

---

# 17. Security 10/10 Plan

## 17.1 Dependency Remediation

Current score: 6.5/10.

Missing:

- 27 moderate advisories remain.

Implementation:

- Upgrade OpenTelemetry packages together.
- Run:
  - build
  - test
  - tracing tests
  - smoke tracing with local collector
- Upgrade `protobufjs` and `tar`.
- If any cannot be upgraded, add `SECURITY_RISK_ACCEPTANCE.md` with:
  - advisory
  - exploitability
  - affected runtime path
  - compensating control
  - owner
  - expiry date

Acceptance criteria:

- `npm audit --omit=dev --audit-level=moderate` passes, or every remaining advisory has signed time-bound risk acceptance.

## 17.2 External Security Review

Current score: 4.0/10.

Missing:

- No independent pentest/SOC2 evidence.

Implementation:

- Create threat model:
  - public API
  - tracker
  - webhooks outbound
  - inbound SMTP
  - admin plane
  - billing webhooks
  - object storage
- Run external pentest.
- Add remediation tracker.

Acceptance criteria:

- Pentest completed.
- High/critical findings fixed.
- Medium findings triaged with deadlines.

---

# 18. Module Completion Checklist Template

Use this checklist for each module before calling it 10/10:

```md
## Module: <name>

Code:
- [ ] Core behavior implemented.
- [ ] Failure paths implemented.
- [ ] Inputs validated.
- [ ] Outputs documented.
- [ ] Tenant isolation enforced where applicable.

Security:
- [ ] Auth/scope/capability declared.
- [ ] Audit required for mutations.
- [ ] Secrets are not logged.
- [ ] SSRF/injection/data leak risks reviewed.
- [ ] Rate limits/backpressure in place.

Testing:
- [ ] Unit tests.
- [ ] E2E tests.
- [ ] Negative/security tests.
- [ ] Concurrency/idempotency tests where relevant.
- [ ] Migration tests where schema changes exist.

Operations:
- [ ] Metrics.
- [ ] Alerts.
- [ ] Runbook.
- [ ] Load/failover proof.
- [ ] Dashboard panel.

Production:
- [ ] Config guard.
- [ ] Deployment manifest.
- [ ] Secret manager integration.
- [ ] Backup/restore impact understood.
- [ ] Rollback/forward-fix plan.
```

---

# 19. Updated Final Remediation Priority

## Immediate Engineering Sprint

1. Fix test harness.
2. Wire RLS into API tenant routes.
3. Expand config guard.
4. Upgrade dependencies.
5. Split `admin.ts`.
6. Remove production app startup migrations.

## Next SaaS Sprint

1. Real billing plan config.
2. Consent ledger.
3. Preference center.
4. Template versioning.
5. Webhook endpoint verification and replay.
6. Customer-facing deliverability diagnostics.

## Production Proof Sprint

1. k6 staging load test.
2. Redis failover test.
3. Postgres restore drill.
4. MinIO/S3 integration proof.
5. Alert fire drill.
6. Worker crash and stale recovery proof.

## Enterprise Sprint

1. Customer SSO/SAML/OIDC.
2. SCIM.
3. Immutable audit.
4. Legal hold.
5. Data residency.
6. External pentest and compliance evidence.

---

# 20. External Standards Validation Addendum

Validation date: 2026-06-25  
Scope: validate whether this report is still true against local code evidence plus current primary/official external requirements.  
Verdict: the report is mostly valid, but several submodules need more precise scoring and sharper 10/10 acceptance gates.

## 20.1 Primary Sources Checked

| Area | Source | Why it matters |
| --- | --- | --- |
| Gmail sender requirements | https://support.google.com/mail/answer/81126 | Official Gmail sender and bulk sender requirements. |
| Gmail one-click FAQ | https://support.google.com/mail/answer/14229414 | Confirms RFC 8058 header requirement and HTTPS List-Unsubscribe URL behavior. |
| Yahoo sender requirements | https://senders.yahooinc.com/best-practices/ | Official Yahoo bulk sender guidance: one-click/list-unsubscribe, visible unsubscribe, 2-day unsubscribe processing, spam rate below 0.3%. |
| RFC 8058 | https://www.rfc-editor.org/info/rfc8058/ | Defines one-click unsubscribe signaling for List-Unsubscribe headers. |
| DMARC RFC 9989 | https://www.rfc-editor.org/info/rfc9989/ | Defines DMARC policy records and alignment. |
| PostgreSQL RLS | https://www.postgresql.org/docs/current/ddl-rowsecurity.html | Confirms superusers and BYPASSRLS roles bypass RLS; table owners bypass unless FORCE RLS is used. |
| OWASP API Security Top 10 2023 | https://owasp.org/API-Security/editions/2023/en/0x11-t10/ | Validates the report's focus on object authorization, auth, resource consumption, SSRF, security misconfiguration, inventory, and third-party API consumption. |
| Kubernetes probes | https://kubernetes.io/docs/concepts/workloads/pods/probes/ | Confirms Kubernetes uses probes to restart unhealthy containers or stop routing to unready containers. |
| Kubernetes security context | https://kubernetes.io/docs/tasks/configure-pod-container/security-context/ | Confirms seccomp/securityContext hardening expectations. |
| Docker build best practices | https://docs.docker.com/build/building/best-practices/ | Confirms minimal base image and vulnerability-minimization guidance. |
| Stripe webhook docs | https://docs.stripe.com/webhooks | Confirms webhook signature verification requirement using payload, Stripe-Signature header, and endpoint secret. |
| AWS S3 security best practices | https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html | Confirms least-privilege S3 permissions and production object-storage hardening. |
| OpenTelemetry advisory | https://github.com/advisories/GHSA-8988-4f7v-96qf | Confirms `@opentelemetry/core` 2.7.1 baggage parsing advisory and upgrade to 2.8.0+. |
| NIST SP 800-63B | https://pages.nist.gov/800-63-4/sp800-63b.html | Validates MFA/session expectations for enterprise identity posture. |

## 20.2 Report Accuracy Summary

| Report claim | Validation result | Correction needed |
| --- | --- | --- |
| Platform is not 10/10 production-grade yet. | Valid. | Keep. The codebase is advanced, but RLS integration, real billing launch, DR, security contexts, load proof, and enterprise controls are not complete. |
| RLS exists but is not wired into API execution. | Valid. | Keep. `packages/shared/src/tenant-context.ts` exists, `infra/migrations/023_rls.sql` enables RLS, but `rg "withTenant(" packages` found no production route usage. |
| RLS policies allow all rows when no tenant is set. | Valid. | Keep and raise severity. `current_tenant_id() IS NULL` in policies means missing tenant context disables the RLS safety net. |
| API routes still use explicit `customer_id` filters. | Valid but incomplete as a control. | Clarify that explicit filters reduce risk, but they are not a 10/10 isolation guarantee because one missed filter becomes a cross-tenant bug. |
| Complaint rate target is below 0.3%. | Partially valid. | Yahoo says below 0.3%. Gmail guidance should be treated stricter: keep spam rate below 0.10% and avoid 0.30% or higher. |
| One-click unsubscribe exists. | Mostly valid. | Code adds `List-Unsubscribe` and `List-Unsubscribe-Post`; tracker handles POST. But 10/10 requires HTTPS List-Unsubscribe in production, visible body unsubscribe, monitoring, and proof unsubscribes are honored within 2 days. |
| Billing webhook verification is weak. | Needs correction. | Local code has provider-specific signature checks and tests for Stripe/PayPal/Cashfree. The remaining gap is live provider proof, real price IDs, dunning, reconciliation, idempotent replay tooling, and no mock fallback in production. |
| Helm needs probes. | Partially outdated. | Helm has liveness/readiness probes for API/worker/tracker. The remaining gap is startup probes, dependency-rich readiness, worker queue readiness, and tracker `/ready`. |
| Kubernetes security context missing. | Valid. | Keep. Helm deployments show probes/resources but no container `securityContext`, pod `securityContext`, seccomp, dropped capabilities, read-only root filesystem, or explicit non-root UID. |
| Docker containers need health/restart hardening. | Valid for Compose/runtime. | Keep. Local Docker inspect showed non-root user, but no container healthcheck and no restart policy for API/worker/tracker. |
| Dependency posture blocks enterprise 10/10. | Valid. | Keep. `npm audit --omit=dev --audit-level=moderate --json` found 27 moderate advisories, including OpenTelemetry core baggage advisory. |
| S3/object storage needs production proof. | Valid. | Keep. Code implements S3-compatible storage, but there is no evidence of least-privilege IAM, lifecycle, encryption, replication, backup, or MinIO CI proof. |
| OWASP API risks are not fully closed. | Valid. | Keep and map each API module to OWASP categories in the next section. |

## 20.3 Corrected Module Scores After Validation

These are not replacements for every earlier score. They are corrections where external research or code evidence changed the confidence level.

| Module | Earlier direction | Corrected score | Why |
| --- | ---: | ---: | --- |
| Tenant isolation/RLS | 6.0 | 5.5 | RLS exists, but policies are permissive when tenant context is absent, and production routes do not use `withTenant()`. This is the highest-risk SaaS gap. |
| One-click unsubscribe | 8.5 | 8.0 | Implementation is strong, but Gmail requires RFC 8058-style headers with HTTPS URL for commercial/promotional mail; 10/10 also needs visible body unsubscribe and operational SLA proof. |
| Billing webhook signature security | 7.0-7.5 | 8.0 | Code verifies provider signatures and tests invalid signatures. The gap is not signature basics; it is live provider validation, replay tooling, idempotency, dunning, plan config, and production no-mock enforcement. |
| Helm probes | 7.5 | 8.0 | Helm already has liveness/readiness. Still missing startup probes and readiness semantics tied to real dependencies/queues. |
| Kubernetes workload hardening | 7.5 | 6.5 | NetworkPolicy/resources/probes exist, but lack of securityContext/seccomp/capability drops/read-only filesystem is a production hardening blocker. |
| Docker image/runtime hardening | 6.5 | 6.5 | Non-root is good, but image uses broad workspace copy/install pattern, app containers run migrations, and Compose lacks health/restart policies. |
| Deliverability operations | 5.5-7.0 | 5.5 | Code has useful deliverability primitives, but inbox-provider compliance depends on live DNS, feedback loops, complaint telemetry, Postmaster/SNDS proof, warmup evidence, and IP/domain reputation history. |
| S3/body storage | 7.5 | 7.0 | Implementation exists, but 10/10 needs cloud IAM proof, lifecycle/encryption/backup, MinIO CI, and erasure propagation validation. |
| Observability/dependencies | 7.0 | 6.5 | Metrics endpoint is protected and tracing exists, but dependency advisories and missing SLO/burn-rate alert proof block 10/10. |

## 20.4 Deep Validation By Module And Submodule

### 20.4.1 Deliverability Compliance

Current score: 5.5/10

#### 20.4.1.1 Gmail Bulk Sender Compliance

Local evidence:
- `packages/worker/src/send-worker.ts` adds `List-Unsubscribe` and `List-Unsubscribe-Post`.
- `.env.production.example` sets `TRACKING_DOMAIN=https://track.example.com`.
- `packages/shared/src/reputation.ts` has provider/reputation primitives.

Missing for 10/10:
- Enforce `TRACKING_DOMAIN` is HTTPS in production.
- Enforce every marketing/subscribed message has RFC 8058 one-click headers.
- Add a visible unsubscribe link to marketing/promotional body content, not only headers.
- Track Gmail spam rate separately with a production objective of below 0.10%; alert at 0.08%; auto-throttle at 0.10%; emergency pause at 0.30%.
- Track DMARC alignment pass rate per sending domain.
- Maintain Google Postmaster verification and ingestion proof for every production domain.
- Produce a daily Gmail compliance report: SPF pass, DKIM pass, DMARC aligned pass, TLS, PTR, complaint rate, one-click header presence, unsubscribe body-link presence.

10/10 acceptance:
- A synthetic campaign can prove Gmail headers contain one HTTPS List-Unsubscribe URL and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- A production dashboard shows Gmail spam rate below 0.10% for 30 consecutive days.
- Sending automatically slows or pauses when complaint thresholds are crossed.
- Compliance failures block the send before SMTP handoff.

#### 20.4.1.2 Yahoo Bulk Sender Compliance

Local evidence:
- One-click infrastructure exists.
- Suppression/unsubscribe tables exist.
- Tracker POST writes group or global suppression.

Missing for 10/10:
- Explicit "honor unsubscribe within 2 days" SLA metric.
- Yahoo-specific complaint/FBL ingestion proof.
- Yahoo complaint rate dashboard with threshold below 0.3%.
- Daily verification that each marketing message contains a visible body unsubscribe link.

10/10 acceptance:
- Every unsubscribe event has `received_at`, `effective_at`, and `latency_seconds`.
- 99.99% of unsubscribe requests become effective within 5 minutes; 100% within 2 days.
- Yahoo complaint rate stays below 0.3% and alerts well before that.

#### 20.4.1.3 DMARC/SPF/DKIM Alignment

Local evidence:
- Domain APIs and DKIM rotation exist.
- Haraka outbound has DKIM signing plugin.
- DNS/domain verification exists at code level.

Missing for 10/10:
- Per-message stored authentication evidence: SPF aligned, DKIM aligned, DMARC pass.
- DMARC aggregate report ingestion and parsing.
- Policy progression workflow: `p=none` -> `quarantine` -> `reject`.
- DKIM key length and rotation compliance proof.
- PTR/forward DNS/TLS checks per sending IP/pool.

10/10 acceptance:
- Every verified sending domain has DNS state, last check time, and failing-record explanation.
- DMARC aggregate reports are ingested and visible by provider/domain/day.
- New domains cannot graduate to high-volume pools until alignment, complaint, and bounce gates are satisfied.

### 20.4.2 Tenant Isolation And Data Boundary

Current score: 5.5/10

#### 20.4.2.1 RLS Policy Design

Local evidence:
- `infra/migrations/023_rls.sql` enables RLS on important tenant tables.
- Policies include `customer_id = current_tenant_id() OR current_tenant_id() IS NULL`.
- `packages/tests/rls-isolation.test.ts` explicitly documents that policies allow all rows when tenant context is null.
- PostgreSQL documentation confirms superusers and BYPASSRLS roles bypass row security.

Missing for 10/10:
- Remove the `OR current_tenant_id() IS NULL` production escape hatch or isolate it behind explicit service-role policies.
- Add `FORCE ROW LEVEL SECURITY` where applicable.
- Run API as a non-owner, non-superuser, non-BYPASSRLS role.
- Add startup check that production DB role is not superuser and does not have BYPASSRLS.
- Add a migration test that asserts every tenant table has RLS enabled and no permissive null-tenant policy.

10/10 acceptance:
- A route-level bug that omits `customer_id` filters still cannot read or write another tenant's rows.
- Production startup fails if the database role can bypass RLS.
- CI fails if a new tenant table lacks RLS policy coverage.

#### 20.4.2.2 API Integration

Local evidence:
- `packages/shared/src/tenant-context.ts` exposes `withTenant(customerId, fn)`.
- No production route usage of `withTenant()` was found.
- Routes still use direct global `db` imports and explicit `.where('customer_id', '=', req.auth!.customer_id)` filters.

Missing for 10/10:
- Introduce a request-scoped tenant executor.
- Refactor shared service functions to accept `DbExecutor` instead of importing global `db`.
- Wrap all API-key customer routes and session-org routes in tenant context.
- Mark public, admin, and worker service-role paths as explicit exceptions with tests.
- Add route metadata: auth type, tenant scope, capability, mutation, audit required.

10/10 acceptance:
- Static route inventory shows every route has tenant policy metadata.
- Unit test fails when a new route has no tenant metadata.
- E2E cross-tenant test passes even with a deliberately missing application-level filter.

### 20.4.3 API Security And Abuse

Current score: 7.0/10

#### 20.4.3.1 OWASP API1 Broken Object Level Authorization

Local evidence:
- Many routes explicitly filter by `customer_id`.
- Some cross-org tests exist, for example account webhooks and webhook rotation tests.

Missing for 10/10:
- Central object-authorization helper for every route taking `:id`.
- Static inventory of all ID-bearing endpoints.
- Negative tests for every endpoint that accepts `:id`, `message_id`, `domain`, `webhook_id`, `template_id`, suppression group ID, support ticket ID, and admin-owned resource ID.

10/10 acceptance:
- CI fails if a new path parameter lacks an authorization test.

#### 20.4.3.2 OWASP API4 Resource Consumption

Local evidence:
- Quota and BullMQ backpressure exist.
- Rate limits exist in several areas.

Missing for 10/10:
- Per-route cost model: send, batch send, template render, webhook replay, export, analytics query, support AI, signup, login, verification resend.
- Max request body and attachment/body-size enforcement at gateway and app.
- Queue age SLO and per-tenant queue saturation limiter.
- Billing cost guard for paid third-party calls.

10/10 acceptance:
- Load test proves abusive tenants cannot starve normal tenants.
- Every externally callable expensive route has rate, concurrency, size, and cost controls.

#### 20.4.3.3 OWASP API7 SSRF

Local evidence:
- `packages/shared/src/ssrf.ts` rejects private/loopback/local targets.
- Webhook worker has DNS pinning tests.
- Account webhook E2E rejects private-address URL.

Missing for 10/10:
- Egress proxy or network allowlist for webhook delivery.
- Runtime audit of resolved IP, connected IP, URL host, and redirect target.
- Production NetworkPolicy/eBPF egress controls that still allow legitimate customer webhooks.

10/10 acceptance:
- DNS rebinding, redirect-to-private, IPv6 private, localhost alias, metadata IP, and credentialed URL tests all pass.
- Network layer blocks metadata/private targets even if app guard regresses.

#### 20.4.3.4 OWASP API8/API9 Misconfiguration And Inventory

Local evidence:
- OpenAPI generation/tests exist.
- Config guard checks core secrets and active billing webhook secret.

Missing for 10/10:
- Production config guard must validate storage, transport, tracking domain HTTPS, ClickHouse, KMS provider, OTel endpoint, admin OIDC, DB role, and billing no-mock.
- Public API inventory must include owner, auth type, deprecation policy, rate limit, tenant scope, and data classification.

10/10 acceptance:
- Production boot fails on insecure or incomplete config for any enabled subsystem.
- CI publishes route inventory diff for review.

### 20.4.4 Billing And Revenue

Current score: 6.5/10

#### 20.4.4.1 Provider Webhook Security

Local evidence:
- `packages/api/src/routes/billing.ts` verifies Stripe, PayPal, and Cashfree signatures.
- `packages/tests/e2e/billing-multiprovider.e2e.test.ts` accepts valid signatures and rejects invalid signatures.
- `packages/shared/src/config-guard.ts` conditionally requires webhook secrets for active live providers.

Correction:
- The earlier report should not imply basic webhook signature verification is missing. It exists and has tests.

Still missing for 10/10:
- Live sandbox tests against official provider tooling.
- Replay protection and event idempotency table per provider event ID.
- Event replay/admin repair workflow.
- Billing event retention policy and forensic audit export.
- Production fail-closed rule that disallows mock fallback when `NODE_ENV=production`.

10/10 acceptance:
- Stripe CLI/sandbox, PayPal sandbox, and Cashfree sandbox tests are part of release certification.
- Duplicate provider event IDs are ignored idempotently.
- Invalid signatures are rejected in production and staging.

#### 20.4.4.2 Plans, Pricing, Dunning, And Reconciliation

Local evidence:
- `packages/shared/src/billing.ts` still has placeholder price IDs such as `price_free`, `price_starter`, `price_pro`, `price_enterprise`.
- PayPal/Cashfree usage reporting is intentionally no-op.
- Billing reconciliation endpoint/tests exist, but launch-grade revenue operations are incomplete.

Missing for 10/10:
- Real plan catalog table seeded per environment.
- Provider price/product mapping by environment.
- Dunning workflow: failed payment, grace period, quota downgrade, notification, recovery.
- Metering ledger with immutable daily snapshots.
- Monthly reconciliation job comparing internal usage, provider usage, invoices, credits, refunds, and overrides.
- Finance export for MRR, ARR, churn, failed payments, open invoices, tax IDs, and enterprise contracts.

10/10 acceptance:
- A paid customer can upgrade, downgrade, cancel, fail payment, recover, and receive correct quota changes in sandbox without manual DB edits.
- Reconciliation drift creates an auditable repair task.

### 20.4.5 Infrastructure And Runtime

Current score: 6.5/10

#### 20.4.5.1 Kubernetes Probes

Local evidence:
- Helm API has `/live` liveness and `/ready` readiness.
- Helm worker uses `/health` for liveness/readiness.
- Helm tracker uses `/live` for liveness/readiness.

Correction:
- The platform does have Helm probes. The issue is not "no probes"; the issue is probe depth.

Missing for 10/10:
- Startup probes for slow boot/migration/connection warmup.
- Worker readiness should include Redis connection, queue worker state, DB connection, and paused/draining state.
- Tracker readiness should use `/ready` and include DB/Redis/events queue readiness, not only `/live`.
- Probe tests in Helm chart CI.

10/10 acceptance:
- A pod with broken DB/Redis is live only when process is alive, but not ready for traffic.
- Worker pods are removed from readiness when queue processing is paused or Redis is unavailable.

#### 20.4.5.2 Kubernetes Security Context

Local evidence:
- Helm deployments define resources and probes.
- `rg` found no `securityContext`, `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation`, `capabilities`, or `seccompProfile` in Helm deployment templates.
- NetworkPolicy templates exist and include default-deny style rules.

Missing for 10/10:
- Pod-level `runAsNonRoot: true`.
- Explicit `runAsUser` and `runAsGroup` matching image user.
- `allowPrivilegeEscalation: false`.
- `readOnlyRootFilesystem: true` with explicit writable mounts for temp/cache.
- `capabilities.drop: ["ALL"]`.
- `seccompProfile.type: RuntimeDefault`.
- Pod Security Admission labels at `restricted` level for namespace.
- Chart test with `kubectl apply --dry-run=server` and policy scanner.

10/10 acceptance:
- Helm release passes Kubernetes restricted Pod Security admission.
- Security scanner reports no privileged workload, hostPath, host network, privilege escalation, or missing seccomp.

#### 20.4.5.3 Docker/Compose Runtime

Local evidence:
- Runtime containers run as `node`.
- Docker inspect showed no restart policy and no Docker healthcheck for API/worker/tracker.
- API/worker/tracker Dockerfiles run migrations inside app container command, while Helm also has a migration job.

Missing for 10/10:
- Remove startup migrations from app container CMD; use one migration job per deploy.
- Add Compose healthchecks.
- Add restart policies for production Compose.
- Use deterministic install path: `npm ci --omit=dev` for production stage where feasible.
- Add SBOM and image vulnerability scan gate.
- Pin base image digest or documented LTS update cadence.

10/10 acceptance:
- App container restart does not rerun migrations.
- Compose `docker compose ps` shows healthy services.
- Image scan has no high/critical vulnerabilities, or signed risk acceptance exists.

### 20.4.6 Storage, Privacy, And Retention

Current score: 7.0/10

#### 20.4.6.1 Body Storage

Local evidence:
- `packages/shared/src/storage.ts` supports inline, filesystem, and S3-compatible storage.
- Body offload E2E tests exist.

Missing for 10/10:
- MinIO CI test for S3 put/get/delete, large body, missing object, permission denied, and retry behavior.
- IAM policy with least privilege: only required object actions and only bucket/prefix used by the platform.
- Server-side encryption requirement.
- Object lifecycle rule by retention class.
- Cross-region replication or backup if compliance tier requires it.
- Erasure propagation test from privacy API to object storage.

10/10 acceptance:
- Deleting recipient/message data removes or tombstones related body objects according to retention/legal-hold policy.
- S3 credentials cannot list or mutate outside configured prefix.

#### 20.4.6.2 Privacy And Legal Hold

Local evidence:
- Privacy API exists.
- Retention module exists.

Missing for 10/10:
- Data inventory by table, object store, ClickHouse, logs, metrics, traces, backups.
- Legal hold state that blocks destructive erasure while preserving auditability.
- DSAR export workflow.
- Backup erasure/tombstone policy.
- Regional residency controls.

10/10 acceptance:
- A recipient deletion request produces a machine-readable proof of affected systems and exceptions.
- Legal hold prevents deletion and creates auditable reason records.

### 20.4.7 Observability, Dependency Security, And SRE

Current score: 6.5/10

#### 20.4.7.1 Metrics And Alerting

Local evidence:
- API/tracker metrics endpoints returned 401 without token.
- `packages/shared/src/metrics.ts` protects metrics when `METRICS_TOKEN` is configured and fails closed in production.
- Grafana/Prometheus assets exist.

Missing for 10/10:
- SLOs for API latency, send enqueue latency, delivery latency, queue age, webhook latency, tracker latency, error budget burn, provider error rates, and DB pool saturation.
- Alert tests/fire drills.
- Customer-facing status and incident timeline.

10/10 acceptance:
- Every top user journey has SLI, SLO, alert, dashboard, and runbook.
- Alert rules are tested with synthetic metric injection.

#### 20.4.7.2 Tracing And Dependency Advisory

Local evidence:
- OpenTelemetry packages are present.
- Advisory GHSA-8988-4f7v-96qf applies to `@opentelemetry/core` below 2.8.0.
- Local audit previously showed 27 moderate advisories and no high/critical advisories.

Missing for 10/10:
- Upgrade OpenTelemetry package set so `@opentelemetry/core` is 2.8.0 or later.
- Add inbound header size/proxy guard for `baggage` and trace headers.
- Add dependency update cadence and security exception register.
- Audit must pass at moderate level or have signed, time-bound acceptances.

10/10 acceptance:
- `npm audit --omit=dev --audit-level=moderate` passes, or every remaining advisory is documented with owner, expiration, exploitability, and mitigation.

### 20.4.8 Identity, Admin, And Enterprise Controls

Current score: 7.0/10

#### 20.4.8.1 Human Sessions And MFA

Local evidence:
- MFA/TOTP modules and tests exist.
- Admin password login is forced off in production when config guard runs.
- OIDC settings are required in production.

Missing for 10/10:
- Phishing-resistant MFA option for admin and enterprise customers.
- Session timeout policy mapped to tenant risk tier.
- Device/session inventory and revocation UI.
- Step-up auth for sensitive actions: API key reveal/rotation, billing override, quota change, SSO changes, support impersonation.

10/10 acceptance:
- Enterprise tenant can enforce SSO, MFA, session timeout, and SCIM deprovisioning.
- Sensitive admin actions require step-up and produce immutable audit events.

#### 20.4.8.2 Admin And Support Operations

Local evidence:
- Admin routes, support tickets, AI triage, audit logging, and DLQ controls exist.

Missing for 10/10:
- Split large admin route surface into capability-specific modules.
- Two-person approval for quota overrides, account suspension reversal, billing overrides, domain reputation reset, and data export.
- JIT admin access and break-glass workflow.
- Tamper-evident audit hash chain or external WORM sink.
- Support access minimization and redaction.

10/10 acceptance:
- Admin cannot perform high-risk action without approval unless break-glass is used.
- Break-glass expires automatically and is externally alerted.

### 20.4.9 Testing And Release Certification

Current score: 6.5/10

Local evidence:
- Full suite was mostly passing after test env setup, but initial `npm test` failed without env.
- `.env.test` comments and `DATABASE_URL` port are inconsistent.
- `rls-isolation.test.ts` can fail due to cleanup order, then pass after manual cleanup.

Missing for 10/10:
- Test harness automatically loads `.env.test`.
- Test DB port/comment mismatch fixed.
- RLS role cleanup made idempotent.
- Release certification script: build, lint/typecheck, unit, e2e, migration up/down, RLS, security, dependency audit, Helm template, Docker build, smoke tests.
- Staging load test before production release.

10/10 acceptance:
- A clean clone can run documented test commands without manual DB role cleanup or manual env export.
- Release cannot proceed unless certification passes.

## 20.5 New 10/10 Production Evidence Gates

Use these gates before any future claim that the platform is "production grade", "SaaS grade", or "enterprise grade".

| Gate | Required evidence |
| --- | --- |
| Isolation gate | RLS enforced with non-BYPASSRLS role, route tenant metadata, cross-tenant negative tests for every ID route. |
| Email compliance gate | Gmail/Yahoo/Microsoft requirements checklist, DMARC alignment, RFC 8058 one-click HTTPS headers, visible body unsubscribe, provider complaint dashboards. |
| Billing gate | Real price IDs, sandbox/live provider tests, signed webhooks, idempotent event ledger, dunning, reconciliation, no mock fallback in production. |
| Runtime gate | Helm restricted security context, probes, resource requests/limits, NetworkPolicy tested with enforcing CNI, migration job only. |
| Storage/privacy gate | S3 least-privilege IAM, encryption, lifecycle, MinIO CI, erasure propagation, backup/legal-hold policy. |
| SRE gate | SLOs, burn-rate alerts, dashboards, runbooks, restore drill, failover drill, load test, alert fire drill. |
| Security gate | Moderate audit clean or accepted, pentest, OWASP API coverage, dependency update cadence, SBOM, image scan. |
| Enterprise gate | SSO/SAML/OIDC for tenants, SCIM, phishing-resistant admin MFA option, JIT admin, immutable audit, data residency/legal hold. |

## 20.6 Immediate Corrections To Work Plan

Replace the earlier priority order with this sharper order:

1. Fix tenant isolation first: API `withTenant()` integration, remove/null-tenant RLS escape hatch for app roles, DB role startup guard, route metadata.
2. Fix test harness second: `.env.test` loading, DB port mismatch, RLS cleanup idempotency, release certification command.
3. Fix production config guard third: HTTPS tracking domain, active storage provider, active delivery transport, KMS, ClickHouse, OTel, DB role, no mock billing in production.
4. Fix deliverability compliance fourth: RFC 8058 HTTPS proof, visible body unsubscribe, Gmail 0.10% operating target, Yahoo 0.3% hard threshold, DMARC/Postmaster/SNDS ingestion.
5. Fix runtime hardening fifth: Helm securityContext, startup probes, worker/tracker readiness, remove app startup migrations, Compose health/restart policies.
6. Fix billing launch sixth: real plan catalog, provider sandbox tests, idempotent billing event ledger, dunning, reconciliation.
7. Fix S3/privacy seventh: MinIO CI, IAM, encryption, lifecycle, erasure/legal-hold data inventory.
8. Fix enterprise controls eighth: SSO/SCIM, phishing-resistant admin MFA option, JIT/break-glass, immutable audit.

## 20.7 Final Validated Answer

No, this mail platform is not 10/10 production-grade, SaaS-grade, or enterprise-grade yet.

Honest validated score after deeper review:

| Dimension | Score |
| --- | ---: |
| Local developer completeness | 8.0/10 |
| MVP/self-hosted production readiness | 7.0/10 |
| SaaS multi-tenant production readiness | 6.5/10 |
| Enterprise readiness | 5.5/10 |
| Regulated/compliance-heavy enterprise readiness | 4.5/10 |

The codebase is stronger than a prototype: it has real modules for API, worker, tracker, Haraka, billing, webhooks, RLS primitives, storage, metrics, tests, Helm, and docs. The reason it is not 10/10 is proof and enforcement. Enterprise-grade systems do not rely on "most routes remembered to filter customer_id", placeholder billing prices, unproven provider deliverability, optional object-store hardening, shallow readiness, or manual test environment repair.

The shortest path to 10/10 is not adding more features first. It is enforcing the isolation/security/runtime/compliance gates above and proving them with automated tests, staging drills, and production evidence.

---

# 21. Second-Pass Deep Validation Corrections

Validation date: 2026-06-25  
Reason: user requested another deeper validation pass with agent-style parallel review. Sub-agent execution was attempted, but all spawned agents failed due usage-limit errors, so this section records direct manual validation against local code and additional official sources.

## 21.1 Additional Sources Checked

| Area | Source | Validation result |
| --- | --- | --- |
| PayPal webhook verification | https://developer.paypal.com/docs/api/webhooks/v1/ | PayPal verification is not a simple shared-secret HMAC. The official API expects transmission ID/time/signature, certificate URL, auth algorithm, webhook ID, and event payload. |
| Cashfree webhook signature | https://www.cashfree.com/docs/payments/online/webhooks/signature-verification | Cashfree signs the raw payload with timestamp and `x-webhook-signature`. Official examples use a millisecond timestamp shape. |
| Microsoft Outlook high-volume sender requirements | https://techcommunity.microsoft.com/blog/microsoftdefenderforoffice365blog/strengthening-email-ecosystem-outlook%E2%80%99s-new-requirements-for-high%E2%80%90volume-senders/4399730 | High-volume senders must satisfy SPF, DKIM, and DMARC expectations for Outlook/Hotmail/Live. |
| FTC CAN-SPAM guide | https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business | Commercial email must include a valid physical postal address and clear opt-out mechanism. |
| Cashfree webhook overview | https://www.cashfree.com/docs/payments/online/webhooks/overview | Confirms raw-body signature verification and `x-webhook-timestamp` / `x-webhook-signature` headers. |

## 21.2 New Corrections To Previous Scores

| Module/submodule | Previous score in this report | Corrected score | Why |
| --- | ---: | ---: | --- |
| Billing webhook security - Stripe | 8.0 | 8.0 | Local HMAC verification matches Stripe's public webhook model and tests cover valid/invalid signatures. Remaining gap is provider sandbox/live proof and replay operations. |
| Billing webhook security - PayPal | 8.0 | 5.5 | Code uses custom HMAC over `transmissionId.transmissionTime.payload`; official PayPal verification uses certificate/API verification with webhook ID, cert URL, auth algorithm, and PayPal transmission signature. Local docs also admit live PayPal verification is a deploy-time check, not implemented. |
| Billing webhook security - Cashfree | 8.0 | 6.5 | HMAC raw-body pattern is directionally correct, but code treats `x-webhook-timestamp` as seconds and multiplies by 1000; Cashfree examples show millisecond timestamps. Live Cashfree webhooks may reject incorrectly until this is verified/fixed. |
| CAN-SPAM body footer support | 7.5-8.0 | 8.5 | Earlier wording understated current implementation. Worker appends physical address and unsubscribe link to HTML/text bodies and rejects live sends without `physical_address` unless `SKIP_PHYSICAL_ADDRESS_CHECK=true`. Remaining gap is policy classification and production proof. |
| Load-test assets | 6.5 | 7.0 | `infra/loadtest/send.js` exists with k6 SLO thresholds. The gap is not absence of a k6 script; it is absence of staging/cluster run artifacts and capacity evidence. |
| Deliverability complaint thresholds | 5.5 | 5.5 | Score stays low, but reason is more precise: code pauses at `0.003` by default, but docs/comments still describe Gmail/Yahoo as a shared 0.3% threshold. Gmail operating target should be 0.10% with warning below that. |
| Outlook/Microsoft sender compliance | not separately scored | 5.5 | Report covered Google/Yahoo more deeply than Outlook. Microsoft high-volume sender requirements need explicit SPF/DKIM/DMARC compliance gate and SNDS/JMRP proof. |

## 21.3 Billing Deep Dive: Provider By Provider

### 21.3.1 Stripe Billing Webhooks

Local evidence:
- `packages/api/src/routes/billing.ts` parses raw JSON and verifies `Stripe-Signature`.
- Timestamp tolerance is 300 seconds.
- Signature is computed as `HMAC_SHA256(secret, timestamp.payload)`.
- `packages/tests/e2e/billing-multiprovider.e2e.test.ts` covers valid and invalid Stripe signatures.
- `packages/shared/src/config-guard.ts` requires `STRIPE_WEBHOOK_SECRET` when Stripe is live configured.

Current score: 8.0/10

Missing for 10/10:
- Stripe CLI integration test in CI/staging.
- Event replay protection validated against real Stripe event IDs.
- Webhook endpoint secret rotation runbook.
- Billing events dashboard with ignored/duplicate/applied counts.
- Signed production proof: checkout -> webhook -> quota update -> invoice/metered usage.

10/10 solution:
- Add `scripts/verify-stripe-webhook-flow.mjs` that uses Stripe CLI or sandbox API to send `customer.subscription.created`, `updated`, and `deleted`.
- Persist verification artifacts under `docs/release-evidence/billing/`.
- Add alert if webhook invalid signature rate or duplicate event rate spikes.

### 21.3.2 PayPal Billing Webhooks

Local evidence:
- `packages/api/src/routes/billing.ts` implements `verifyPayPalSignature()` using `HMAC_SHA256(PAYPAL_WEBHOOK_SECRET, transmissionId.transmissionTime.payload)`.
- Only `paypal-transmission-id`, `paypal-transmission-time`, and `paypal-transmission-sig` are used.
- There is no usage of `PAYPAL-CERT-URL`, `PAYPAL-AUTH-ALGO`, or PayPal webhook ID in code.
- `docs/BILLING.md` says live PayPal certificate/API verification remains a credentialed deploy-time check.

Why this is not 10/10:
- PayPal's official verification model is asymmetric/certificate or PayPal API based, not the custom local HMAC model used here.
- A local test passing with fake HMAC headers proves only the platform's custom test protocol, not compatibility with real PayPal webhooks.
- In production, this can either reject legitimate PayPal webhooks or create a false sense of security depending on how secrets are configured.

Current score: 5.5/10

Missing for 10/10:
- Store `PAYPAL_WEBHOOK_ID`.
- Verify all required PayPal headers:
  - `PAYPAL-TRANSMISSION-ID`
  - `PAYPAL-TRANSMISSION-TIME`
  - `PAYPAL-TRANSMISSION-SIG`
  - `PAYPAL-CERT-URL`
  - `PAYPAL-AUTH-ALGO`
- Either call PayPal's verify-webhook-signature endpoint or implement certificate validation with pinning/allowlist for PayPal cert URLs.
- Cache PayPal certificates safely with expiry.
- Add sandbox webhook test using real PayPal sandbox event delivery.
- Reject unsupported auth algorithms.
- Log verification failure reason without logging payload secrets.

10/10 solution:
- Replace `verifyPayPalSignature()` with `verifyPayPalWebhookOfficial()`:
  1. Read raw body.
  2. Read all PayPal transmission headers.
  3. Validate timestamp tolerance.
  4. Validate `PAYPAL-CERT-URL` host/path against PayPal allowlist.
  5. Use PayPal API verification with `webhook_id`, transmission headers, and `webhook_event`.
  6. Cache positive verification result by `transmission_id` and event ID for replay prevention.
- Keep the current HMAC verifier only as a local-test helper behind `NODE_ENV !== 'production'`.

### 21.3.3 Cashfree Billing Webhooks

Local evidence:
- `packages/api/src/routes/billing.ts` implements `verifyCashfreeSignature()`.
- It computes `HMAC_SHA256(secret, timestamp + payload)` and compares base64 signature.
- It reads `x-webhook-timestamp` and `x-webhook-signature`.
- It uses raw body.
- But it computes `const tsMs = Number(input.timestamp) * 1000`.

Why this is not 10/10:
- Cashfree docs show timestamp examples in millisecond form, and the overview describes `x-webhook-timestamp` as the timestamp used directly in the signed payload.
- Multiplying a millisecond timestamp by 1000 will make valid live events appear far in the future and fail the 5-minute freshness check.
- Tests currently generate second timestamps, so they can pass while live Cashfree traffic fails.

Current score: 6.5/10

Missing for 10/10:
- Confirm exact Cashfree timestamp unit in the currently used API version.
- Support millisecond timestamp parsing, and keep signed payload exactly as received.
- Add tests for both official example shape and stale timestamp rejection.
- Add sandbox webhook delivery test.

10/10 solution:
- Change freshness parsing to accept milliseconds when timestamp length is 13 and seconds when length is 10.
- Do not normalize the timestamp before building the signed payload; sign `rawTimestamp + rawPayload`.
- Add `cashfree-official-sample.test.ts` with a fixture copied from Cashfree docs/sandbox.
- Add config guard for `CASHFREE_PLAN_MAP_JSON` when `BILLING_PROVIDER=cashfree`.

## 21.4 CAN-SPAM And Unsubscribe Re-Validation

### 21.4.1 Physical Address Enforcement

Local evidence:
- `packages/worker/src/send-worker.ts` fetches `customers.physical_address` per message.
- If missing and not test mode, worker throws permanent `physical_address_required` unless `SKIP_PHYSICAL_ADDRESS_CHECK=true`.
- If present, worker appends address to HTML and/or text body.
- Docs explicitly say CAN-SPAM physical postal address is enforced at send time.

Correction:
- Earlier sections that imply physical-address body footer is merely planned are too pessimistic.
- The implementation is materially present.

Current score: 8.5/10

Still missing for 10/10:
- `SKIP_PHYSICAL_ADDRESS_CHECK` must be forbidden in production config guard.
- Physical address should be validated beyond string length: postal deliverability, country-specific format, and abuse review for fake addresses.
- Commercial/transactional classification is absent. The platform treats all live sends as needing a physical address, which is safer legally but less precise.
- No evidence artifact showing real outbound MIME contains footer after DKIM signing/HTML transform.

10/10 solution:
- Add config guard: production fails if `SKIP_PHYSICAL_ADDRESS_CHECK=true`.
- Add address validation service or admin review workflow.
- Add `message_classification: transactional | commercial | mixed` and policy gates.
- Add MIME snapshot tests proving physical address and unsubscribe survive final send serialization.

### 21.4.2 Body Unsubscribe Link

Local evidence:
- Worker appends `<a href="${unsubUrl}">Unsubscribe</a>` to HTML when HTML exists.
- Worker appends `Unsubscribe: ${unsubUrl}` to text when text exists.
- List-Unsubscribe headers are always added in worker send headers.

Correction:
- The report's earlier "visible body unsubscribe missing" wording should be interpreted as "missing production proof/policy controls", not missing basic implementation.

Current score: 8.0/10

Still missing for 10/10:
- Production config guard must enforce `TRACKING_DOMAIN` is HTTPS.
- Unsubscribe URL should use customer-branded tracking domain where possible.
- Gmail/Yahoo/Microsoft compliance tests should inspect final MIME.
- The platform should distinguish marketing/commercial mail from pure transactional mail.
- There should be monitoring for unsubscribe processing latency and failures.

10/10 solution:
- Add a final MIME compliance test that sends through sandbox transport and asserts:
  - HTTPS body unsubscribe exists.
  - HTTPS `List-Unsubscribe` URL exists.
  - `List-Unsubscribe-Post: List-Unsubscribe=One-Click` exists.
  - Physical postal address exists.
  - DKIM signed headers include unsubscribe headers when using Haraka path.
- Add Prometheus metric `mp_unsubscribe_effective_latency_seconds`.

## 21.5 Deliverability Deep Corrections

### 21.5.1 Complaint Thresholds

Local evidence:
- `packages/shared/src/reputation.ts` uses `COMPLAINT_PAUSE_THRESHOLD` default `0.003` (0.3%).
- Docs mention complaint rate below 0.1% in `docs/guides/deliverability.md`.
- Prometheus alert summary says "Complaint rate above 0.3% (Gmail/Yahoo threshold)".

Issue:
- The implementation pauses at 0.3%, but Gmail operational guidance should be stricter. A 10/10 platform should not wait until 0.3% to act for Gmail-heavy traffic.

Current score: 5.5/10

10/10 solution:
- Add separate thresholds:
  - `COMPLAINT_WARN_THRESHOLD=0.0008`
  - `GMAIL_COMPLAINT_THROTTLE_THRESHOLD=0.001`
  - `GLOBAL_COMPLAINT_PAUSE_THRESHOLD=0.003`
- Split complaint metrics by receiver domain/ISP, not only by pool.
- Trigger progressive actions:
  - warn at 0.08%
  - throttle Gmail/Yahoo/Outlook sends at 0.10%
  - pause pool/campaign/customer at 0.30%
- Update alert wording to avoid calling 0.3% the Gmail target.

### 21.5.2 Microsoft/Outlook Compliance

Local evidence:
- SNDS ingestion support exists in `packages/shared/src/reputation.ts`.
- Docs mention Microsoft SNDS/JMRP registration.
- The main report focuses more on Gmail/Yahoo than Outlook.

Current score: 5.5/10

Missing for 10/10:
- Explicit Outlook high-volume sender checklist.
- SPF/DKIM/DMARC alignment status per Outlook-bound stream.
- SNDS/JMRP credential proof and ingestion dashboard.
- Outlook-specific block/deferral classification.
- Alerting for Microsoft rejection code patterns.

10/10 solution:
- Add `docs/runbooks/OUTLOOK_SENDER_REQUIREMENTS.md`.
- Add provider-domain breakdown for authentication failures and complaint rates.
- Add event classifier for Outlook/Hotmail/Live SMTP responses.
- Add release gate requiring SPF, DKIM, and DMARC pass/alignment before scaling Outlook traffic.

## 21.6 Load And Performance Validation Correction

Local evidence:
- `infra/loadtest/send.js` exists.
- It has k6 thresholds: p99 under 500ms, p95 under 250ms, accepted check rate over 99%, failed request rate under 1%.
- `LOAD_TEST_FINDINGS.md` documents local in-process load findings and explicitly says cluster-scale k6 proof is still required.

Correction:
- The platform has load-test assets. The missing item is production-like evidence, not test script existence.

Current score: 7.0/10

Missing for 10/10:
- k6 run against staging Kubernetes.
- Multiple API replicas.
- Real Postgres and Redis topology.
- Worker drain-rate measurement.
- Queue-age SLO under sustained RPS.
- Tracker open/click/unsubscribe load test.
- Webhook delivery load test with retry/backoff behavior.
- Published capacity envelope per plan/tier.

10/10 solution:
- Add release evidence folder:
  - `docs/release-evidence/load/YYYY-MM-DD/send-k6-summary.json`
  - `docs/release-evidence/load/YYYY-MM-DD/grafana-screenshots/`
  - `docs/release-evidence/load/YYYY-MM-DD/capacity-report.md`
- Add `npm run load:staging` wrapper.
- Require load evidence before increasing public quotas.

## 21.7 Config Guard Missing Production Checks

Local evidence:
- `packages/shared/src/config-guard.ts` checks core secrets, admin OIDC, and active billing webhook secret.
- It does not validate `TRACKING_DOMAIN`, `SKIP_PHYSICAL_ADDRESS_CHECK`, active delivery transport details, active storage details, PayPal webhook official config, Cashfree timestamp/API version behavior, OTel endpoint, ClickHouse, or DB RLS role.

Current score: 7.0/10

Missing for 10/10:
- Production fails if `TRACKING_DOMAIN` is not HTTPS.
- Production fails if `SKIP_PHYSICAL_ADDRESS_CHECK=true`.
- Production fails if `BILLING_PROVIDER=mock`.
- Production fails if `BILLING_PROVIDER=paypal` without `PAYPAL_WEBHOOK_ID` and official verifier mode.
- Production fails if `BILLING_PROVIDER=cashfree` without plan map and verified timestamp mode.
- Production fails if `BODY_STORAGE=s3` without bucket/prefix/region/credentials or IAM role mode.
- Production fails if `DELIVERY_TRANSPORT=ses` without SES region/from identity config.
- Production fails if RLS role can bypass RLS.
- Production warns/fails if `OTEL_EXPORTER_OTLP_ENDPOINT` is absent based on deployment tier.

10/10 solution:
- Split config guard into subsystem validators:
  - `validateSecurityConfig`
  - `validateBillingConfig`
  - `validateMailTransportConfig`
  - `validateTrackingConfig`
  - `validateStorageConfig`
  - `validateObservabilityConfig`
  - `validateDatabaseIsolationConfig`
- Add tests for each enabled provider and each production failure mode.

## 21.8 Updated Highest-Risk Priority After Second Pass

1. Tenant isolation/RLS integration remains the top SaaS blocker.
2. PayPal webhook verification is not production-grade; replace custom HMAC with official verification.
3. Cashfree timestamp verification likely mismatches official millisecond timestamp examples; fix before live use.
4. Production config guard must block unsafe flags and incomplete provider config.
5. Deliverability thresholds need ISP-specific actions: Gmail target below 0.10%, hard pause at/near 0.30%.
6. Outlook/Microsoft compliance needs explicit gate, not just SNDS ingestion hooks.
7. Load testing needs staging artifacts and capacity report, not only scripts.
8. CAN-SPAM footer implementation is stronger than previously stated, but needs final MIME proof and production bypass prevention.

## 21.9 Final Second-Pass Verdict

The markdown is valid in its main conclusion, but some module-level judgments needed correction:

- Billing webhooks should be split by provider. Stripe is relatively strong, PayPal is not live-grade, Cashfree needs timestamp correction.
- CAN-SPAM body footer support is implemented and should score higher than generic compliance wording suggested.
- Load testing assets exist; the gap is production-like evidence.
- Deliverability needs Gmail/Yahoo/Microsoft split thresholds and compliance gates.
- Config guard is still too shallow for production/enterprise launch.

Updated honest readiness after this pass:

| Dimension | Score |
| --- | ---: |
| Local developer completeness | 8.1/10 |
| MVP/self-hosted production readiness | 7.0/10 |
| SaaS multi-tenant production readiness | 6.4/10 |
| Billing launch readiness | 5.8/10 |
| Deliverability launch readiness | 5.5/10 |
| Enterprise readiness | 5.5/10 |

This does not change the overall answer: the platform is not 10/10 yet. It does make the path more exact: fix RLS enforcement, provider-real billing verification, production config guard, ISP-specific deliverability controls, and staging evidence before calling it production-grade.

---

# 22. Third-Pass Agent-Assisted Validation

Validation date: 2026-06-25  
Method: spawned two focused validation agents and ran additional manual/external checks. The agents did not edit files. Their results were used to correct scores and add deeper submodule findings.

## 22.1 Additional External Sources Checked

| Area | Source | Why it changes this report |
| --- | --- | --- |
| GDPR data subject rights | https://www.edpb.europa.eu/sme-data-protection-guide/respect-individuals-rights_en | Confirms access, erasure, restriction, portability, objection, and automated-decision rights are broader than the current export/delete endpoint. |
| GDPR Article 15 | https://gdpr-info.eu/art-15-gdpr/ | Right of access requires more complete information than the current limited message/event export. |
| GDPR Article 17 | https://gdpr-info.eu/art-17-gdpr/ | Erasure must be handled without undue delay, but with explicit exceptions/legal bases. Current delete flow lacks per-store finality and legal-hold modeling. |
| AWS Well-Architected DR objectives | https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/disaster-recovery-dr-objectives.html | Confirms production DR needs explicit RTO/RPO objectives and restore proof, not just backups. |
| AWS Well-Architected DR planning | https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/plan-for-disaster-recovery-dr.html | Confirms backup/redundancy are only the start; restore strategy and objectives must be implemented and tested. |
| ClickHouse production readiness | https://clickhouse.com/docs/cloud/guides/production-readiness | Confirms ClickHouse production posture needs lifecycle automation, backup operations, monitoring, and operational controls. |
| ClickHouse backup/restore docs | https://clickhouse.com/docs/operations/backup/overview | Confirms backup/restore must be designed explicitly for ClickHouse analytics data. |
| AICPA Trust Services Criteria | https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022 | Confirms enterprise/SOC2 readiness needs evidence over security, availability, processing integrity, confidentiality, and privacy controls. |

## 22.2 Agent Findings Integrated

| Agent focus | Result |
| --- | --- |
| Storage/privacy/analytics | Completed. Confirmed export/delete are more incomplete than prior report stated; ClickHouse has no erasure path; DLQ/logs can retain PII; retention docs conflict with code. |
| Identity/admin/security/audit | Completed. Confirmed RLS should score lower; customer SSO/SCIM is effectively absent; admin OIDC is stronger than earlier wording; admin MFA posture is weaker for OIDC; audit is not durable/tamper-evident. |

## 22.3 Third-Pass Corrected Scores

| Module/submodule | Previous score | Third-pass score | Reason |
| --- | ---: | ---: | --- |
| Tenant isolation/RLS integration | 5.5-6.0 | 4.5 | RLS is fail-open when tenant context is absent because policies allow `current_tenant_id() IS NULL`, and production routes still do not use `withTenant()`. |
| Privacy export recipient | 8.0 | 5.5 | Export returns limited message/event/suppression fields, not full data subject access data. It omits bodies, headers, metadata, tags, tracked links, unsubscribe group state, deletion log, and object-store payloads. |
| Privacy delete recipient | 8.0 | 5.8 | Deletes core Postgres rows and some body objects, but does not propagate erasure to ClickHouse, queues/DLQ, logs/traces, backups, or legal-hold workflows. It records completed before object deletion and body deletion failures are only logged. |
| Body object erasure | 8.0 | 7.0 | Object erasure exists and tests cover orphaned bodies, but it is best-effort and has no durable retry queue or per-store status. |
| ClickHouse analytics reliability/privacy | 6.5 | 5.5 | Best-effort dual write can drop data, and ClickHouse has no subject-erasure/export path despite storing IP/payload. |
| Retention/legal hold | 7.5 | 6.5 | Retention code exists, but docs conflict with actual defaults, audit can be deleted, and legal hold is absent. |
| Consent ledger | 5.5 | 4.5 | Delete-recipient removes suppression records; a production privacy/consent system needs hashed do-not-contact tombstones or a consent ledger. |
| Request/log PII redaction | 7.5 | 5.8 | Pino/Fastify configs do not enforce structured redaction for bodies, recipient emails, auth headers, provider responses, or webhook payloads. |
| Customer enterprise SSO/SCIM | 5.0 | 2.0 | No customer SSO/SAML/OIDC or SCIM implementation found. Admin OIDC exists, but customer enterprise identity does not. |
| Admin OIDC login | 7.5 | 8.0 | Earlier report understated it: code performs issuer/audience/JWKS verification. Remaining gaps are IdP integration proof, claim policy, MFA assurance, and JIT governance. |
| Admin MFA enterprise posture | 8.5 | 7.0 | TOTP replay protection exists for password login, but production pushes admin auth to OIDC, and OIDC path does not enforce local TOTP or verify MFA claims like `amr`/`acr`. |
| Admin sessions | 8.0 | 6.5 | Opaque hashed sessions exist, but admin session records lack IP, user agent, last seen, revocation timestamp, device inventory, and revoke-all UX/API. |
| Support ticket lifecycle | 7.5 | 6.8 | Broad functionality exists, but customer support write/rate actions are guarded by `logs:read`, which is too broad. |
| Support AI triage/suggested reply | 6.5 | 5.5 | AI assist is heuristic/draft-only, but there is no PII redaction boundary, provider audit, prompt/output policy, or audit for suggested replies. |
| Immutable/durable audit | 6.0 | 5.0 | Audit is not tamper-evident, some writes are best-effort and swallowed, and retention can delete audit rows. |
| Config guard for identity/privacy/isolation | 7.0 | 5.8 | Secret/OIDC checks exist, but production boot does not validate RLS/DB role, storage privacy posture, ClickHouse auth/TLS, retention/legal-hold settings, or log redaction. |

## 22.4 Privacy And Data Rights Deep Hierarchy

### 22.4.1 Article 15 / Data Export

Local evidence:
- `packages/api/src/routes/privacy.ts` implements `GET /v1/privacy/export-recipient`.
- It returns recipient, exported timestamp, limited message fields, limited event fields, and suppression status.
- It does not load offloaded bodies via `loadMessageBody()`.
- It does not export full headers, metadata, tags, from/reply-to, tracked link originals, unsubscribe group membership, deletion request history, body object payloads, or derived analytics rows.

Current score: 5.5/10

Why the previous report was too generous:
- Docs say "all data", but implementation returns only a useful subset.
- GDPR access workflows need a data inventory and coverage across all stores, not only hot Postgres tables.

Missing for 10/10:
- Data inventory table listing every data store and field category.
- Async export job for large recipients.
- Full message record export, including headers/metadata/tags/from/reply-to.
- Body export for inline and object-store bodies.
- Tracked link export.
- Suppression and unsubscribe group export.
- Deletion request/audit export.
- ClickHouse-derived event export or documented legal exclusion.
- Pagination and signed export artifacts.

10/10 solution:
- Create `privacy_export_jobs` with state machine: `queued`, `collecting`, `ready`, `expired`, `failed`.
- Add collectors:
  - Postgres messages/events/tracked_links.
  - Body store via `loadMessageBody`.
  - Suppressions/unsubscribe groups.
  - Deletion requests/audit evidence.
  - ClickHouse rows when enabled.
- Store encrypted export bundle in S3 with short TTL and audit every access.

### 22.4.2 Article 17 / Erasure

Local evidence:
- `POST /v1/privacy/delete-recipient` deletes messages, events, tracked links, soft-bounce tracker rows, and suppressions for a recipient.
- It captures offloaded body keys and deletes orphaned body objects after DB commit.
- It inserts `deletion_requests.status='completed'` inside the DB transaction before object deletion.
- If object deletion fails, the error is logged but the API still returns completed.
- There is no ClickHouse erasure, DLQ erasure, queue erasure, log/tracing erasure, backup tombstone, or legal hold.

Current score: 5.8/10

Missing for 10/10:
- Durable erasure job with per-store states.
- Legal hold and lawful-basis exception modeling.
- Backup/tombstone policy.
- Queue/DLQ payload redaction or purge by recipient/message ID.
- ClickHouse deletion/tombstone by `customer_id` and `message_id`.
- Retry for body-store deletion failures.
- Final proof artifact showing every store status.

10/10 solution:
- Replace synchronous "delete and return completed" with `privacy_erasure_jobs`.
- Per-store states:
  - `postgres_messages`
  - `postgres_events`
  - `body_store`
  - `clickhouse`
  - `redis_bullmq`
  - `dlq`
  - `logs_traces`
  - `backups`
  - `suppression_tombstone`
- Return `pending` until all required stores are complete or legally retained.
- Keep a hashed recipient tombstone for do-not-contact and compliance proof.

### 22.4.3 Consent, Suppression, And Do-Not-Contact

Local evidence:
- `delete-recipient` calls `removeSuppression(auth.customer_id, recipient)`.
- Suppression rows are also the operational do-not-send control for complaints, hard bounces, unsubscribes, and manual suppressions.

Current score: 4.5/10

Risk:
- Erasing the suppression row can allow future re-import/re-send to a recipient who had unsubscribed or complained, unless another upstream system prevents it.
- Privacy erasure and marketing consent are separate duties; production systems usually preserve a minimized/hash-based do-not-contact record.

Missing for 10/10:
- Consent ledger.
- Hashed suppression tombstone.
- Legal basis, source, timestamp, and proof for opt-in/opt-out.
- Separate "forget personal data" from "retain minimal do-not-contact proof".

10/10 solution:
- Add `recipient_consent_ledger`.
- Add `suppression_tombstones` with HMAC(email, tenant-specific pepper), reason class, legal basis, and retention expiration.
- Send path checks live suppressions plus tombstones.
- Privacy export explains retained tombstone without exposing address if full erasure requested.

### 22.4.4 Queue, DLQ, Logs, And Traces

Current score: 5.8/10

Local evidence:
- DLQ stores job data.
- Pino configs do not define a redaction policy.
- Audit and support flows can contain message IDs, recipient emails, event payloads, support ticket bodies, provider responses, user-agent, and IP.

Missing for 10/10:
- Redaction at logger creation for API, tracker, worker, and Haraka wrappers.
- Redaction tests proving no email/body/provider payload is logged.
- DLQ payload minimization.
- Subject-erasure purge across waiting/delayed/failed/dead-letter queues.
- Trace attribute allowlist.

10/10 solution:
- Define `redact` rules for:
  - `req.headers.authorization`
  - cookies/session tokens
  - API keys
  - email bodies
  - recipient emails
  - webhook payloads
  - provider responses
  - support ticket body
  - event payloads
- Store only IDs in DLQ where possible; fetch sensitive context from DB on replay.
- Add `privacy:redact-queues` worker job.

## 22.5 Analytics And ClickHouse Deep Hierarchy

### 22.5.1 ClickHouse Dual Write

Local evidence:
- `packages/shared/src/clickhouse.ts` explicitly says ClickHouse writes are best-effort and can be dropped.
- Circuit breaker drops rows while open.
- Postgres remains source of truth.

Current score: 5.5/10

Missing for 10/10:
- Durable analytics outbox.
- Reconciliation from Postgres events to ClickHouse.
- Backfill job.
- Alerting on dropped rows/circuit-open state.
- ClickHouse auth/TLS config guard.
- Backup/restore plan for ClickHouse.

10/10 solution:
- Add `analytics_outbox` table or logical stream.
- Worker flushes outbox to ClickHouse with retry and checkpoint.
- Reconciliation job compares Postgres event counts vs ClickHouse counts by tenant/day/type.
- Add ClickHouse backup runbook and restore drill evidence.

### 22.5.2 ClickHouse Privacy

Local evidence:
- ClickHouse schema stores message ID, customer ID, event type, IP, and payload.
- TTL exists, but no subject-erasure path exists.

Current score: 5.0/10

Missing for 10/10:
- Subject deletion/tombstone from ClickHouse.
- Data minimization for IP/payload.
- Retention configuration aligned with tenant policy.
- Export coverage or explicit documented exclusion.

10/10 solution:
- Store recipient-hash or message-to-recipient index needed for erasure before Postgres message rows are deleted.
- Add mutation job to delete ClickHouse rows for erased message IDs.
- Consider stripping IP/payload or using hashed/anonymized values after operational window.

### 22.5.3 Analytics Cardinality And Privacy

Local evidence:
- Analytics breakdown endpoints return tag/domain/template breakdowns.
- They can return small buckets without aggregation thresholds.

Current score: 6.0/10

Missing for 10/10:
- k-anonymity threshold for analytics buckets.
- Small-bucket suppression.
- Tenant-configurable privacy mode.
- Tests proving one-recipient behavior cannot be inferred through narrow filters.

10/10 solution:
- Hide bucket values when count is below threshold.
- Add `privacy_mode=strict` for tenants.
- Add analytics tests for single-recipient and rare-template cases.

## 22.6 Identity, Admin, And Enterprise Security Deep Hierarchy

### 22.6.1 Tenant RLS And DB Role Posture

Current score: 4.5/10

Local evidence:
- RLS policies allow rows when `current_tenant_id()` is null.
- `withTenant()` exists but is not used by production routes.
- `rlsIsEnforced()` exists but API startup calls only `enforceConfig()`.

Why this score is lower now:
- This is not just "not integrated"; it is fail-open as a second layer.
- If an application query misses `customer_id`, RLS will not save it when tenant context is unset.

10/10 solution:
- Remove null-tenant allow-all from app-role policies.
- Add explicit service-role policies for admin/worker/migration paths.
- Wrap customer API/session-org routes in `withTenant()`.
- Refactor shared services to accept a transaction/executor.
- Fail production startup if DB role is owner, superuser, or BYPASSRLS.
- CI test fails when a new tenant table lacks fail-closed RLS.

### 22.6.2 Customer Enterprise SSO/SCIM

Current score: 2.0/10

Local evidence:
- Admin OIDC exists.
- No customer SSO/SAML/OIDC routes/schema found.
- No SCIM implementation found.

Missing for 10/10:
- Tenant SSO configuration.
- SAML and/or OIDC login for customer users.
- Domain verification and SSO enforcement.
- SCIM `/Users` and `/Groups`.
- Deprovisioning that revokes sessions and API access.
- Tenant MFA/session policy.
- Audit for every provisioning/deprovisioning action.

10/10 solution:
- Add `sso_connections`, `scim_tokens`, `external_identities`, `directory_groups`.
- Implement SCIM 2.0 core endpoints.
- Add SSO-required tenant policy.
- Add just-in-time user provisioning with domain guard.
- Add enterprise tests for deprovision -> session revoke.

### 22.6.3 Admin OIDC And MFA

Admin OIDC score: 8.0/10  
Admin MFA enterprise posture score: 7.0/10

Local evidence:
- Admin OIDC route validates issuer/audience/JWKS.
- Config guard requires OIDC in production and disables admin password login.
- TOTP replay protection exists for password login.
- OIDC path does not enforce local TOTP and does not verify IdP MFA claims.

Missing for 10/10:
- Enforce `amr`/`acr` MFA claim policy for admin OIDC.
- Optional local step-up after OIDC.
- JIT admin approval workflow.
- Break-glass workflow with expiration and alerting.
- Admin session inventory with IP/UA/last seen/device.
- Revoke-all sessions API.

10/10 solution:
- Add `ADMIN_OIDC_REQUIRED_ACR` and `ADMIN_OIDC_REQUIRED_AMR`.
- Add step-up challenge for sensitive actions.
- Store admin session IP, UA, last seen, revoked_at, device label.
- Add admin session list/revoke endpoints.

### 22.6.4 Support Permissions

Current score: 6.8/10

Local evidence:
- Customer support routes use `requireCapability('logs:read')` for read and write/rate operations.
- Admin support routes use admin roles.

Risk:
- A dashboard role meant for log visibility can mutate support tickets.

Missing for 10/10:
- `support:read`, `support:write`, and `support:rate` capabilities.
- Analyst read-only guarantee.
- Regression tests for permissions.

10/10 solution:
- Split support route capabilities:
  - list/get/unread: `support:read`
  - create/reply/read marker: `support:write`
  - CSAT/rating: `support:rate`
- Keep `logs:read` separate.
- Add OpenAPI security metadata.

### 22.6.5 Support AI Governance

Current score: 5.5/10

Local evidence:
- Local heuristic provider exists.
- Suggested replies are draft-only.
- Triage is audited.
- Suggested reply endpoint is not audited.
- No PII redaction or provider governance layer exists.

Missing for 10/10:
- PII redaction before inference.
- Provider/model audit trail.
- Prompt and output retention policy.
- Per-ticket audit for suggested replies.
- Human approval before sending any AI-generated text.
- Tenant opt-out for AI processing.

10/10 solution:
- Add `ai_processing_events`.
- Redact emails/API keys/secrets/message IDs before external inference.
- Store model, provider, prompt hash, output hash, actor, ticket ID, and decision.
- Add `AI_DISABLED` tenant setting.

### 22.6.6 Audit Durability

Current score: 5.0/10

Local evidence:
- `recordAuditSafe()` swallows failures.
- Admin audit writes exist for many actions.
- Retention can delete audit rows.
- No hash chain or WORM sink exists.

Missing for 10/10:
- Durable audit outbox.
- Hash chaining.
- External WORM/SIEM export.
- Request IP for admin audit actions.
- Audit retention policy with export proof before deletion.
- No best-effort audit for security-sensitive actions.

10/10 solution:
- Add `audit_outbox`.
- Add `audit_hash_chain` with previous hash and daily root.
- Export to S3 Object Lock/SIEM.
- Make key/security/billing/admin mutations fail if audit cannot be recorded.
- Retention should archive audit before purge and record archive proof.

## 22.7 DR, Compliance, And Enterprise Evidence

Current score: 4.5/10

Why this needs deeper treatment:
- The report mentions DR and compliance, but it should explicitly tie enterprise readiness to evidence.
- AWS guidance requires RTO/RPO objectives and tested restoration, not merely "managed backups".
- AICPA SOC2 criteria require control evidence across security, availability, processing integrity, confidentiality, and privacy.

Missing for 10/10:
- RTO/RPO per workload: API, worker, tracker, Postgres, Redis, object storage, ClickHouse, Haraka, billing webhooks.
- Restore drill artifacts.
- Backup inventory and restore ownership.
- SOC2 control matrix.
- Evidence collection automation.
- Change management and access review evidence.
- Incident response tabletop records.

10/10 solution:
- Add `docs/compliance/control-matrix.md`.
- Add `docs/release-evidence/dr/YYYY-MM-DD/restore-drill.md`.
- Add quarterly access review export.
- Add incident response tabletop template and evidence folder.
- Add backup restore tests for Postgres and ClickHouse.

## 22.8 Third-Pass Priority Reset

1. Fix RLS fail-open design and wire tenant context into API execution.
2. Build durable privacy export/erasure jobs across Postgres, body store, ClickHouse, queues/DLQ, logs/traces, and backups.
3. Add customer enterprise SSO/SCIM; current implementation is effectively absent.
4. Make audit durable, tamper-evident, and retention-safe.
5. Add admin MFA claim enforcement/step-up for OIDC and admin session inventory.
6. Split support permissions and govern support AI.
7. Add ClickHouse outbox/reconciliation plus erasure and backup/restore.
8. Add production log redaction and queue/DLQ PII minimization.
9. Add DR/SOC2 evidence gates with RTO/RPO and restore proof.

## 22.9 Third-Pass Verdict

The markdown's top-level conclusion remains valid: the platform is not 10/10 production/SaaS/enterprise grade.

The deeper third-pass correction is that privacy, tenant isolation, customer enterprise identity, and audit durability are weaker than the earlier scores implied:

| Dimension | Previous validated score | Third-pass score |
| --- | ---: | ---: |
| SaaS multi-tenant readiness | 6.4 | 6.1 |
| Privacy/GDPR readiness | 7.0 | 5.8 |
| Customer enterprise identity readiness | 5.0 | 2.0 |
| Audit/compliance evidence readiness | 5.5 | 4.8 |
| Analytics/ClickHouse production readiness | 6.5 | 5.5 |
| Overall enterprise readiness | 5.5 | 5.2 |

The strongest parts remain API breadth, worker/send pipeline, unsubscribe implementation, admin OIDC basics, storage abstraction, and operational docs. The biggest blockers are enforcement and proof: fail-closed tenant isolation, complete data-rights workflows, durable audit, enterprise identity, production-grade analytics, and compliance evidence.

# 23. Fourth-Pass Agent-Assisted Validation

Date: 2026-06-25

Scope of this pass:
- Outbound/inbound SMTP, Haraka, DKIM, DNS, bounce handling, DSN/FBL, TLS, ARC, and deliverability operations.
- SDK, OpenAPI, API documentation, generated docs, version lifecycle, examples, and package publishing readiness.
- CI/CD, dependency audit, Docker image hardening, SBOM, provenance, SLSA posture, npm publishing, and release evidence.

Method:
- Three read-only specialist agents inspected independent slices of the repository.
- The main validation pass checked local code/docs and cross-checked the gaps against external standards and current official documentation.
- No application code was edited in this pass. This section updates the report only.

External standards used in this pass:

| Standard/source | Why it matters for this platform |
| --- | --- |
| RFC 6376 DKIM: https://www.rfc-editor.org/info/rfc6376/ | Baseline for DKIM signing, selector, key, and signature behavior. |
| RFC 8461 MTA-STS: https://datatracker.ietf.org/doc/html/rfc8461 | Defines receiver-published SMTP TLS policy discovery and enforcement expectations. |
| RFC 8460 SMTP TLS Reporting: https://datatracker.ietf.org/doc/html/rfc8460 | Defines TLS-RPT reporting for SMTP TLS failures. |
| RFC 8617 ARC: https://datatracker.ietf.org/doc/html/rfc8617 | Defines ARC sealing/authentication chain preservation, relevant for forwarding/auth preservation use cases. |
| SLSA: https://slsa.dev/ | Baseline for build provenance, artifact integrity, and supply-chain hardening. |
| OpenSSF Scorecard: https://scorecard.dev/ | Practical automated checks for repository supply-chain posture. |
| npm trusted publishing: https://docs.npmjs.com/trusted-publishers/ | Current npm mechanism for OIDC-based publishing without long-lived npm tokens. |
| npm provenance: https://docs.npmjs.com/generating-provenance-statements/ | Current npm support for build provenance statements during package publish. |

## 23.1 Fourth-Pass Score Corrections

The previous top-level verdict remains valid: this platform is not 10/10 production-grade, SaaS-grade, or enterprise-grade yet.

The fourth-pass correction is sharper: several areas are not merely "missing proof"; they contain implementation or contract mismatches that would break production expectations.

| Module | Previous direction | Fourth-pass corrected score | Reason |
| --- | ---: | ---: | --- |
| Outbound Haraka/MTA | 7.5 | 6.0 | DKIM fail-closed behavior exists, but DKIM rotation is not wired into the signer, TLS config is placeholder-level, and K8s does not deploy Haraka while production config defaults to Haraka transport. |
| Inbound Haraka/DSN/FBL | 8.0 | 7.0 | Parser and VERP forgery defenses are real, but DSN/FBL metrics, unknown classification, and operational triage are incomplete. |
| Domains/DKIM/DNS | 8.0 | 6.5 | Domain verification records DMARC but does not enforce it for send authorization, and per-domain bounce-path alignment is documented but not implemented in worker return-path generation. |
| Delivery transport | 7.5 | 6.5 | SES and Haraka transports exist, but SMTP error taxonomy is shallow and internal Haraka SMTP does not enforce STARTTLS. |
| Tracking/unsubscribe compliance | 8.0 | 6.5 | One-click unsubscribe exists, but group opt-outs are not enforced on future sends despite docs claiming they are. |
| MTA security/TLS/ARC | 7.0 | 5.0 | MTA-STS/TLS-RPT are absent, TLS cert config is empty, ARC is checklist-only, and no production Haraka K8s deployment exists. |
| SDK overall | 7.5 | 5.0 | Usable for selected resources, but docs/API drift, missing resources, broken webhook verification, and weak publishing metadata lower readiness. |
| SDK webhook verification | 8.5 | 2.5 | SDK helper does not validate the platform's real `X-MP-Signature: t=...,v1=...` format. |
| OpenAPI/API contract | 7.0 | 4.5 | Spec is hand-maintained, incomplete, and stale against runtime routes and billing provider support. |
| API docs/examples | 7.5 | 5.0 | Several SDK examples use non-existent fields/resources and wrong OpenAPI URL. |
| API version lifecycle | 7.0 | 5.0 | Deprecation/Sunset headers exist as optional env behavior, but no compatibility gate, breaking-change diff, or version negotiation exists. |
| Dependency hygiene | 6.5 | 5.8 | `npm audit --omit=dev --audit-level=moderate` still reports 27 moderate vulnerabilities, while CI gates only high/critical. |
| Docker image/runtime hardening | 6.5 | 5.5 | API/worker/tracker are better than Haraka, but base images are not digest-pinned, installs are non-deterministic in places, Haraka runs as root, and migrations are tied to app startup. |
| SBOM maturity | 6.5 implied | 4.5 | SBOM generation exists but is non-blocking, unsigned, not validated, and not attached to release/image evidence. |
| GitHub Actions CI/CD | not separately scored | 5.5 | Build/test/security jobs exist, but no hardened permissions, release workflow, pinned action SHAs, approvals, provenance, or staging smoke gate. |
| npm/package publishing | SDK 7.5 implied | 4.0 | SDK package exists, but no trusted publishing, provenance, release workflow, package README/license/repository metadata, or `npm pack` gate. |
| SLSA-style provenance | not scored | 0.5 | No build attestations, OIDC provenance, signed containers, signed packages, or deploy-time provenance verification. |
| Release evidence | 4.5 | 3.0 | Scripts exist, but there is no persisted release evidence folder with signed run outputs, digests, SBOMs, scans, smoke tests, and restore/load drill artifacts. |

## 23.2 Mail Transport And Deliverability Deep Hierarchy

### 23.2.1 Outbound Haraka

Current score: 6.0/10

Submodules:

| Submodule | Score | What is valid | What is missing or invalid |
| --- | ---: | --- | --- |
| Customer-aware DKIM signing | 7.5 | `customer_dkim.js` signs through Nodemailer DKIM and can fail closed when `DKIM_REQUIRED` is not false. | It reads `sending_domains.dkim_private_key` and `sending_domains.dkim_selector`, not the `dkim_keys` rotation table. |
| DKIM rotation integration | 3.5 | `dkim_keys` lifecycle code and scheduler exist. | New/active/retiring selectors are not selected by the Haraka signer, so rotation is operationally incomplete. |
| Haraka production deployment | 3.0 | Compose has inbound/outbound Haraka services. | K8s config sets `DELIVERY_TRANSPORT=haraka`, but production manifests do not deploy Haraka inbound/outbound services. |
| Outbound queue durability | 5.5 | Compose mounts a queue volume for Haraka outbound. | No K8s persistent queue volume, pod disruption budget, restart recovery proof, or queue drain/runbook evidence. |
| Outbound TLS | 4.0 | Haraka TLS config files exist. | `key=` and `cert=` are empty placeholders, no cert mount/rotation plan, no STARTTLS smoke test, no TLS failure metrics. |
| DKIM failure observability | 3.5 | Grafana references DKIM failure metrics. | `mp_dkim_sign_failures_total` is not defined/incremented by signer code. |

Why the old score was too high:
- The report previously treated DKIM rotation as a production feature.
- Local evidence shows rotation state exists in `dkim_keys`, but the signer still uses static columns on `sending_domains`.
- A real enterprise MTA cannot score near 10 unless key rotation is actually used in message signing and rollback is tested.

10/10 solution:
1. Make `addDomain` create the first `dkim_keys` row and stop treating `sending_domains.dkim_private_key` as the active signing source.
2. Change Haraka signer lookup to select `dkim_keys.state='active'` for the sending domain.
3. Add promote/rollback API for pending selectors and enforce a retiring grace window.
4. Add signing tests that prove old selector, new selector, and rollback behavior.
5. Add `mp_dkim_sign_failures_total` with labels for `missing_key`, `decrypt_failed`, `db_lookup_failed`, `sign_failed`, and `missing_signature`.
6. Add alerts and dashboards based on the real metric, not aspirational PromQL.
7. Add production Haraka Deployment/StatefulSet, Service, probes, resources, queue volume, TLS secret mounts, and NetworkPolicy.

### 23.2.2 Inbound Haraka, DSN, And FBL

Current score: 7.0/10

Submodules:

| Submodule | Score | What is valid | What is missing |
| --- | ---: | --- | --- |
| VERP bounce parsing | 8.0 | Bounce parser and tests exist; worker generates VERP-like return paths. | Return-path is global-domain based, not customer bounce-domain aligned. |
| Forgery resistance | 8.0 | Parser contains defenses against malformed/forged tokens. | Needs provider fixture corpus and signed bounce-token evidence for high confidence. |
| ARF/FBL handling | 7.0 | FBL parsing logic exists. | Provider registration evidence, unknown triage, and complaint source mapping are missing. |
| DSN metrics | 3.5 | `mp_dsn_parse_total` exists in shared metrics and alerts reference it. | Haraka parser does not emit/increment it. |
| Unknown DSN handling | 5.0 | Parser can reject/skip unknown input. | No workflow to sample, classify, replay, and add new provider fixtures. |

10/10 solution:
1. Emit DSN/FBL parse metrics from inbound Haraka or a normalized event worker.
2. Label outcomes as `dsn`, `arf`, `unknown`, `forged`, `malformed`, and `failed`.
3. Persist sanitized raw samples for unknown formats with retention controls.
4. Add provider fixture tests for Gmail, Outlook, Yahoo, AWS SES, SendGrid-like ARF, and malformed spoof attempts.
5. Add an operations queue for unknown DSN/FBL review.
6. Tie complaint events to suppression, reputation scoring, and customer alerting.

### 23.2.3 Domains, DNS, SPF, DKIM, DMARC, And Bounce Alignment

Current score: 6.5/10

Submodules:

| Submodule | Score | Evidence | Gap |
| --- | ---: | --- | --- |
| DNS record generation | 7.5 | Domain service returns SPF, DKIM, DMARC, verification, and bounce records. | Does not generate MTA-STS/TLS-RPT/BIMI records. |
| SPF verification | 7.0 | Domain verification checks SPF content. | Needs DNS timestamp, resolver diversity, and provider-specific warning quality. |
| DKIM verification | 7.0 | DKIM TXT check exists and keys are encrypted. | Verification is not tied to active `dkim_keys` selector lifecycle. |
| DMARC verification | 5.5 | DMARC is checked and policy warnings exist. | `verified` does not require DMARC; send authorization checks only `verified_at` and `dkim_verified`. |
| Bounce-path alignment | 4.5 | Docs describe customer bounce CNAME/alignment. | Worker uses one global `BOUNCE_DOMAIN`, so documented per-customer alignment is not implemented. |
| DNS freshness | 5.0 | Manual verification exists. | No enforced re-check schedule, stale DNS lockout, or domain graduation gate. |

Why this matters:
- Gmail/Yahoo-style bulk sender requirements make SPF, DKIM, DMARC, and easy unsubscribe operational requirements, not optional polish.
- DMARC being "recorded but not enforced" creates a gap between docs, platform promises, and real send eligibility.
- A global return-path can hurt alignment and makes the documented customer bounce CNAME misleading.

10/10 solution:
1. Store per-sending-domain bounce host and verification status.
2. Generate return-path from the sending domain's verified bounce host, not one global `BOUNCE_DOMAIN`.
3. Require DMARC for bulk/marketing pools and high-volume graduation.
4. Require `p=quarantine` or `p=reject` before high-volume Gmail/Yahoo/Outlook sending.
5. Add DNS freshness timestamps and block sending when DNS age exceeds policy.
6. Add MTA-STS and TLS-RPT record guidance for receiving-domain posture where the platform hosts inbound mail.
7. Add BIMI as optional deliverability branding, not as a core compliance gate.

### 23.2.4 SMTP Transport And Error Taxonomy

Current score: 6.5/10

Submodules:

| Submodule | Score | What is present | What blocks 10/10 |
| --- | ---: | --- | --- |
| SES transport | 7.0 | SMTP transport supports SES with `requireTLS` on port 587. | No provider-specific retry taxonomy, credential rotation gate, or sending pool strategy. |
| Haraka transport | 6.0 | Local Haraka SMTP transport exists. | Internal SMTP is plaintext and does not enforce STARTTLS. |
| Error classification | 4.5 | Numeric 5xx and regex enhanced-code detection exist. | No provider/domain-specific enhanced status taxonomy. |
| Retry shaping | 5.5 | Worker retry behavior exists. | No dynamic throttling by provider, domain, pool, or SMTP code family. |
| Suppression integration | 6.0 | Some permanent failures can become suppressions. | Must route `5.1.1`-class hard bounces and complaint signals deterministically. |

10/10 solution:
1. Parse enhanced status codes and provider response text into normalized classes.
2. Route `5.1.1`/unknown user to hard suppression, `4.7.x` to throttling, policy/content rejects to review, and auth failures to domain suspension.
3. Persist provider/domain response rates for Gmail, Outlook, Yahoo, corporate MX, and long-tail domains.
4. Add fixtures for common SMTP replies and regression tests for classification.
5. Add per-provider adaptive retry windows and circuit breakers.
6. Enforce STARTTLS for internal Haraka SMTP or document an isolated mTLS/private-network exception with compensating controls.

### 23.2.5 MTA Security: TLS, MTA-STS, TLS-RPT, DANE, ARC

Current score: 5.0/10

Submodules:

| Submodule | Score | Gap |
| --- | ---: | --- |
| STARTTLS config | 4.0 | TLS config files exist but cert/key are empty. |
| MTA-STS | 1.5 | No visible implementation or DNS/policy generation. |
| TLS-RPT | 1.5 | No visible reporting address, parser, or reporting docs. |
| DANE/TLSA | 1.0 | No DNSSEC/TLSA posture or docs. |
| ARC | 2.0 | Production checklist marks ARC as deferred/config-only; no ARC signing path exists. |
| TLS observability | 2.5 | No TLS failure metrics or receiver TLS policy dashboard. |

10/10 solution:
1. Mount real TLS certs for inbound and outbound MTAs.
2. Add STARTTLS smoke tests in CI/staging.
3. Add TLS version/cipher/cert-expiry metrics and alerts.
4. Add MTA-STS DNS/policy hosting docs and validation checks for hosted inbound domains.
5. Add TLS-RPT receiving/aggregation if operating inbound MX at scale.
6. Add ARC signing/sealing only where forwarding/authentication-preservation use cases exist; test with ARC fixtures.
7. Clearly document what is platform-operated versus customer-operated DNS/security responsibility.

### 23.2.6 Tracking And Unsubscribe Enforcement

Current score: 6.5/10

Submodules:

| Submodule | Score | What is valid | Gap |
| --- | ---: | --- | --- |
| One-click unsubscribe | 8.0 | One-click endpoint and headers exist. | Needs provider inbox-placement proof and compliance monitoring. |
| Global suppression | 8.0 | Send path checks global suppressions. | Needs stronger reconciliation with imports/deletions and event-sourced consent. |
| Group unsubscribe capture | 7.0 | Tracker inserts into `unsubscribe_group_members`. | Send path does not skip group-unsubscribed recipients. |
| Group unsubscribe docs | 4.0 | Docs claim future sends skip opted-out recipients. | This is currently false for send authorization. |
| Quota/refund behavior | 4.0 | Quota checks exist. | No refund/skip accounting for group opt-out exclusions. |

10/10 solution:
1. Add group-member suppression checks to single send and batch send.
2. Return structured skipped-recipient results for batch.
3. Refund or avoid charging quota for group-skipped recipients.
4. Add E2E tests: group opt-out -> future same-group send skipped -> different-group send allowed.
5. Add dashboard/reporting for global vs group opt-outs.
6. Update docs only after behavior is implemented.

## 23.3 SDK, OpenAPI, Docs, And API Contract Deep Hierarchy

### 23.3.1 SDK Overall

Current score: 5.0/10

Submodules:

| Submodule | Score | What is valid | What is missing |
| --- | ---: | --- | --- |
| Core HTTP client | 6.5 | Typed TypeScript client exists with retry behavior for selected cases. | Not generated from OpenAPI; no full route coverage; no exhaustive contract tests. |
| Resource coverage | 5.0 | Messages, domains, suppressions, templates, webhooks, usage, analytics exist. | Missing advertised/account/privacy/team/unsubscribe-group/auth/session/billing surfaces. |
| Field naming | 5.0 | SDK can send basic payloads. | Docs use camelCase fields while SDK/API use snake_case fields in key examples. |
| Error model | 5.5 | Basic request errors exist. | No stable error-code registry or typed per-endpoint error responses. |
| Runtime compatibility | 5.5 | ESM package exists. | Sync webhook helper uses Node `require()` style inside an ESM package path. |
| Test coverage | 5.0 | Some SDK E2E tests exist. | No docs-snippet compile tests and no SDK-vs-OpenAPI parity tests. |

10/10 solution:
1. Choose one source of truth: generate SDK from OpenAPI or generate OpenAPI from route schemas.
2. Keep ergonomic wrappers thin and tested.
3. Add a method for every public non-admin API route intended for SDK users.
4. Compile all docs snippets against the real SDK in CI.
5. Run SDK contract tests against Fastify inject or a staging API.
6. Add typed error classes and stable error code exports.
7. Add compatibility tests for Node ESM, Node CJS import shape if supported, browser/fetch runtime, and edge/runtime constraints.

### 23.3.2 SDK Webhook Verification

Current score: 2.5/10

What is valid:
- The platform worker signs webhook deliveries.
- Shared crypto signs `timestamp.body`.
- Worker sends `X-MP-Signature: t=...,v1=...`.

What is invalid:
- SDK docs/reference helper uses an `x-webhook-signature` style example.
- SDK helper signs/verifies only the body shape and strips `sha256=`.
- It does not parse the actual `t=...,v1=...` header.
- It does not enforce timestamp tolerance against the real header format.
- It does not support secret rotation/multiple signatures.

10/10 solution:
1. Replace helper API with `verifyWebhookSignature({ rawBody, header, secret, toleranceSeconds })`.
2. Parse `X-MP-Signature` into timestamp and one or more `v1` signatures.
3. Compute `HMAC(secret, timestamp + "." + rawBody)`.
4. Use constant-time comparison.
5. Enforce timestamp tolerance and reject malformed timestamps.
6. Support multiple active secrets during rotation.
7. Add tests using real worker-generated headers.
8. Update docs to use raw body middleware and the actual `X-MP-Signature` header.

### 23.3.3 OpenAPI/API Contract

Current score: 4.5/10

Submodules:

| Submodule | Score | Gap |
| --- | ---: | --- |
| Route parity | 3.5 | Public routes such as `/send/batch`, `/profile`, privacy export/deletions, suppression export, unsubscribe groups, quota, stats, scheduled/cancel messages, auth/session/team, and webhook operations are missing or partially missing. |
| Schema parity | 4.5 | Request/response schemas are incomplete and not proven against runtime handlers. |
| Provider enum parity | 4.0 | Billing implementation supports `cashfree`; OpenAPI webhook provider enum lists only `stripe` and `paypal`. |
| Privacy contract accuracy | 4.0 | Some docs/spec language claims "all data" deletion/export despite known incomplete erasure/export surfaces. |
| Generated docs | 5.5 | Static OpenAPI docs exist, but generation starts from a hand-maintained incomplete spec. |
| Contract testing | 4.0 | Existing OpenAPI tests are spot checks, not full runtime route parity. |

10/10 solution:
1. Add `openapi-route-parity.test.ts` that enumerates Fastify routes and compares against OpenAPI.
2. Fail CI if any public route/method is absent.
3. Fail CI if auth scheme, path params, request body, response body, or provider enum drift.
4. Add schema validation at route boundaries or generate schemas from shared route definitions.
5. Add previous-spec diffing and breaking-change detection.
6. Publish versioned OpenAPI artifacts with release evidence.
7. Generate SDK types from the same contract.

### 23.3.4 Docs And Examples

Current score: 5.0/10

Invalid or stale examples found:
- SDK docs claim "fully typed against the OpenAPI contract" while the SDK is handwritten.
- Docs use `trackingOpens`, `trackingClicks`, `templateId`, `htmlBody`, `textBody`, `mp.account.usage()`, `mp.unsubscribeGroups`, `mp.privacy`, and `mp.webhooks.deliveries()` patterns that do not match the current SDK surface.
- Runtime registers `GET /openapi.json`, while docs reference `/v1/openapi.json`.
- Architecture docs still contain stale object-storage statements from an earlier version.
- Privacy docs/API examples overstate complete export/deletion behavior.
- Unsubscribe group docs claim future sends are skipped, but send path does not enforce group opt-outs.

10/10 solution:
1. Treat docs examples as executable tests.
2. Extract TypeScript snippets from `docs/SDK.md`, compile them against `packages/sdk`.
3. Run critical snippets against a test API.
4. Add a docs drift CI job for OpenAPI URL, package import, field names, and method existence.
5. Add a "docs truth table" mapping each public claim to code/test evidence.
6. Change docs language from absolute claims to exact implemented behavior until code is complete.

### 23.3.5 API Version Lifecycle

Current score: 5.0/10

What exists:
- Optional `Sunset` and `Deprecation` header behavior exists.
- Central OpenAPI file has a version.

What is missing:
- No version negotiation strategy.
- No old-client compatibility test matrix.
- No breaking-change detector.
- No public deprecation policy with dates, migration guides, and endpoint-level ownership.
- No stable error-code lifecycle.
- No release artifact that captures OpenAPI diff.

10/10 solution:
1. Add `docs/api-versioning.md` with supported versions, compatibility promise, and deprecation process.
2. Add OpenAPI diff in CI and block unapproved breaking changes.
3. Add endpoint-level deprecation metadata with owner, replacement route, and sunset date.
4. Add stable error-code registry and tests.
5. Publish versioned OpenAPI specs per release.
6. Add SDK compatibility tests against previous OpenAPI versions.

### 23.3.6 SDK Package Publishing

Current score: 4.0/10

Submodules:

| Submodule | Score | Gap |
| --- | ---: | --- |
| Package metadata | 3.5 | Missing README/license/repository/exports/publishConfig quality expected for public SDKs. |
| Package contents | 4.0 | `npm pack --dry-run` would ship only dist files and package metadata, with weak consumer-facing docs. |
| Release workflow | 1.5 | No dedicated SDK publish workflow. |
| Provenance | 0.5 | No npm trusted publishing or provenance. |
| Version alignment | 4.0 | Root/OpenAPI/SDK versions are not clearly governed by one release policy. |
| Prepublish checks | 2.5 | No `prepublishOnly` build/typecheck/test/docs-snippet gate. |

10/10 solution:
1. Add SDK README, license, repository, homepage, bugs URL, exports map, files policy, and publishConfig.
2. Add `prepublishOnly` to run build, typecheck, unit tests, docs snippet compile, and `npm pack --dry-run`.
3. Add GitHub Actions release workflow using npm trusted publishing.
4. Publish with provenance.
5. Attach package tarball integrity and OpenAPI spec to release evidence.
6. Add semver/changelog automation and migration notes.

## 23.4 CI/CD, Supply Chain, Docker, And Release Evidence Deep Hierarchy

### 23.4.1 GitHub Actions CI/CD

Current score: 5.5/10

What is valid:
- CI builds and tests several core workspaces.
- CI runs migrations/tests and a security audit.
- Trivy image scan exists for some runtime images.
- SBOM generation exists.

What is missing:
- No top-level or job-level hardened `permissions`.
- No `id-token: write` for keyless provenance.
- No release/tag workflow.
- No protected environment approvals.
- No pinned action SHAs.
- No k6 load test execution in CI despite report/docs implying load-test readiness.
- CI build list does not clearly include all workspaces such as SDK/docs in the same enforced path.

10/10 solution:
1. Add explicit least-privilege `permissions` at workflow/job level.
2. Pin third-party actions by commit SHA or use an allowlist policy.
3. Add release workflow triggered by protected tags.
4. Require build, typecheck, tests, migration checks, OpenAPI parity, SDK docs snippets, audit, SBOM, image scan, and staging smoke before release.
5. Add protected deployment environments with required reviewers.
6. Upload release evidence artifacts.

### 23.4.2 Dependency Hygiene

Current score: 5.8/10

Evidence:
- `npm audit --omit=dev --audit-level=moderate --json` still reports 27 moderate vulnerabilities.
- Current CI gates only high/critical via `--audit-level=high`.

Why this is not enterprise-grade:
- An enterprise/SOC2-style posture can accept some vulnerabilities only with explicit risk acceptance.
- A silent moderate backlog is not equivalent to a controlled exception process.

10/10 solution:
1. Change CI gate to `npm audit --omit=dev --audit-level=moderate`.
2. Add `SECURITY_RISK_ACCEPTANCE.md` for any exception.
3. Each exception must include owner, package, advisory, exploitability, affected runtime, compensating control, expiry date, and remediation ticket.
4. Add Dependabot or Renovate with grouped updates and security PR priority.
5. Add lockfile review policy for transitive dependency changes.

### 23.4.3 SBOM

Current score: 4.5/10

What exists:
- CycloneDX SBOM generation is present in CI.

What blocks 10/10:
- SBOM generation uses non-blocking behavior.
- Artifact upload can allow missing files.
- No SBOM signing.
- No image-level SBOM.
- No release attachment or digest linking.
- No SBOM diff/review workflow.

10/10 solution:
1. Remove non-blocking SBOM generation.
2. Fail CI if SBOM generation or validation fails.
3. Generate both source/package SBOM and container image SBOM.
4. Sign SBOMs.
5. Attach SBOMs to releases and link them to image/package digests.
6. Add SBOM diff review for release PRs.

### 23.4.4 Docker Image And Runtime Hardening

Current score: 5.5/10

Submodules:

| Submodule | Score | Gap |
| --- | ---: | --- |
| Non-root runtime | 6.0 | API/worker/tracker are better, but Haraka images run as root. |
| Base image pinning | 3.0 | Base images are not digest-pinned. |
| Deterministic install | 4.5 | Dockerfiles should use `npm ci` with lockfile and production pruning. |
| Runtime contents | 5.0 | Runtime copies too much application tree instead of only required dist/prod metadata. |
| App startup | 4.0 | Migrations are tied to app container startup in places. |
| Healthchecks | 4.0 | Dockerfile-level healthchecks are missing. |
| Image scan scope | 5.0 | API/worker/tracker scans exist; Haraka/docs images are not equally covered. |
| Signing | 0.5 | No image signing or signed digest verification. |

10/10 solution:
1. Pin base images by digest.
2. Use multi-stage builds with `npm ci`.
3. Copy only `dist`, production package metadata, and required runtime files.
4. Run all images as non-root, including Haraka where feasible.
5. Move migrations to a separate release job/init job, not app startup.
6. Add Dockerfile `HEALTHCHECK` where appropriate.
7. Scan every runtime image.
8. Sign images with keyless signing and verify signatures before deploy.

### 23.4.5 SLSA, Provenance, And Artifact Integrity

Current score: 0.5/10

What exists:
- Conventional CI artifacts/checks exist.

What is missing:
- No build provenance attestations.
- No container provenance.
- No npm provenance.
- No signed image digests.
- No release artifact signing.
- No deploy-time verification of provenance.
- No SLSA target level stated.

10/10 solution:
1. Define SLSA target level for the platform.
2. Use GitHub OIDC and artifact attestations for builds.
3. Generate provenance for npm packages.
4. Generate provenance for container images.
5. Sign images and release artifacts.
6. Store and verify digests in release evidence.
7. Block production deploy unless image/package provenance verifies against trusted builder identity.

### 23.4.6 Release Evidence

Current score: 3.0/10

What exists:
- Production readiness script exists.
- Backup drill scripts/runbooks exist.
- CI jobs can produce some artifacts.

What is missing:
- No persisted `docs/release-evidence/YYYY-MM-DD/` folder.
- No signed audit output.
- No image digest list.
- No SBOM hash list.
- No Trivy SARIF archive for all images.
- No staging smoke result.
- No k6 load result tied to a release.
- No restore drill result tied to a release.
- No OpenAPI diff artifact.
- No SDK package integrity artifact.

10/10 solution:
1. Create release evidence folder for every production release.
2. Store GitHub run IDs, commit SHA, tag, image digests, package versions, SBOM hashes, audit output, Trivy output, OpenAPI diff, SDK pack output, smoke test output, load test output, and restore drill evidence.
3. Sign the evidence manifest.
4. Require evidence review before production promotion.
5. Add release checklist ownership and approval record.

## 23.5 Deep Invalid-Claim Ledger

| Claim/location type | Fourth-pass verdict | Why |
| --- | --- | --- |
| "DKIM rotation is production-ready" | Overstated | Rotation table/lifecycle exists, but Haraka signer does not use `dkim_keys`. |
| "Customer bounce CNAME aligns return-path" | Incorrect in implementation | Worker builds return-path with global `BOUNCE_DOMAIN`. |
| "DMARC required" | Partially true in docs, false as send gate | Domain service checks DMARC, but send authorization does not require it. |
| "Haraka production path is ready" | Overstated | Compose has Haraka; K8s production config defaults to Haraka without deploying Haraka. |
| "TLS/STARTTLS MTA security is production-grade" | Overstated | TLS config has empty cert/key placeholders and no MTA-STS/TLS-RPT implementation. |
| "ARC is available" | Not implemented | Checklist marks ARC as deferred/config-only; no ARC signing code path found. |
| "DSN parse metrics/dashboards prove operations" | Aspirational | Metrics/alerts reference DSN counters that Haraka does not emit. |
| "Group unsubscribes skip future sends" | Incorrect | Tracker records group opt-out, but send path checks only global suppressions. |
| "SDK is typed against OpenAPI" | Incorrect | SDK is handwritten; OpenAPI is hand-maintained and incomplete. |
| "SDK webhook helper verifies real platform webhooks" | Incorrect | Helper does not parse `X-MP-Signature: t=...,v1=...`. |
| "OpenAPI is current" | Incorrect | Missing public routes and stale billing provider enum. |
| "Docs examples are reliable" | Overstated | Several examples use methods/fields not present in SDK. |
| "CI includes SBOM and therefore supply chain is strong" | Overstated | SBOM is non-blocking, unsigned, and not release-attached. |
| "Image scan gate covers runtime" | Partially true | Some images scanned; Haraka/docs image coverage and signed digest gates are missing. |
| "Production readiness check is release proof" | Overstated | It validates template/config shape, not real deployed secrets, artifacts, provenance, smoke, or restore proof. |

## 23.6 Fourth-Pass 10/10 Remediation Backlog

Priority 0 - correctness mismatches:
1. Fix SDK webhook verification to match worker-generated `X-MP-Signature`.
2. Enforce group unsubscribe checks in send and batch-send paths.
3. Wire DKIM rotation table into Haraka signer.
4. Implement per-domain bounce return-path instead of global `BOUNCE_DOMAIN`.
5. Fix OpenAPI route/provider drift and add route parity tests.
6. Correct docs examples that reference non-existent SDK methods/fields.

Priority 1 - production mail transport:
1. Add Haraka inbound/outbound production manifests.
2. Mount real TLS certs and smoke-test STARTTLS.
3. Add MTA TLS metrics and alerts.
4. Add real DSN/FBL parse metrics.
5. Add enhanced SMTP status taxonomy and provider fixtures.
6. Add DMARC enforcement gates for bulk/high-volume sending.

Priority 2 - API contract and developer platform:
1. Generate SDK from OpenAPI or generate OpenAPI from route schemas.
2. Add docs-snippet compile tests.
3. Add stable error-code registry.
4. Add API versioning policy and OpenAPI breaking-change detector.
5. Add SDK publishing metadata and release workflow.

Priority 3 - supply chain and enterprise release:
1. Change audit gate to moderate or add formal risk acceptance.
2. Make SBOM generation fail-closed and signed.
3. Add SLSA provenance/attestations.
4. Add npm trusted publishing with provenance.
5. Sign container images and verify signatures before deploy.
6. Add release evidence folder with signed manifest.
7. Add OpenSSF Scorecard, CodeQL, secret scanning, action SHA pinning, and Dependabot/Renovate.

## 23.7 Fourth-Pass Verdict

The report is still valid in its core conclusion: the mail platform is not 10/10 production-grade, SaaS-grade, or enterprise-grade.

However, the deeper validation lowers confidence in three areas:

| Dimension | Third-pass score | Fourth-pass score |
| --- | ---: | ---: |
| Mail transport/deliverability implementation | 6.5 implied | 5.9 |
| SDK/API contract/developer platform | 7.0 implied | 5.0 |
| Supply-chain/release evidence | 5.5 implied | 4.1 |
| Overall production readiness | 5.5 implied | 5.1 |
| Overall enterprise readiness | 5.2 | 4.9 |

The strongest remaining modules are still the core API breadth, queue-based worker design, basic tracking/unsubscribe infrastructure, DKIM signing baseline, admin OIDC baseline, and operational documentation.

The biggest fourth-pass blockers are:
1. API and SDK contract drift.
2. MTA deployment/security gaps.
3. DKIM rotation not connected to signing.
4. Per-domain bounce alignment not implemented.
5. Group unsubscribe enforcement missing.
6. Incomplete OpenAPI route parity.
7. Weak supply-chain provenance.
8. Non-enforced SBOM/release evidence.

This means the platform is better described as a strong prototype/early production candidate with many production-shaped components, not a finished 10/10 SaaS/enterprise mail platform.

# 24. Fifth-Pass Agent-Assisted Validation

Date: 2026-06-26

Scope of this pass:
- Billing, payments, subscriptions, quotas, usage metering, invoices, refunds, tax, dunning, and SaaS commercial readiness.
- Observability, SRE, health/readiness, alerts, dashboards, logs/redaction, tracing, SLOs, runbooks, load testing, and failover evidence.
- Data integrity, persistence, migrations, RLS, queues/DLQ, ClickHouse, object storage, privacy erasure/export, retention, backups, and DR.

Method:
- Three read-only agents inspected independent repository slices.
- Local code/docs were cross-checked against current official references.
- This section corrects and deepens the existing report. It does not remove earlier history.

External references used in this pass:

| Source | Why it matters |
| --- | --- |
| Stripe webhook docs: https://docs.stripe.com/webhooks | Confirms raw body + `Stripe-Signature` + endpoint secret verification model. |
| Stripe signature docs: https://docs.stripe.com/webhooks/signature | Confirms raw request body and endpoint secret requirements for signature validation. |
| PayPal Webhooks API: https://developer.paypal.com/docs/api/webhooks/v1/ | Confirms PayPal verification uses transmission headers, cert URL, auth algorithm, webhook ID, and event body/verify endpoint. |
| PayPal webhook integration guide: https://developer.paypal.com/api/rest/webhooks/rest/ | Confirms PayPal webhook verification flow and event listener expectations. |
| Cashfree subscription webhook HMAC: https://www.cashfree.com/docs/api-reference/payments/latest/subscription/webhook-signature | Confirms raw body + `x-webhook-timestamp` + `x-webhook-signature` HMAC model. |
| Cashfree payment webhook setup: https://www.cashfree.com/docs/payments/webhooks | Shows millisecond-style timestamp examples and raw-payload signing model. |
| Kubernetes probes: https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/ | Confirms readiness/liveness/startup probe semantics and why route mismatch is production-critical. |
| Prometheus alerting rules: https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/ | Confirms rule behavior and need for valid expressions/labels. |
| Prometheus rule unit testing: https://prometheus.io/docs/prometheus/latest/configuration/unit_testing_rules/ | Confirms alert rule tests can be CI-gated. |
| Google SRE SLOs: https://sre.google/sre-book/service-level-objectives/ | Confirms SLOs and error budgets are explicit reliability tools, not just k6 thresholds. |
| Google SRE alerting on SLOs: https://sre.google/workbook/alerting-on-slos/ | Confirms burn-rate alerting as a reliability practice. |
| OpenTelemetry signals: https://opentelemetry.io/docs/concepts/signals/ | Confirms traces, metrics, and logs are distinct telemetry signals. |
| OpenTelemetry context propagation: https://opentelemetry.io/docs/concepts/context-propagation/ | Confirms cross-service trace correlation expectations. |
| OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html | Confirms logs can contain sensitive data and must be protected from misuse/tampering. |

## 24.1 Fifth-Pass Score Corrections

The later report sections are directionally accurate, but the fifth pass finds that billing/commercial SaaS, SRE proof, and data-integrity/DR should be scored more sharply.

| Module | Previous direction | Fifth-pass corrected score | Why |
| --- | ---: | ---: | --- |
| Billing provider abstraction | 6.5 implied | 6.0 | Good seam, but provider identity is still stored through Stripe-named columns and commercial catalog governance is weak. |
| Stripe checkout/customer/portal | 6.5 | 6.5 | Real REST provider exists; still lacks full sandbox/release evidence and invoice lifecycle depth. |
| Stripe webhook verification | 7.5 | 8.0 | Raw payload + `Stripe-Signature` + endpoint secret + timestamp tolerance matches Stripe's documented model reasonably well. |
| Stripe metered usage reporting | 7.0 implied | 6.5 | Usage reporting exists, but invoice lifecycle/reconciliation correction is incomplete. |
| PayPal provider scaffold | 6.0 implied | 4.5 | Checkout scaffold exists, but usage reporting is no-op and portal is a generic redirect. |
| PayPal webhook verification | 5.5 | 3.5 | Current code uses custom HMAC, not official PayPal transmission/certificate/webhook verification. |
| Cashfree provider scaffold | 6.0 implied | 4.5 | Subscription scaffold exists, but usage reporting is no-op and portal is generic. |
| Cashfree webhook verification | 6.5 | 5.0 | HMAC shape exists, but timestamp handling is likely wrong against millisecond examples and lacks sandbox fixture proof. |
| Billing webhook idempotency | 8.0 implied | 6.5 | Replay guard exists, but uniqueness is not provider-scoped and no replay/error state machine exists. |
| Subscription lifecycle mapping | 7.0 implied | 5.5 | Basic create/update/delete handling exists; failed-payment/dunning/proration/status nuance is weak. |
| Plan changes/proration | 6.0 implied | 4.0 | Checkout accepts caller-supplied `price_id`; no DB-backed catalog, entitlement diff, proration preview, or downgrade workflow. |
| Quotas and usage enforcement | 7.0 | 8.0 | Atomic Redis quota reservation seeded from durable usage is a strong piece. |
| Entitlement enforcement | 6.0 implied | 5.5 | Send blocks `canceled`, but `past_due`, `unpaid`, `incomplete`, grace periods, and feature entitlements are not centrally enforced. |
| Invoices/reconciliation | 6.0 implied | 4.0 | Invoice table and drift detection exist, but provider invoice ingestion, line items, PDFs, status machine, and correction flow are missing. |
| Refunds/credits | not explicit | 1.5 | No provider refund or credit-note workflow. |
| Tax/VAT/GST | not explicit | 0.5 | No tax IDs, tax calculation/provider integration, jurisdiction policy, or finance export. |
| Dunning/failed-payment lifecycle | not explicit | 2.5 | No full payment-failed grace/suspension/recovery/cancel flow. |
| Commercial SaaS readiness | 6.0 implied | 4.5 | Good skeleton, but not a complete revenue platform. |
| Observability/SRE overall | 7.0 implied | 6.0 | Real metrics and runbooks exist, but several claims are aspirational and there is no SLO/error-budget/load/failover evidence gate. |
| Metrics instrumentation | 7.0 | 7.0 | Core Prometheus counters exist; missing HTTP SLIs, queue age, outbox age, DB/Redis saturation, burn-rate metrics. |
| Metrics endpoint security | 8.0 | 8.0 | Token guard fails closed in production; good base. |
| Prometheus alerts | 7.0 implied | 6.0 | Useful rules exist; no promtool CI, no alert tests, and some rules depend on missing signals. |
| Grafana dashboards | 6.5 implied | 5.5 | Dashboards exist but reference non-emitted metrics. |
| Logs/redaction | 5.8 | 4.5 | Request IDs exist; no centralized Pino redaction, and logs can contain email/provider payload data. |
| Tracing/OpenTelemetry | 6.5 | 6.5 | SDK and queue propagation exist; collector/sampling/deployment proof absent. |
| SLOs/error budgets | 5.0 implied | 3.5 | k6 thresholds are not formal SLOs/error budgets; no burn-rate alerts. |
| Health/readiness | 7.0 implied | 6.0 | API/worker checks exist; tracker Helm probes point to a route tracker does not implement. |
| Queue/backpressure | 7.0 | 7.0 | Depth-based backpressure exists; lacks age-based SLO control and autoscaling evidence. |
| Load testing | 7.0 implied | 5.5 | k6 asset exists; no CI/staging execution gate or release evidence. |
| Chaos/failover/DR | 4.5 | 3.5 | Local restore script exists; no Redis/Postgres failover, worker crash, SMTP outage, or network partition game-day evidence. |
| Postgres schema/indexes/constraints | 7.0 | 7.0 | Good base, but RLS fail-open and missing FKs/consistency constraints remain. |
| Migration runner | 7.0 | 7.0 | Checksums/advisory lock exist; no expand/contract policy and app containers still run migrations. |
| Tenant RLS enforcement | 4.5 | 4.0 | Policies allow all rows when tenant context is unset; API routes do not use `withTenant()`. |
| Send transaction/outbox | 7.0 implied | 8.0 | Stronger than earlier framing: send DB transaction + durable outbox + `SKIP LOCKED` + deterministic BullMQ job IDs. |
| Redis quota/backpressure | 7.0 | 7.0 | Atomic Lua counters exist; Redis HA/failover proof and durable repair are missing. |
| BullMQ retries/DLQ | 7.0 implied | 6.5 | Functional retries/DLQ exist; DLQ is Redis-backed, stores raw payloads, and replay governance is weak. |
| API idempotency | 7.5 implied | 8.0 | DB-backed `(customer_id, idempotency_key)` uniqueness is strong; stuck-key repair could improve. |
| ClickHouse ingestion/reconciliation | 5.5 | 5.0 | Code explicitly drops rows on ClickHouse outage/circuit-open; no durable analytics outbox. |
| Object storage | 7.0 implied | 6.5 | S3-compatible body store exists; production IAM/lifecycle/replication/config guard proof missing. |
| Privacy/export/erasure | 5.8 | 5.5 | Later correction was close; object delete is best-effort and complete status is written before all stores finish. |
| Retention | 6.5 | 6.0 | Retention job exists but can delete audit rows and lacks legal hold/data inventory. |
| Audit durability | 5.0 | 5.0 | Audit table exists; safe writes can be swallowed and no immutable/tamper-evident sink exists. |
| Backup/restore/DR | 4.5 | 4.0 | Local Postgres restore drill only; no full workload RPO/RTO/restore proof. |
| Multi-region/data-loss posture | not explicit | 3.5 | No regional failover, replication proof, or workload-specific RPO/RTO. |

## 24.2 Billing And SaaS Commerce Deep Hierarchy

### 24.2.1 Provider Abstraction

Current score: 6.0/10

What is valid:
- A `BillingProvider` seam exists.
- Stripe, PayPal, Cashfree, and mock providers exist.
- Checkout and portal methods are normalized behind one interface.

What blocks 10/10:
- Provider identity is still stored in Stripe-named fields such as `stripe_customer_id` and `stripe_subscription_item_id`.
- The same interface pretends all providers support metered usage, while PayPal and Cashfree implementations are no-ops.
- There is no provider capability matrix.
- No provider sandbox certification suite proves each provider works against live sandbox behavior.

10/10 solution:
1. Rename billing identity columns to provider-neutral names or add proper provider identity tables.
2. Add `billing_provider_accounts` with provider, environment, customer ID, subscription ID, metered item ID, and capability flags.
3. Add provider capability declarations: checkout, portal, metered usage, tax, refunds, invoices, dunning.
4. Make unsupported provider actions fail with explicit typed errors instead of silent no-ops.
5. Add sandbox certification tests per provider.

### 24.2.2 Stripe Billing

Current score: 6.5/10 overall, 8.0/10 for webhook signature verification

What is valid:
- Stripe webhook verification uses raw payload, `Stripe-Signature`, endpoint secret, HMAC comparison, and timestamp tolerance.
- Stripe checkout/customer/portal calls exist.
- Stripe metered usage reporting exists with idempotency key support.

What blocks 10/10:
- No official Stripe SDK use; REST implementation may miss edge cases and typed API evolution.
- No provider invoice ingestion.
- No invoice line item reconciliation against actual Stripe invoice objects.
- No hosted invoice URL/PDF storage.
- No refund/credit note/tax handling.
- No subscription schedule/proration preview/update flow.

10/10 solution:
1. Use official Stripe library for webhook construct/verification or add fixture parity tests against official samples.
2. Add Stripe sandbox E2E covering checkout, subscription lifecycle, invoice created/finalized/paid/payment failed, duplicate webhook, stale signature, and refund.
3. Store Stripe invoice IDs, statuses, URLs, line items, amounts, currency, tax, and payment state.
4. Add proration preview before plan changes.
5. Add refund/credit note workflows and audit.
6. Add reconciliation that can correct drift, not only report it.

### 24.2.3 PayPal Billing

Current score: 4.5/10 provider scaffold, 3.5/10 webhook verification

What is valid:
- PayPal subscription creation scaffold exists.
- PayPal OAuth token flow exists.
- PayPal custom ID mapping attempts to link provider event to internal customer.

What is invalid or too weak:
- Webhook verification is custom HMAC using a local secret.
- Official PayPal verification requires PayPal transmission headers, certificate URL, auth algorithm, webhook ID, and event body, or PayPal's verify endpoint.
- Usage reporting is a no-op.
- Portal support is a generic PayPal autopay URL.
- Plan mapping is env JSON, not a governed catalog.

10/10 solution:
1. Implement PayPal `verify-webhook-signature` flow or certificate verification with cert URL allowlisting.
2. Validate `PAYPAL-AUTH-ALGO`, `PAYPAL-CERT-URL`, `PAYPAL-TRANSMISSION-ID`, `PAYPAL-TRANSMISSION-TIME`, `PAYPAL-TRANSMISSION-SIG`, webhook ID, and raw event body.
3. Add sandbox fixtures for all supported PayPal subscription events.
4. Add explicit provider capability flag that PayPal does not support Stripe-style usage records.
5. Add PayPal invoice/payment capture state ingestion where applicable.
6. Replace generic portal link with documented account-management UX and support workflow.

### 24.2.4 Cashfree Billing

Current score: 4.5/10 provider scaffold, 5.0/10 webhook verification

What is valid:
- Cashfree provider scaffold exists.
- Cashfree HMAC verification shape uses raw body, timestamp, secret, and base64 HMAC.
- Cashfree subscription event mapping exists.

What is weak:
- Code multiplies `x-webhook-timestamp` by 1000 as if timestamp is seconds.
- Cashfree examples show millisecond timestamps such as `1617695238078` and `1746427759733`.
- Current tests generate seconds, so they can pass while live webhooks fail.
- Usage reporting is a no-op.
- Portal support is a generic merchant URL.
- No sandbox certification exists.

10/10 solution:
1. Fix timestamp parsing to accept documented millisecond format and reject stale/replayed events.
2. Add official Cashfree sample fixtures.
3. Add sandbox tests for subscription created/activated/payment success/payment failed/canceled/expired.
4. Add replay prevention using provider event IDs or payload hash if event ID is absent.
5. Make no-op metering explicit in provider capability metadata.
6. Build Cashfree invoice/payment state ingestion if Cashfree is a supported production provider.

### 24.2.5 Plan Catalog, Entitlements, And Checkout Validation

Current score: 4.0/10

What is valid:
- `TIER_BY_PRICE` maps price IDs to tier/quota.
- Send path enforces quota and canceled billing status.

What blocks 10/10:
- `TIER_BY_PRICE` is hardcoded placeholder catalog.
- Checkout accepts caller-supplied `price_id`.
- No DB-backed plan catalog with provider/environment/product/price/status.
- No central entitlement engine.
- No feature gates for paid-only features.
- No consistent handling of `past_due`, `unpaid`, `incomplete`, trial expiry, grace period, and manual overrides.

10/10 solution:
1. Add `plans`, `plan_prices`, `entitlements`, and `customer_entitlements` tables.
2. Validate checkout `price_id` against active catalog rows for the customer's selected provider.
3. Add central `assertEntitlement(customerId, feature, usage)` helper.
4. Gate sending, analytics retention, webhooks, team seats, support level, API rate limits, and templates through entitlement checks.
5. Add dunning state transitions: payment failed -> grace -> restricted -> suspended -> canceled/recovered.
6. Add admin override with expiry, reason, and durable audit.

### 24.2.6 Invoices, Refunds, Credits, Tax, And Finance Readiness

Current score: 4.0/10 invoices, 1.5/10 refunds/credits, 0.5/10 tax

What is valid:
- `invoices` table exists.
- Metering drift detection exists.
- Admin reconcile endpoint can surface drift.

What is missing:
- No provider invoice ingestion.
- No invoice line item model.
- No invoice PDF/hosted URL.
- No payment state machine.
- No refund API.
- No credit notes.
- No tax ID capture.
- No GST/VAT/sales tax integration.
- No revenue export.
- No automated drift correction.

10/10 solution:
1. Ingest provider invoice events and store invoice IDs, statuses, amounts, currency, tax, line items, hosted URL, and PDF URL.
2. Add `invoice_line_items`, `payments`, `refunds`, and `credit_notes`.
3. Add customer tax profile: country, region, tax IDs, reverse-charge flag, exemption status.
4. Integrate a tax provider or provider-native tax features.
5. Add finance exports for invoices, payments, refunds, taxes, and revenue recognition.
6. Add reconciliation that opens correction jobs and notifies finance/support.

## 24.3 Observability, SRE, And Incident Readiness Deep Hierarchy

### 24.3.1 Metrics And SLIs

Current score: 7.0/10

What is valid:
- Prometheus registry and default metrics exist.
- Core counters for accepted/sent/delivered/bounced/complaints/webhooks/DLQ/backpressure exist.
- Metrics endpoints are token-protected and fail closed in production.

What is missing:
- HTTP request duration and request count SLIs.
- Queue oldest job age.
- Outbox oldest pending age.
- DB pool saturation metrics.
- Redis/BullMQ error counters.
- Webhook queue age.
- Tracker event latency.
- Real DKIM failure metric.
- Real DSN parser metric emission from Haraka.
- Burn-rate metrics for SLO alerting.

10/10 solution:
1. Add `mp_http_request_duration_seconds` and `mp_http_requests_total`.
2. Add queue age and outbox age gauges.
3. Add DB pool, Redis/BullMQ, and transport error metrics.
4. Implement `mp_dkim_sign_failures_total`.
5. Emit `mp_dsn_parse_total` from inbound Haraka.
6. Define SLIs for API availability, send enqueue latency, queue age, delivery latency, webhook latency, tracker latency, provider error rate, and DB saturation.

### 24.3.2 Prometheus Alerts And Grafana Dashboards

Current score: 6.0/10 alerts, 5.5/10 dashboards

What is valid:
- Alert rules exist for bounce rate, complaint rate, queue backlog, backpressure, slow API key verification, metering drift, DSN parse failures, service down, DLQ growth, and webhook failures.
- Grafana dashboards exist.

What is overstated:
- The production checklist claims alerts for every operational hazard.
- No promtool validation appears in CI.
- No alert unit tests exist.
- Dashboards reference metrics that are not emitted.
- No burn-rate alerts exist.
- No owner/runbook URL/severity discipline across every alert is proven.

10/10 solution:
1. Add `promtool check rules` in CI.
2. Add Prometheus alert unit tests for every critical alert.
3. Remove dashboard panels for non-existent metrics or implement the metrics.
4. Add burn-rate alerts using Google SRE-style error-budget windows.
5. Add `runbook_url`, `owner`, `service`, and `severity` labels to all alerts.
6. Store alert fire-drill evidence quarterly.

### 24.3.3 Health, Readiness, And Kubernetes Probes

Current score: 6.0/10

What is valid:
- API has `/health`, `/ready`, and dependency checks.
- Worker exposes `/health` and `/ready`.
- Helm has probes for API and worker.

Concrete production bug:
- Tracker Helm probes call `/live`.
- Tracker service only registers `/health` and `/metrics`.
- A Kubernetes deployment using the current tracker chart can fail liveness/readiness even if the tracker is healthy.

10/10 solution:
1. Add tracker `/live` and `/ready`.
2. Make tracker `/ready` check dependencies it actually requires.
3. Change tracker Helm readiness to `/ready` and liveness to `/live`.
4. Add startup probes for API, worker, and tracker.
5. Add Helm template tests that verify probe paths exist in the service code or contract manifest.
6. Add Dockerfile `HEALTHCHECK` where Docker runtime is used outside Kubernetes.

### 24.3.4 Logs And Redaction

Current score: 4.5/10

What is valid:
- Pino logging exists.
- Request IDs exist.
- Some structured logging is present.

What blocks 10/10:
- No centralized Pino `redact` config.
- Worker logs can include recipient email/provider responses.
- Event payloads may include IP, user agent, SMTP response, and metadata.
- No log capture tests prove seeded PII is redacted.
- No documented log retention, access control, or tamper protection.

10/10 solution:
1. Add shared logger factory with mandatory redaction list.
2. Redact auth headers, cookies, API keys, emails, message body fields, webhook payloads, provider responses, IP/user-agent where required, and metadata.
3. Add tests that logs from API/worker/tracker never contain seeded PII/secrets.
4. Add structured event IDs for support without exposing raw PII.
5. Ship logs to a controlled sink with retention, RBAC, and tamper resistance.
6. Document support/debug access workflow.

### 24.3.5 Tracing And OpenTelemetry

Current score: 6.5/10

What is valid:
- OpenTelemetry tracing shim exists.
- API injects trace context into queue jobs.
- Worker continues remote context.

What is missing:
- No collector/Tempo/Jaeger deployment proof.
- No sampling policy.
- No trace/log correlation policy.
- No sanitized span attribute policy.
- No evidence traces for API -> outbox -> worker -> transport -> event -> webhook.

10/10 solution:
1. Deploy OpenTelemetry Collector.
2. Add environment-specific sampling rules.
3. Add trace IDs to logs.
4. Sanitize span attributes.
5. Add manual spans for API accept, outbox drain, send worker, transport handoff, Haraka event, event worker, webhook delivery, and billing webhook handling.
6. Add staging trace evidence to release artifacts.

### 24.3.6 Load, Synthetic, Chaos, And Incident Evidence

Current score: 5.5/10 load, 4.5/10 synthetics, 3.5/10 chaos/failover

What is valid:
- k6 script exists.
- Runbooks exist for queue backpressure, DLQ, blocklist, pool pause, IP warmup, and key compromise.
- Local backup restore script exists.

What blocks 10/10:
- No CI/staging load-test gate.
- No release artifact with k6 summary.
- No end-to-end synthetic send/open/click/webhook check.
- No Redis/Postgres failover test.
- No worker-crash-during-send test.
- No SMTP outage test.
- No webhook target outage game day.
- No network partition simulation.

10/10 solution:
1. Add `npm run load:staging`.
2. Store k6 summary and Grafana screenshots in release evidence.
3. Add synthetic path: API send -> worker -> delivery simulator -> event -> webhook.
4. Add chaos tests using Toxiproxy or equivalent.
5. Run quarterly game days and store evidence.
6. Add incident templates with owner, timeline, customer impact, and follow-up tasks.

## 24.4 Data Integrity, Persistence, And DR Deep Hierarchy

### 24.4.1 Postgres, Migrations, And RLS

Current score: 7.0/10 schema, 7.0/10 migration runner, 4.0/10 tenant RLS

What is valid:
- Schema has many useful indexes and uniqueness constraints.
- Migration runner uses checksum tracking and advisory lock.
- RLS migration exists.

What is invalid or weak:
- RLS policies allow tenant rows when `current_tenant_id()` is null.
- API routes set `req.auth` but do not consistently run inside `withTenant()`.
- App containers run migrations at startup while Helm also defines migration job.
- No expand/contract migration policy.
- No migration risk labels or rollback playbook.

10/10 solution:
1. Remove `OR current_tenant_id() IS NULL` from tenant RLS policies.
2. Add explicit service-role policies for workers/admin/migrations.
3. Use a non-BYPASSRLS API DB role.
4. Wrap every tenant route in `withTenant()`.
5. Fail production boot if RLS enforcement check fails.
6. Remove migrations from API/worker/tracker Docker CMDs.
7. Use one release migration job with expand/contract validation.
8. Add migration rollback/forward-fix playbooks.

### 24.4.2 Send Transaction, Outbox, Queues, And Idempotency

Current score: 8.0/10 send outbox, 7.0/10 Redis quota/backpressure, 6.5/10 DLQ, 8.0/10 API idempotency

What is stronger than earlier framing:
- Send path inserts messages, queued events, and `send_outbox` in one DB transaction.
- Outbox drain uses `FOR UPDATE SKIP LOCKED`.
- BullMQ job IDs are deterministic by message ID.
- API idempotency uses DB uniqueness on `(customer_id, idempotency_key)`.
- Quota reservation is atomic in Redis and seeded from durable `usage_daily`.

What blocks 10/10:
- DLQ is Redis-backed and stores raw payloads.
- DLQ replay lacks dry run, durable audit, root-cause grouping, and two-person approval.
- Queue/backpressure relies heavily on depth, not oldest age.
- Redis HA/failover evidence is missing.
- Idempotency stuck-key repair is limited.

10/10 solution:
1. Add durable DLQ metadata table storing minimal IDs and redacted payload excerpts.
2. Add DLQ replay dry run, idempotent replay job IDs, root-cause grouping, and audit.
3. Add two-person approval for destructive DLQ purge.
4. Add queue age metrics and age-based backpressure/autoscaling.
5. Add Redis failover tests and counter drift reconciliation.
6. Add idempotency stuck-key sweeper and dashboard.

### 24.4.3 ClickHouse Analytics

Current score: 5.0/10

What is valid:
- ClickHouse event sink exists.
- Batching and circuit breaker exist.
- Postgres remains source of truth for operational events.

What is weak:
- Code explicitly drops ClickHouse rows on outage/circuit-open.
- No durable analytics outbox.
- No checkpointed retry.
- No reconciliation by tenant/day/event type.
- No ClickHouse erasure path.
- No ClickHouse backup/restore proof.

10/10 solution:
1. Add `analytics_outbox` written transactionally with Postgres events.
2. Add analytics worker with checkpointed retries.
3. Add tenant/day/event-type reconciliation.
4. Alert on analytics drift.
5. Add ClickHouse erasure workflow and tombstone handling.
6. Add ClickHouse backup/restore drill and release evidence.

### 24.4.4 Object Storage

Current score: 6.5/10

What is valid:
- Inline, filesystem, and S3-compatible stores exist.
- Content-addressed object keys and body hash/size metadata exist.
- Delete interface exists.

What blocks 10/10:
- Production config guard does not validate body storage mode, bucket, region, endpoint, IAM, encryption, lifecycle, or replication.
- No MinIO CI proof for put/get/delete/failure.
- No orphan cleanup after object write succeeds and DB transaction later fails.
- No object-store restore drill.
- No lifecycle/retention/legal-hold integration.

10/10 solution:
1. Add config guard for `BODY_STORAGE=s3` settings.
2. Prefer IAM roles/workload identity over static credentials.
3. Add bucket encryption, lifecycle, versioning/replication policy docs and checks.
4. Add MinIO integration tests for put/get/delete/failure.
5. Add orphan object sweeper.
6. Add object-store backup/restore drill.
7. Integrate object retention with privacy/retention/legal-hold policy.

### 24.4.5 Privacy, Retention, And Audit Durability

Current score: 5.5/10 privacy, 6.0/10 retention, 5.0/10 audit durability

What is valid:
- Privacy delete/export endpoints exist.
- Retention job exists.
- Audit table exists.

What is weak:
- Deletion request is marked completed inside the DB transaction before object deletion.
- Object delete failures are logged only.
- Export covers selected messages/events/suppressions, not the full data inventory.
- ClickHouse, queues/DLQ, logs/traces, backups, and legal holds are not covered.
- Retention can delete audit rows.
- `recordAuditSafe` style writes can be swallowed.
- No immutable/tamper-evident audit sink.

10/10 solution:
1. Build full data inventory for every PII store.
2. Add async erasure workflow with per-store status.
3. Do not mark erasure complete until required stores are complete or legally pending.
4. Add legal hold and tombstone support.
5. Export all relevant data categories with schema version.
6. Add `audit_outbox`.
7. Export audit to SIEM or S3 Object Lock.
8. Hash-chain audit rows.
9. Block retention deletion until audit is exported.
10. Fail critical admin/security/billing actions if durable audit cannot be recorded.

### 24.4.6 Backup, Restore, DR, And Multi-Region

Current score: 4.0/10 DR, 3.5/10 multi-region/data-loss posture

What is valid:
- Local Postgres backup/restore drill script exists.
- Script checks schema migration count and row counts.

What is missing:
- Workload-specific RTO/RPO.
- Managed Postgres PITR evidence.
- Redis rebuild/failover drill.
- ClickHouse backup/restore.
- Object-store restore.
- Queue recovery drill.
- Multi-AZ/multi-region architecture.
- Signed restore evidence.
- Release gate that requires restore evidence.

10/10 solution:
1. Define RTO/RPO for API, worker, tracker, Postgres, Redis, BullMQ, object storage, ClickHouse, Haraka, billing, and webhooks.
2. Add Postgres PITR restore drill.
3. Add Redis failover/rebuild drill.
4. Add ClickHouse backup/restore drill.
5. Add object-store restore drill.
6. Add queue drain/replay recovery drill.
7. Store signed DR evidence per release or quarter.
8. Add multi-region/data residency design and test it before claiming enterprise readiness.

## 24.5 Fifth-Pass Invalid-Claim Ledger

| Claim or implied posture | Fifth-pass verdict | Evidence/reason |
| --- | --- | --- |
| PayPal webhook verification is production-grade | Incorrect | Code uses custom HMAC; official PayPal verification requires transmission headers/cert/auth algorithm/webhook ID/event body or verify endpoint. |
| Cashfree webhook verification is proven | Too generous | HMAC shape exists, but code treats timestamp as seconds while Cashfree examples use milliseconds. |
| Billing launch readiness is near SaaS-grade | Too generous | No DB-backed catalog, dunning, tax, refunds, invoice lifecycle, or entitlement engine. |
| Quota enforcement is weak | Too harsh if stated broadly | Redis Lua reservation seeded from durable usage is one of the stronger modules. |
| Helm probes are mostly complete | Incorrect | Tracker Helm probes point to `/live`; tracker implements `/health` and `/metrics`. |
| Prometheus alerts cover every hazard | Overstated | No burn-rate alerts, no HTTP SLO alerts, no queue-age/outbox-age alerts, no promtool/alert tests. |
| Dashboards prove DKIM/DSN observability | Overstated | Some dashboard/alert metrics are not emitted by code. |
| Logging is production-safe because request IDs exist | Overstated | No central redaction policy and worker logs can include PII/provider data. |
| ClickHouse is production analytics-grade | Overstated | Writes are best-effort and dropped during outage/circuit-open. |
| RLS materially protects tenant data | Overstated | Current policies fail open when tenant context is unset and API does not consistently set DB tenant context. |
| Privacy erasure is complete | Overstated | Object deletion is best-effort and other stores are not fully covered. |
| DR evidence is sufficient | Overstated | Local Postgres restore script is useful but not workload-wide DR evidence. |
| Send outbox is weak | Too harsh if stated | Send transaction/outbox design is comparatively strong. |

## 24.6 Fifth-Pass 10/10 Remediation Backlog

Priority 0 - production correctness:
1. Fix PayPal webhook verification to official PayPal verification.
2. Fix Cashfree timestamp handling and add official fixtures.
3. Fix tracker Helm probe route mismatch.
4. Make RLS fail closed and wire `withTenant()` through API routes.
5. Stop app containers from running migrations at startup.
6. Add durable analytics outbox for ClickHouse.

Priority 1 - SaaS commercial readiness:
1. Add DB-backed plan catalog and checkout validation.
2. Add central entitlement engine.
3. Add failed-payment dunning lifecycle.
4. Add invoice ingestion and payment state machine.
5. Add refunds, credits, tax IDs, tax calculation, and finance exports.
6. Add provider sandbox certification suite.

Priority 2 - SRE readiness:
1. Add HTTP/queue/outbox/DB/Redis SLIs.
2. Add burn-rate alerts.
3. Add promtool and alert unit tests in CI.
4. Make dashboards only reference emitted metrics.
5. Add centralized log redaction and log PII tests.
6. Add staging load and synthetic checks.
7. Add chaos/failover game-day evidence.

Priority 3 - data governance and DR:
1. Harden DLQ with redaction, durable metadata, dry-run replay, and audit.
2. Add object-store production config guard and MinIO CI.
3. Build full erasure/export data inventory and per-store erasure workflow.
4. Make audit immutable/tamper-evident.
5. Add workload-specific RTO/RPO and restore drills for Postgres, Redis, ClickHouse, object store, and queues.
6. Store signed release/DR evidence.

## 24.7 Fifth-Pass Verdict

The report remains valid in its main conclusion: the platform is not 10/10 production-grade, SaaS-grade, or enterprise-grade.

The fifth pass changes the nuance:
- The send transaction/outbox, quota reservation, API idempotency, Stripe webhook verification, and metrics endpoint security are stronger than a generic prototype.
- Billing/commercial SaaS readiness, SRE proof, tenant isolation, analytics durability, privacy erasure, and DR evidence are weaker than a 10/10 enterprise platform requires.

Updated readiness view:

| Dimension | Fourth-pass score | Fifth-pass score |
| --- | ---: | ---: |
| Billing/commercial SaaS readiness | 6.0 implied | 4.5 |
| Observability/SRE readiness | 7.0 implied | 6.0 |
| Data integrity/persistence readiness | 6.0 implied | 5.7 |
| Tenant isolation/RLS readiness | 4.5 | 4.0 |
| Backup/DR readiness | 4.5 | 4.0 |
| Overall production readiness | 5.1 | 5.0 |
| Overall enterprise readiness | 4.9 | 4.8 |

The honest current state is: a serious early production candidate with several strong internal mechanisms, but still missing the commercial, operational, isolation, evidence, and data-governance controls expected from a 10/10 SaaS/enterprise mail platform.

# 25. Sixth-Pass Agent-Assisted Validation

Date: 2026-06-26

Scope of this pass:
- Abuse prevention, deliverability reputation, KYC, review queue, classifier, DNSBL, IP warmup, sending pools, Postmaster/SNDS, rate limits, and batch-send parity.
- Deployment/runtime posture: Helm, static K8s manifests, production compose, NetworkPolicy, pod security, autoscaling, ingress/TLS, secrets, runtime images, and Haraka deployment.
- Testing/QA evidence: unit/E2E coverage, CI execution, route coverage, security tests, load tests, contract tests, migration tests, SDK/docs tests, mocks vs real services, and production readiness validation.

Method:
- Three read-only agents inspected independent slices.
- Local evidence was cross-checked against current platform standards and official operational guidance.
- This section appends new corrections; it does not rewrite earlier findings.

External references used in this pass:

| Source | Why it matters |
| --- | --- |
| Google sender guidelines: https://support.google.com/a/answer/81126 | Current Gmail sender expectations for SPF/DKIM/DMARC, one-click unsubscribe, spam rates, PTR, TLS, and bulk sender behavior. |
| Microsoft sender support/SNDS/JMRP: https://sendersupport.olc.protection.outlook.com/ | Current Microsoft deliverability surfaces relevant to SNDS/JMRP monitoring and reputation workflows. |
| OWASP API Security Top 10 2023: https://owasp.org/API-Security/editions/2023/en/0x11-t10/ | Confirms API inventory, auth, and unrestricted resource/flow risks relevant to route coverage and contract drift. |
| Kubernetes Pod Security Standards: https://kubernetes.io/docs/concepts/security/pod-security-standards/ | Defines baseline/restricted pod security expectations such as non-root, seccomp, capability drops, and privilege escalation controls. |
| Kubernetes probes: https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/ | Confirms why liveness/readiness route and port mismatch is a deployment correctness issue. |
| Kubernetes NetworkPolicy: https://kubernetes.io/docs/concepts/services-networking/network-policies/ | Baseline for network segmentation and egress restrictions. |
| k6 thresholds: https://grafana.com/docs/k6/latest/using-k6/thresholds/ | Confirms thresholds only enforce quality when the k6 run is actually executed in CI/staging. |

## 25.1 Sixth-Pass Score Corrections

The report is still directionally correct. The sixth pass lowers confidence mainly in three places: practical deliverability controls, deployment/runtime hardening, and QA evidence gates.

| Module | Previous direction | Sixth-pass corrected score | Why |
| --- | ---: | ---: | --- |
| Abuse prevention overall | 6.5 implied | 6.0 | Real controls exist, but operational KYC, classifier feedback, and review workflows are incomplete. |
| KYC/onboarding abuse gates | 7.5 implied | 4.5 | `kyc_level` and new-account caps exist, but no full verification/risk state machine. |
| Rate limits/quota/backpressure | 7.0 | 7.0 | This remains a relatively strong area. |
| Content scan/classifier | 6.5 implied | 5.5 | Regex + Bayesian baseline exists; no production ML feedback/evaluation loop. |
| Review queue | 8.0 implied | 6.5 | Basic approve/reject exists, but workflow, transactions, assignment, SLA, and classifier feedback are weak. |
| Recipient validation/list quality | 6.5 implied | 5.5 | List scoring exists, but real-time/large-scale validation and source risk proof are missing. |
| Suppressions/unsubscribe | 6.5 | 6.5 | Global suppressions are stronger than group unsubscribe enforcement, which remains incomplete. |
| Bounce/complaint automation | 7.0 | 7.0 | DSN/FBL parsing and suppression paths exist; metrics/triage still incomplete. |
| DNSBL/blocklist monitoring | 6.5 | 6.5 | DNSBL checks exist; operational evidence and incident workflow depth remain missing. |
| Reputation guard | 7.0 implied | 6.0 | Pool health action exists; it is not yet domain/ISP/source-IP aware enough for 10/10. |
| IP warmup | 7.0 implied | 5.0 | Single-send pool warmup exists; batch parity and per-IP source binding are weak. |
| Sending pools/pool routing | 7.5 implied | 4.5 | `ip_pool` metadata exists, but no visible source-IP binding/transport plugin. |
| Google Postmaster/Microsoft SNDS | 5.5 earlier gap | 6.5 | Credentialed ingestion code and tests exist; live proof/dashboard evidence still missing. |
| Overall deliverability launch readiness | 6.5 implied | 5.5 | Strong skeleton; not yet battle-proven or complete for high-volume sending. |
| Helm chart overall | 7.5 implied | 6.2 | Good ingredients, but probe/port bugs, no pod security, no Haraka, no KEDA, and weak cert-manager integration. |
| Static `infra/k8s` manifests | 6.5 implied | 5.5 | Useful reference; uses `latest`, no NetworkPolicy/pod security, placeholders, and missing Haraka. |
| `docker-compose.production.yml` | 6.5 implied | 5.4 | Good env enforcement overlay, but app healthchecks/restart policies are absent. |
| Deployment topology | 6.5 implied | 5.5 | Helm/K8s deploy API/worker/tracker only; production MTA topology is incomplete. |
| NetworkPolicy | 7.5 implied | 5.2 | Helm default deny exists, but egress is broad port-only and static K8s has none. |
| Secrets management | 6.5 implied | 5.8 | Secret references exist; no ExternalSecrets/SealedSecrets/Vault implementation. |
| Config guard | 6.0 | 6.0 | Good core secret checks; missing storage/KMS/ClickHouse/RLS/TLS/provider completeness checks. |
| Pod security | not explicit | 3.0 | Helm/static workloads lack restricted pod security context. |
| Resource limits | 7.5 | 7.5 | Helm/static resources are a real positive. |
| Autoscaling | 6.5 implied | 6.0 | CPU HPAs exist; no queue-depth/queue-age autoscaling. |
| TLS/Ingress/cert management | 6.5 implied | 5.5 | Static cert-manager has placeholders; Helm references TLS secrets without issuer integration. |
| Runtime/image hardening | 5.5 | 5.0 | App containers run startup migrations, images not digest-pinned, no healthchecks, broad runtime contents. |
| Overall testing/QA evidence | 7.5 implied | 7.0 | Test surface is broad, but production evidence gates are incomplete. |
| Unit/integration tests | 7.8 | 7.8 | Stronger than many modules. |
| E2E tests | 7.2 | 7.2 | Good breadth; harness drift exists. |
| CI execution | 6.8 | 6.8 | Core packages tested; SDK/docs/load/Helm gates omitted. |
| Route coverage | 6.4 | 6.4 | Missing analytics route in E2E harness is concrete drift. |
| Security tests | 7.6 | 7.6 | Good SSRF/auth/MFA/config tests; DAST/fuzz gaps remain. |
| Load/performance tests | 5.8 | 5.8 | k6 asset exists but is not CI/staging enforced. |
| Contract/OpenAPI tests | 7.2 | 7.2 | Spot tests exist; parity drift remains. |
| SDK tests | 6.4 | 6.4 | SDK tested partially; docs examples and full route coverage absent. |
| Docs/snippet tests | 3.5 | 3.5 | Stale SDK snippets are not compiled. |
| Infra/Helm validation | 4.8 | 4.8 | No Helm/kubeconform/kube-linter/probe smoke CI gate. |

## 25.2 Abuse, Deliverability Reputation, And Sending Controls

### 25.2.1 KYC And Onboarding Abuse Gates

Current score: 4.5/10

What is valid:
- `kyc_level` exists.
- New-account cap exists.
- Email verification exists.
- Send path applies lower caps for weak/new accounts.

What blocks 10/10:
- No CAPTCHA/bot signup defense.
- No disposable email check at signup.
- No payment verification gate.
- No business identity verification workflow.
- No risk score with reasons/evidence.
- No KYC state machine with admin review, expiry, escalation, and audit.

10/10 solution:
1. Add `customer_risk_profile` and `kyc_reviews` tables.
2. Gate volume by email verification, domain verification, payment status, business verification, complaint rate, and risk score.
3. Add signup fraud checks: disposable email, IP/device velocity, CAPTCHA, geo anomalies, known bad domains.
4. Add admin KYC workflow with submitted evidence, review status, reviewer, expiry, and audit.
5. Add progressive sending limits by KYC state.

### 25.2.2 Content Scan, Classifier, And Review Queue

Current score: 5.5/10 classifier, 6.5/10 review queue

What is valid:
- Regex abuse scanner exists.
- Naive Bayesian classifier exists.
- URL/domain reputation check exists.
- Review queue exists.
- Admin approve/reject exists.

What blocks 10/10:
- Training corpus is static.
- Review decisions do not feed back into classifier training.
- No false-positive/false-negative evaluation.
- No model versioning.
- No external URL reputation/threat-intel provider.
- Review queue lacks assignment, priority, SLA, escalation, bulk sampling, and transactional state changes.

10/10 solution:
1. Store reviewer labels and reviewer rationale.
2. Add model training/evaluation pipeline with precision/recall and false-positive targets.
3. Version classifier model and feature set.
4. Add URL reputation and threat-intel feeds.
5. Make approve/reject transactional with message/review/event updates.
6. Add queue assignment, SLA timers, priority, escalation, and audit.
7. Add sampled bulk approval for large campaigns.

### 25.2.3 Sending Pools, Source-IP Routing, And Warmup

Current score: 4.5/10 sending pools, 5.0/10 warmup

What is valid:
- `ip_pool` metadata exists.
- Single send checks pool warmup.
- Pool health action exists.
- Per-IP warmup counters and stage advancement exist.
- Worker sends an `X-MP-IP-Pool` header.

What is weak or missing:
- Haraka only captures/strips the pool header; no visible source-IP binding or pool transport plugin.
- Selected sending IP is not persisted per message.
- Per-IP warmup counters do not appear to enforce actual source-IP selection.
- Batch send lacks full warmup-cap parity.
- No warmup graduation evidence table with delivered/bounced/complained/inbox placement by day.

10/10 solution:
1. Implement real pool-to-source-IP routing in the MTA or transport layer.
2. Persist selected source IP on each message.
3. Enforce per-IP and per-pool daily caps for both single and batch sends.
4. Add queue/transport routing tests proving pool selection affects source IP.
5. Add warmup evidence tables: sent, delivered, bounced, complained, deferred, inbox placement, provider reputation.
6. Require 30-day graduation criteria before lifting caps.
7. Add per-ISP/domain warmup dashboards.

### 25.2.4 Batch Send Abuse Parity

Current score: 5.5/10

What is valid:
- Batch send reserves quota atomically.
- Batch send checks suppressions and trap/disposable status per recipient.
- Batch send has per-message result handling.

What is missing:
- Group unsubscribe enforcement.
- Warmup `canSendOnPool` parity.
- Batched list-quality lookup for the whole batch/campaign.
- Campaign-level anomaly/risk scoring.
- Structured skipped-recipient results for all suppression/reputation reasons.
- Strong quota refunds for every skipped/non-enqueued category.

10/10 solution:
1. Apply the same warmup, group unsubscribe, and list-quality checks to batch sends.
2. Add campaign-level risk scoring before admitting batch.
3. Return structured `skipped` reasons.
4. Refund quota for every non-enqueued recipient.
5. Add E2E tests proving single-send and batch-send parity.

### 25.2.5 Reputation Guard, DNSBL, Postmaster, SNDS

Current score: 6.0/10 reputation guard, 6.5/10 DNSBL/Postmaster/SNDS

What is valid:
- Pool-level bounce/complaint guard exists.
- DNSBL checks exist for Spamhaus, SpamCop, Barracuda, and SORBS.
- Google Postmaster OAuth/service-account ingestion exists.
- Microsoft SNDS ingestion exists.
- Tests cover Postmaster/SNDS ingestion paths.

What is weak:
- Reputation is pool-level, not domain/ISP/source-IP granular enough.
- No live credential proof or dashboard evidence.
- No automated FBL enrollment proof.
- No provider-specific thresholds and circuit breakers.
- No source-IP routing means reputation action may not control the real sending IP.

10/10 solution:
1. Split reputation by sending domain, recipient domain/ISP, source IP, pool, and customer.
2. Add provider-specific thresholds for Gmail, Yahoo, Outlook, corporate MX, and long-tail domains.
3. Feed SMTP enhanced status taxonomy into reputation scoring.
4. Add Postmaster/SNDS dashboards with ingestion freshness and credential health.
5. Add FBL enrollment inventory and proof.
6. Add blocklist incident workflow with evidence, delist status, and warmup reset.

## 25.3 Deployment, Kubernetes, Runtime, And Security Posture

### 25.3.1 Helm Chart And Static K8s

Current score: 6.2/10 Helm, 5.5/10 static K8s

What is valid:
- Helm chart has replicas, resources, probes, PDBs, HPAs, NetworkPolicy, ingress, and migration job.
- Static K8s manifests are useful reference material.
- Resource requests/limits exist.

Concrete issues:
- Helm defaults to `latest`.
- Tracker probes call `/live`, but tracker only exposes `/health`.
- Worker Helm port is `9091`, while worker defaults to `9100` unless env overrides it.
- Helm has no pod/container `securityContext`.
- Static K8s uses placeholders and lacks NetworkPolicy/pod security.
- K8s/Helm do not deploy Haraka inbound/outbound while self-hosted transport is a supported/default path in other configs.

10/10 solution:
1. Stop defaulting to `latest`; require immutable tags or digests.
2. Fix tracker liveness/readiness route contract.
3. Fix worker metrics/probe port contract.
4. Add `helm template` CI smoke tests for all probes.
5. Add Haraka deployment/StatefulSet if Haraka remains supported for production.
6. Keep static K8s examples clearly marked as reference or bring them to chart parity.

### 25.3.2 Pod Security

Current score: 3.0/10

What is missing:
- No `runAsNonRoot`.
- No fixed UID/GID.
- No `allowPrivilegeEscalation: false`.
- No dropped Linux capabilities.
- No `seccompProfile: RuntimeDefault`.
- No read-only root filesystem where possible.
- No CI policy check against Kubernetes restricted pod security.

10/10 solution:
1. Add pod and container security contexts to every workload.
2. Use non-root users across app and Haraka images where feasible.
3. Drop all capabilities by default.
4. Set `allowPrivilegeEscalation: false`.
5. Set `seccompProfile: RuntimeDefault`.
6. Use read-only root filesystem with writable temp/queue volumes where required.
7. Add kube-linter or policy-as-code gate in CI.

### 25.3.3 NetworkPolicy

Current score: 5.2/10

What is valid:
- Helm has default deny.
- Service-level ingress/egress policies exist.

What is weak:
- Egress rules are broad port-only without destination selectors/CIDRs.
- Static K8s has no NetworkPolicy.
- Worker metrics policy allows port `9090`, but worker defaults to `9100`.
- SMTP/HTTPS egress is broad.
- No test proves policies are enforced by the chosen CNI.

10/10 solution:
1. Tighten egress with namespace selectors, pod selectors, IPBlocks, or DNS-aware CNI policy.
2. Separate SMTP relay egress from arbitrary HTTPS egress.
3. Fix worker metrics port policy.
4. Add static K8s NetworkPolicy or deprecate static K8s for production.
5. Add egress smoke tests in an enforcing CNI environment.

### 25.3.4 Secrets, Config Guard, TLS, And Ingress

Current score: 5.8/10 secrets, 6.0/10 config guard, 5.5/10 TLS/ingress

What is valid:
- Existing Secret reference is supported.
- Secret template documents expected keys.
- Config guard blocks default/weak core secrets.
- Static cert-manager manifests exist.
- Helm ingress supports TLS secret references.

What is missing:
- No ExternalSecrets/SealedSecrets/Vault implementation.
- No CI guard preventing placeholder secret manifests in production.
- Config guard does not validate RLS/DB role, body storage, KMS, ClickHouse, MTA TLS, provider-specific completeness, or Haraka transport readiness.
- Helm does not wire cert-manager issuer/clusterIssuer values.
- Static cert-manager examples still contain placeholder email/domains.

10/10 solution:
1. Add ExternalSecrets/SealedSecrets/Vault examples and Helm values.
2. Add CI check rejecting placeholder secrets/domains/emails in production configs.
3. Extend config guard to storage/KMS/ClickHouse/RLS/MTA/provider checks.
4. Add cert-manager issuer values to Helm ingress.
5. Add TLS smoke tests for API, tracker, and SMTP STARTTLS.

### 25.3.5 Autoscaling, HA, And Runtime Images

Current score: 6.0/10 autoscaling, 5.0/10 runtime image hardening

What is valid:
- API/worker HPAs exist.
- Replicas and PDBs exist.
- Resource limits exist.
- API/worker/tracker run as `node`.

What is weak:
- HPAs are CPU-only.
- No queue-depth/queue-age/KEDA autoscaling.
- App Dockerfiles run migrations at startup.
- Images are not digest-pinned.
- Dockerfiles use broad workspace copies and non-deterministic install patterns.
- Dockerfiles lack healthchecks.
- Production compose lacks app healthchecks/restart policies.
- Haraka runs as root.

10/10 solution:
1. Add KEDA/custom metrics autoscaling based on send queue age, webhook queue age, outbox age, and CPU.
2. Remove startup migrations from app containers.
3. Pin base/runtime images by digest.
4. Use deterministic `npm ci` and copy only runtime artifacts.
5. Add Dockerfile or compose healthchecks.
6. Add production compose restart policies.
7. Harden Haraka runtime or isolate with strong pod security and network policy.

## 25.4 Testing, QA, And Evidence

### 25.4.1 Test Inventory And Reproducibility

Current score: 7.0/10 overall QA

What is valid:
- Broad Vitest test suite exists.
- Unit/integration and E2E layers exist.
- Security tests cover SSRF, config guard, auth, MFA, sessions, RLS documentation, webhooks, and hardening.

What is overstated/stale:
- The report's earlier exact test snapshot is not reproducible from current evidence.
- Production checklist test counts are stale.
- Current cached Vitest metadata is not a release evidence artifact.
- No CI-published test count/skipped count/duration/coverage summary.

10/10 solution:
1. Publish test report artifacts in CI.
2. Store test count, skipped count, duration, failure list, and coverage summary per release.
3. Add release evidence link to last successful CI run.
4. Keep docs test counts generated, not hand-written.

### 25.4.2 E2E Harness And Route Coverage

Current score: 6.4/10 route coverage

Concrete drift:
- Production `server.ts` registers analytics routes.
- E2E harness omits analytics routes.
- Docs claim the harness assembles the API nearly like production.

10/10 solution:
1. Add a route registration parity test comparing production `server.ts` route modules to harness modules.
2. Include analytics routes in the harness.
3. Add tracker HTTP route coverage for `/health`, metrics auth, open tracking, click redirect, unsubscribe, and one-click unsubscribe.
4. Add route metadata matrix: auth type, scopes/capabilities, tenant context, audit policy, rate limit, and OpenAPI coverage.

### 25.4.3 CI Execution Gaps

Current score: 6.8/10

What is valid:
- CI installs dependencies, builds core workspaces, validates production contract, runs migrations, runs tests, audits, generates SBOM, and scans selected images.

What is weak:
- CI manually builds shared/api/worker/tracker, not all root build workspaces.
- SDK and docs builds are not enforced.
- k6 is not run.
- SBOM generation is non-blocking.
- Helm chart is not rendered/validated.
- No docs snippet compile tests.
- No provider sandbox integration jobs.

10/10 solution:
1. Run root `npm run build` or explicitly include SDK/docs.
2. Add docs build.
3. Add docs snippet compile tests.
4. Add Helm `template` + kubeconform/kube-linter.
5. Make SBOM fail-closed.
6. Add k6 staging/nightly job.
7. Add optional Stripe/PayPal/Cashfree sandbox jobs.

### 25.4.4 Load, Performance, And Production Readiness Evidence

Current score: 5.8/10 load, 5.6/10 production readiness tests

What is valid:
- k6 script exists with thresholds.
- `prod:check` exists.
- `LOAD_TEST_FINDINGS.md` exists.

What is weak:
- No workflow runs k6.
- k6 comments imply CI enforcement that does not exist.
- Load evidence is local/in-process, not staging/cluster proof.
- `prod:check` checks config shape, not real provider credentials, S3, ClickHouse, KMS, MTA TLS, Helm probe correctness, or no-startup-migration policy.

10/10 solution:
1. Add `npm run load:staging`.
2. Run k6 in staging or nightly CI with artifacts.
3. Include queue-drain, worker, DB, Redis, and webhook metrics in load evidence.
4. Extend prod check to selected provider credentials, S3/ClickHouse/KMS health, MTA/TLS readiness, Helm probe contracts, and startup migration absence.
5. Store load and readiness artifacts in release evidence.

### 25.4.5 SDK, Docs, Contract, And Security QA

Current score: 6.4/10 SDK tests, 3.5/10 docs snippet tests, 7.2/10 contract tests, 7.6/10 security tests

What is valid:
- OpenAPI tests exist.
- SDK has some test coverage.
- Security tests are meaningful.

What is weak:
- SDK docs snippets are stale and not compiled.
- SDK docs reference methods/resources not exposed by SDK.
- OpenAPI tests are not full route parity.
- No DAST/fuzz lanes for public endpoints, DSN/FBL parsers, webhook verification, template rendering, and URL handling.

10/10 solution:
1. Extract and compile TypeScript snippets from SDK docs.
2. Add SDK method coverage for every public API route intended for SDK users.
3. Add full OpenAPI route parity tests.
4. Add DAST/fuzz tests for critical public parsers and URL handlers.
5. Add security regression artifacts to CI.

## 25.5 Sixth-Pass Invalid-Claim Ledger

| Claim or implied posture | Sixth-pass verdict | Why |
| --- | --- | --- |
| Postmaster/SNDS ingestion is only a TODO | Too harsh | Credentialed Google OAuth and SNDS ingestion code/tests exist; live proof still missing. |
| Sending pools are production-routed | Overstated | `ip_pool` metadata/header exists, but no source-IP binding transport path is visible. |
| Warmup is fully enforced | Overstated | Single send checks pool cap; batch and per-IP source selection are incomplete. |
| KYC/new-account controls are strong | Overstated | KYC is mostly a column and caps, not a verification workflow. |
| Batch send has parity with single send | Overstated | Missing group unsubscribe and warmup-cap parity. |
| Review queue is operationally mature | Overstated | Basic approve/reject exists; assignment/SLA/feedback loop/transactionality are incomplete. |
| Helm/K8s is near 7.5 | Overstated | Probe bugs, missing pod security, broad egress, no Haraka, CPU-only autoscaling. |
| Worker Helm probes are valid | Likely incorrect | Helm uses port `9091`; worker defaults to `9100`. |
| Tracker Helm probes are valid | Incorrect | Helm probes `/live`; tracker exposes `/health`. |
| NetworkPolicy is strong | Overstated | Default deny exists, but egress is broad port-only and static K8s has none. |
| Pod security is production-grade | Incorrect | No restricted pod security context in checked templates. |
| k6 thresholds fail CI | Incorrect | k6 script exists, but no CI workflow runs it. |
| CI builds all packages | Overstated | CI manually builds core workspaces and omits SDK/docs. |
| E2E harness matches production server | Overstated | Analytics route registered in production is missing from harness. |
| SDK docs are reliable | Incorrect | Snippets reference stale field names and non-existent SDK resources. |

## 25.6 Sixth-Pass 10/10 Remediation Backlog

Priority 0 - concrete correctness bugs:
1. Fix tracker Helm probes.
2. Fix worker Helm probe port or set `WORKER_METRICS_PORT`.
3. Add analytics route to E2E harness and route parity test.
4. Remove startup migrations from app Dockerfiles.
5. Fix batch-send parity for warmup and group unsubscribe.
6. Stop claiming CI-enforced k6 until k6 runs in CI/staging.

Priority 1 - deliverability safety:
1. Implement real source-IP/pool routing.
2. Add per-IP warmup enforcement and selected-IP persistence.
3. Add KYC/risk state machine.
4. Add review queue SLA/assignment/feedback loop.
5. Add ISP/domain-specific reputation dashboards and gates.
6. Emit DSN/FBL metrics from Haraka.

Priority 2 - deployment hardening:
1. Add restricted pod security contexts.
2. Tighten NetworkPolicy egress.
3. Add cert-manager integration to Helm.
4. Add ExternalSecrets/SealedSecrets/Vault support.
5. Add KEDA queue-age autoscaling.
6. Add Haraka production K8s topology if self-hosted MTA is supported.

Priority 3 - QA and evidence:
1. Build SDK/docs in CI.
2. Add docs snippet compile tests.
3. Add Helm render/kubeconform/kube-linter CI.
4. Make SBOM fail-closed.
5. Add staging/nightly k6.
6. Add provider sandbox jobs.
7. Publish test/load/coverage/evidence artifacts per release.

## 25.7 Sixth-Pass Verdict

The report's main answer remains unchanged: the platform is not 10/10 production-grade, SaaS-grade, or enterprise-grade.

The sixth pass adds nuance:
- Abuse/reputation has more implementation than a toy system, especially around scanner, suppression, DNSBL, Postmaster/SNDS ingestion, and tests.
- The missing parts are the hard operational pieces: source-IP routing, batch parity, KYC workflow, review feedback, warmup evidence, and provider-specific reputation gates.
- Deployment has several real production primitives, but concrete Helm probe bugs and missing pod security prevent a high score.
- QA is broad, but release evidence and CI enforcement are not complete enough for enterprise claims.

Updated readiness view:

| Dimension | Fifth-pass score | Sixth-pass score |
| --- | ---: | ---: |
| Abuse/reputation readiness | 6.5 implied | 6.0 |
| Deliverability launch readiness | 5.9 implied | 5.5 |
| Deployment/runtime readiness | 6.0 implied | 5.8 |
| Testing/QA evidence readiness | 7.5 implied | 7.0 |
| Overall production readiness | 5.0 | 5.0 |
| Overall enterprise readiness | 4.8 | 4.8 |

The current platform is best described as an unusually complete early production candidate with many serious controls, but still missing the verified operational, deployment, QA, and deliverability machinery required to honestly call it 10/10 enterprise-grade.

# 26. Seventh-Pass Agent-Assisted End-To-End Validation

This pass was triggered to go deeper again across the complete mail platform and validate whether this report is still honest against the actual code. Three read-only agents inspected independent areas:

1. Identity, account security, team/RBAC, API keys, MFA, admin/customer boundary, tenant isolation.
2. Full message lifecycle from `/send` and `/send/batch` through worker, Haraka, tracker, events, webhooks, message activity, and analytics.
3. Customer product surface, admin/support APIs, docs site, SDK docs, OpenAPI, and code/doc consistency.

The seventh-pass result does not reverse the earlier conclusion. It makes it sharper:

- The platform is substantially implemented and is not a toy.
- Several older scores in this report are still too generous, especially identity invite acceptance, batch send, SDK/docs, OpenAPI, admin/customer frontend surface, and tenant isolation.
- The later corrections in sections 20-25 are mostly valid.
- The honest current rating remains below production-grade SaaS and meaningfully below enterprise-grade.

## 26.1 External Standards Cross-Check

These external references were used as a sanity check for what "production-grade, SaaS-grade, enterprise-grade" should mean in 2026.

| Reference | Why it matters to this project | Seventh-pass impact |
| --- | --- | --- |
| [NIST SP 800-63B](https://pages.nist.gov/800-63-3/sp800-63b.html) and [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) | Authentication lifecycle, authenticators, session posture, reauthentication, phishing resistance, recovery. | Confirms that local TOTP is not enough for enterprise posture without step-up, phishing-resistant options, admin OIDC assurance checks, and safer account recovery/invite flows. |
| [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) | Application security verification depth across auth, session, access control, validation, logging, configuration, and data protection. | Confirms the need for route-level auth metadata, durable audit, stronger session/device controls, tenant isolation tests, and security regression evidence. |
| [OWASP API Security Project](https://owasp.org/www-project-api-security/) | API risks for object authorization, auth weakness, unrestricted resource consumption, unsafe consumption of APIs, and inventory/contract drift. | Confirms OpenAPI route drift, BOLA/BFLA risk, coarse scopes, missing route parity tests, and public API documentation mismatch are real SaaS blockers. |
| [OWASP API1 Broken Object Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/) | Tenant SaaS APIs must verify object ownership on every object access. | Confirms fail-open RLS plus route-by-route `customer_id` filtering is not enough for 10/10 SaaS isolation. |
| [RFC 8058](https://datatracker.ietf.org/doc/html/rfc8058) | Defines one-click email unsubscribe behavior. | Confirms the tracker one-click implementation is a positive control, but group-unsubscribe enforcement must also happen at send admission. |

## 26.2 Seventh-Pass Validity Of Existing Report

| Existing report area | Seventh-pass verdict | Correction |
| --- | --- | --- |
| "Not 10/10 production/SaaS/enterprise-grade" | Valid | Keep. New findings make the answer stronger, not weaker. |
| Later RLS warnings | Valid and severe | Keep. RLS exists, but policies fail open when tenant context is null, and production routes do not consistently use `withTenant()`. |
| Later SDK/OpenAPI warnings | Valid | Keep. OpenAPI is hand-maintained and incomplete. SDK docs reference stale fields/resources. |
| Later batch-send parity warnings | Valid | Keep. `/send/batch` lacks idempotency, warmup capacity parity, and group-unsubscribe enforcement. |
| Earlier identity/security scores around 7.5-8.5 | Too generous | Lower identity/account/security overall to 6.2/10. |
| Earlier invite acceptance score around 8.0 | Too generous | Lower invite acceptance to 4.5/10 due MFA bypass for existing MFA-enabled users. |
| Earlier SDK score around 7.5 | Too generous | Lower SDK implementation to 5.0/10 and SDK docs to 3.0/10. |
| Earlier docs/API docs score around 7.5 | Too generous | Lower API reference/OpenAPI to 4.5-5.8/10 depending on submodule. |
| Earlier admin/customer product surface score around 6.5-7.5 | Too generous | Lower because product surface is mostly API-only, not a real customer/admin console. |
| Earlier "visible unsubscribe missing" wording | Too harsh | Worker does append body unsubscribe and address when address exists. The real gap is group-unsubscribe enforcement on future sends. |

## 26.3 Updated Executive Scorecard

| Dimension | Sixth-pass score | Seventh-pass score | Why changed |
| --- | ---: | ---: | --- |
| Identity/account/security readiness | 6.5 implied | 6.2 | Invite acceptance creates full MFA-satisfied sessions; account deletion missing; customer SSO/SCIM absent; audit not durable. |
| Message lifecycle readiness | 7.0 implied | 7.0 | Strong normal path, but batch parity, review approval, group unsubscribe, analytics durability, and source-IP routing remain incomplete. |
| Customer/admin product surface readiness | 6.0 implied | 5.6 | APIs exist, but no real dashboard/admin console frontend; support uses coarse `logs:read`; SDK/docs drift is large. |
| API contract/docs readiness | 5.0 implied | 4.5 | OpenAPI is hand-maintained, incomplete, and stale against real routes/providers. |
| Tenant isolation readiness | 4.0 | 4.0 | No improvement. RLS is fail-open without tenant context. |
| Production readiness | 5.0 | 4.9 | Slightly lower due identity invite MFA bypass and product-surface evidence. |
| Enterprise readiness | 4.8 | 4.7 | Slightly lower because enterprise identity, contract governance, audit durability, SSO/SCIM, and tenant isolation are not complete. |

## 26.4 Deep Hierarchy Scores And 10/10 Solutions

### 26.4.1 Identity, Account, Security, And Tenant Boundary

Current overall score: 6.2/10

| Module path | Score | What exists | What is missing or weak | 10/10 solution |
| --- | ---: | --- | --- | --- |
| Identity -> API-first signup -> `/v1/signup` | 6.5 | Creates customer and key; docs exist; live-send gate is discussed elsewhere. | Initial key scope is broader than docs claim; KYC/risk workflow is shallow; signup abuse controls are not enterprise-grade. | Issue least-privilege default key, require explicit scope grants, rate-limit by IP/email/domain/device, add KYC/risk state machine, and block live sending until verification/risk gates pass. |
| Identity -> Human org signup -> `/v1/auth/register` | 7.2 | Session-based customer signup exists with tests and verification flows. | Enterprise policies are missing: required MFA, SSO-required tenants, allowed email domains, custom password policy. | Add tenant security policy table and enforce it in registration/login/session guards. |
| Identity -> Email verification -> verify/resend | 6.8 | Verification and resend flows exist. | Needs stronger abuse limits, token lifecycle evidence, and explicit production proof that verification blocks live sends for every send path. | Add per-route rate limits, replay tests, live-send gate tests for single and batch send, and verification telemetry. |
| Identity -> Login/password auth -> credential validation | 7.4 | Password login, validation, MFA branch, and session creation exist. | No risk-based checks, device posture, impossible-travel, breached password screening, or step-up by sensitive action. | Add risk engine, Have I Been Pwned or internal breached-password checks, device inventory, geo/anomaly flags, and per-action step-up. |
| Identity -> Session lifecycle -> user sessions | 7.6 | Session tokens are hashed, expiries exist, revoke flows exist. | Limited device metadata, no session list/revoke-all UX evidence, no tenant policy TTL enforcement, no risk reauthentication. | Store IP/UA/last_seen/revoked_at/device name, expose session list/revoke-all APIs, enforce tenant TTL and step-up age. |
| Identity -> MFA -> TOTP and recovery codes | 7.6 | TOTP and recovery-code mechanisms exist with replay-focused tests. | No passkeys/WebAuthn; disable posture weak; step-up not consistently required for sensitive mutations. | Add WebAuthn/passkeys, require step-up for disable/rotate/delete/admin actions, add recovery-code regeneration audit and anomaly alerts. |
| Identity -> MFA -> disable and step-up posture | 5.5 | Basic MFA controls exist. | Sensitive changes can be performed without fresh authentication in several areas. | Centralize `requireStepUp()` and attach it to MFA disable, API key create/rotate/revoke, webhook secret rotation, role changes, billing, account deletion, and admin critical actions. |
| Identity -> Team/RBAC -> memberships and roles | 7.0 | Role/capability model exists; team member and invite APIs exist. | Roles are coarse; no custom roles; no SCIM; no tenant security policies; invite MFA bypass exists. | Add custom roles, route capability metadata, SCIM provisioning, SSO-required enforcement, and invite acceptance step-up. |
| Identity -> Team/RBAC -> invite acceptance | 4.5 | Single-use invite model exists. | Existing MFA-enabled user can accept invite and receive a session with `mfaSatisfied: true`; this bypasses MFA. | Make token consume, membership grant, and session creation transactional; for existing users set `mfaSatisfied: false` and require password plus MFA before full session. |
| Identity -> API keys -> storage and verification | 8.2 | API keys are hashed/verified and v2 management exists. | Needs stricter lifecycle controls and route-level metadata coverage. | Add expiry, rotation overlap, per-key quotas, IP allowlists, last-used freshness, service-account owners, scope enum validation, and break-glass controls. |
| Identity -> API keys -> self-service management | 7.4 | Key list/create/rotate/revoke APIs exist behind capabilities. | No mandatory step-up; no tenant policy around key age, scope, or allowed source IP. | Require step-up for key mutations, enforce policy-based expiry and IP restrictions, and add key risk alerts. |
| Identity -> Scopes/capabilities -> API access | 6.2 | API scopes and user capabilities exist. | Coarse scopes; some customer mutations use unrelated capabilities such as `logs:read`; no route auth inventory. | Add route metadata matrix for auth type, scope, capability, tenant context, audit policy, rate limit, OpenAPI coverage; fail CI if missing. |
| Identity -> Profile/settings -> customer profile | 5.2 | Basic customer profile/address API exists. | Uses broad `messages` style access; no audit on profile update; only limited profile fields. | Add `settings:read`/`settings:manage`, audit every change, add organization settings, security policy, contacts, billing/legal profile separation. |
| Identity -> Account lifecycle -> account deletion | 1.0 | `org:delete` capability string exists. | No complete customer account deletion route/service found. | Implement owner-only async deletion workflow with legal hold, billing cancellation, key/domain/webhook shutdown, S3/ClickHouse/queue cleanup, audit, export option, and recovery window. |
| Identity -> Audit/activity -> customer audit | 5.3 | Account audit route and audit helper exist. | Audit can be best-effort/swallowed; retention deletes audit rows; not tamper-evident. | Add durable audit outbox, append-only/WORM export, hash chain, SIEM streaming, retention policy separation, and fail-closed audit for critical mutations. |
| Identity -> Admin/customer auth boundary | 6.8 | Admin routes and customer routes are separated; admin OIDC is stronger than earlier score. | Legacy `/v1/admin/api-keys` uses static token; admin sessions lack device posture; OIDC does not enforce `amr`/`acr`. | Remove legacy static-token admin route, enforce OIDC `amr`/`acr`, add admin session device inventory, JIT access, break-glass expiry, and critical-action audit. |
| Identity -> Admin OIDC | 8.0 | OIDC issuer/audience/JWKS validation exists and production requires OIDC. | No assurance-level enforcement; local admin TOTP is not meaningful for OIDC-only production. | Enforce IdP MFA claim requirements, admin group/role mapping, JIT approval, and IdP outage break-glass policy. |
| Identity -> Customer SSO/SCIM | 2.0 | No complete customer SSO/SCIM product found. | Enterprise tenants cannot self-serve SSO, SCIM, domain claiming, group mapping, or deprovisioning. | Add SAML/OIDC SSO, SCIM 2.0, domain verification, group-to-role mapping, IdP-enforced MFA policy, and deprovision tests. |
| Identity -> Tenant isolation/RLS | 4.0 | RLS migration and tenant-context helper exist. | Policies allow rows when tenant context is null; API routes do not use `withTenant()` consistently; DB role posture is not production-enforced. | Remove null-tenant allow policy for app roles, run API as non-owner/non-BYPASSRLS, wrap tenant routes in `withTenant()`, add fail-closed startup checks and cross-tenant negative route tests. |

### 26.4.2 Message Lifecycle, Deliverability Path, And Eventing

Current overall score: 7.0/10

| Module path | Score | What exists | What is missing or weak | 10/10 solution |
| --- | ---: | --- | --- | --- |
| Send lifecycle -> `/send` admission -> validation/domain/quota | 7.8 | Strong schema, domain checks, quota reservation, suppression checks, review queue, and outbox. | Group unsubscribes are not enforced; quota refund paths need exact accounting for every branch. | Enforce global and group suppression before final quota; add exact reservation ledger and property tests for every error/refund branch. |
| Send lifecycle -> `/send` admission -> idempotency | 8.0 | Single-send idempotency key handling and response persistence exist. | Needs route metadata proof, replay load tests, and conflict handling evidence under concurrency. | Add race tests, idempotency TTL metrics, conflict dashboards, and documented behavior in OpenAPI/SDK. |
| Send lifecycle -> `/send/batch` -> validation/admission | 6.2 | Batch route exists and enqueues multiple messages. | No batch idempotency; no warmup capacity parity; no group-unsubscribe enforcement; sequential per-message checks. | Add batch idempotency, pool/warmup admission parity, group suppression, partial result semantics, exact quota ledger, and bulk optimized suppression queries. |
| Send lifecycle -> Templates/rendering | 7.0 | Template compile validation and escaping exist. | No render timeout, helper allowlist, output-size cap, immutable versions, or preview/approval workflow. | Add immutable template versions, render sandbox timeout, output cap, helper allowlist, preview API, approval state, and render-failure tests. |
| Send lifecycle -> Body storage | 8.0 | Inline/filesystem/S3-like abstraction and worker load path exist. | Object writes can occur before DB commit, causing orphan bodies on DB failure. | Use body-storage outbox or cleanup ledger, transactional write intent, orphan sweeper, content hash, encryption, retention tags, and restore tests. |
| Send lifecycle -> Quota/idempotency combined | 7.0 | Redis Lua quota is strong; single-send idempotency is solid. | Batch lacks idempotency; refund accounting can drift in multi-branch paths. | Use a quota reservation table/ledger, reconcile counters, add batch replay, and expose quota reservation SLOs. |
| Send lifecycle -> Review queue | 6.2 | Queue/list/stats/approve/reject/bulk functions exist. | Approve/reject is not fully transactional; approval bypasses send outbox and directly enqueues Redis job. | Route approval through transactional `send_outbox`, make review status/message/event updates one transaction, add assignment/SLA/escalation/feedback loop. |
| Send lifecycle -> Transactional outbox | 8.4 | Normal send path uses DB outbox and `SKIP LOCKED` drain. | Review approval bypasses it; queue-age SLO metrics are limited. | All send-producing workflows must write send_outbox rows; add queue-age, retry-age, stuck-row alerts, and outbox replay tooling. |
| Send lifecycle -> Worker transport | 7.6 | Worker loads body, rewrites tracking, appends footer, retries, and has DLQ behavior. | SMTP error taxonomy and source-IP selection are shallow. | Classify transient/permanent/provider errors, persist selected IP, attach transport metadata, and add retry policy by error class. |
| Send lifecycle -> Haraka handoff | 6.7 | SMTP handoff, DKIM, and event emission exist. | IP pool appears to be metadata/header only; no visible source-IP binding. | Bind outbound connection to selected source IP, verify DKIM/SPF alignment per domain, and emit per-IP/provider delivery evidence. |
| Send lifecycle -> Open/click tracking | 7.4 | Tracker endpoints and bot classification exist. | Analytics separation between raw machine events and human events is incomplete in product views. | Store raw and classified events, expose human-filtered metrics by default, and preserve raw forensic data separately. |
| Send lifecycle -> Unsubscribe | 7.0 | RFC 8058-style one-click support and body/footer unsubscribe exist. | Group unsubscribe is recorded but not honored by later sends. | Enforce group membership at single and batch send admission, expose group suppression APIs in OpenAPI/SDK, and add E2E tests from unsubscribe to future skip. |
| Send lifecycle -> Event worker | 7.3 | Event idempotency, status precedence, suppression, and webhook fanout exist. | ClickHouse write is best-effort; complaint/status semantics need stronger product handling. | Add durable analytics_outbox, retry worker, reconciliation, alerting, complaint-specific suppression policy, and event status invariants. |
| Send lifecycle -> Webhooks | 8.0 | SSRF protections, IP pinning, signatures, retries, and delivery logs exist. | No challenge verification, no dual-secret rotation grace, and SDK verification helper does not match real signature header. | Add endpoint challenge, secret rotation with dual validation, timestamp tolerance, payload replay prevention, SDK parity tests, and DLQ replay UI/API. |
| Send lifecycle -> Message activity APIs | 7.6 | Scoped cursor activity with bot fields exists. | Still Postgres-bound and limited for high-volume analytics. | Add ClickHouse-backed activity with durable sync, query limits, export jobs, and retention-aware pagination. |
| Send lifecycle -> Analytics | 5.8 | API reads event counts and raw open/click data. | ClickHouse can drop rows on circuit-open; product rates can be machine-inflated. | Make analytics durable with outbox/retry/reconciliation, expose raw vs human-filtered metrics, and publish analytics freshness SLO. |
| Send lifecycle -> End-to-end proof | 6.5 | Many E2E tests exist. | No complete synthetic journey proving signup to send to track to webhook to analytics to billing/support under production route parity. | Add a release-blocking journey: signup, verify, set address, add domain, verify DNS, create template, send, track, webhook, analytics, usage/billing, support ticket, export/delete. |

### 26.4.3 Customer Product, Admin Product, Support, Docs, SDK, And Contract

Current overall score: 5.6/10

| Module path | Score | What exists | What is missing or weak | 10/10 solution |
| --- | ---: | --- | --- | --- |
| Customer product -> Account/dashboard APIs | 6.2 | Account, keys, domains, webhooks, profile, usage, messages, billing routes exist. | Product surface is API-only; no real customer dashboard frontend was found. | Build a real customer console or stop claiming dashboard readiness. Include keys, domains, DNS, templates, webhooks, billing, support, security, audit, usage, suppression, privacy, and team management. |
| Customer product -> Self-serve workflow | 5.8 | Most backend primitives exist. | Workflow is not packaged as a guided product; no verified happy path from onboarding to production sending. | Add onboarding checklist, DNS validation UI/API, live-send readiness gates, sandbox/live mode, and product journey E2E. |
| Support -> Customer support tickets | 6.5 | Customer ticket list/create/read/messages/rate exist. | All actions require broad `logs:read`; support-specific capability model missing. | Add `support:read`, `support:write`, `support:rate`; audit support actions; add attachment policy, SLA notices, and customer-visible status history. |
| Support -> Admin support/ops APIs | 6.8 | Ticket list/create/read/message/patch/triage/SLA breach APIs exist. | API-only operator surface; AI suggestion governance and SLA automation evidence are limited. | Build admin support console, SLA scheduler/alerts, AI suggestion audit/approval, canned replies, assignment queues, and escalation policies. |
| Admin product -> Admin console | 5.5 | Admin APIs are broad and real. | No actual operator/admin frontend found; admin sessions/device posture are shallow. | Build admin console with RBAC, audit, user/session management, support queues, deliverability ops, billing ops, security alerts, and break-glass workflow. |
| Docs -> Docusaurus shell | 6.5 | Docs site exists and builds static docs/OpenAPI assets. | Homepage/product claims overstate API v2/OpenAPI/SDK maturity. | Gate docs build in CI, lint claims against runtime versions, and publish docs per release tag. |
| Docs -> User guides | 5.8 | Many guides exist for support, webhooks, deliverability, unsubscribe, etc. | Several guides are stale or overstate behavior, especially unsubscribe group enforcement and SDK examples. | Add docs drift tests, snippet tests, route availability checks, and guide ownership per module. |
| Docs -> API reference/OpenAPI | 4.5 | OpenAPI file and tests exist. | Spec is hand-maintained, incomplete, and missing public routes such as batch send, profile, scheduled/cancel, webhook deliveries/test, privacy, analytics, and unsubscribe groups. | Generate OpenAPI from route schemas or route schemas from OpenAPI; add route parity CI and breaking-change diff. |
| Docs -> Provider/billing contract | 4.5 | Billing routes and docs exist. | OpenAPI provider enum drift exists, for example runtime supports providers not in the spec. | Single source of truth for provider enums, OpenAPI, docs, tests, and SDK. |
| SDK -> Implementation | 5.0 | TypeScript SDK exists with messages, suppressions, domains, templates, webhooks, usage, analytics. | Not generated from OpenAPI; resource coverage is partial; webhook verifier does not match real platform signature format. | Generate SDK or enforce SDK-vs-OpenAPI parity; add all public resources; fix webhook verification for `X-MP-Signature t/v1`, timestamp tolerance, and multi-secret rotation. |
| SDK -> Documentation | 3.0 | SDK markdown exists. | Uses stale camelCase fields and non-existent resources such as account/privacy/unsubscribeGroups in the SDK docs. | Compile every docs snippet in CI against the real SDK and remove or implement every documented resource. |
| Contract -> Runtime route parity | 4.0 | Some OpenAPI spot tests exist. | No complete Fastify route inventory vs OpenAPI comparison. | Add route inventory extraction and fail CI if public routes lack OpenAPI path, auth metadata, examples, SDK coverage, and docs. |
| Release evidence -> Product docs and SDK | 4.0 | Some tests exist. | CI does not prove docs build, SDK package build, snippet validity, OpenAPI diff, route parity, or package tarball quality as a release gate. | Release pipeline must publish commit SHA, image digest, SDK package artifact, OpenAPI spec, OpenAPI diff, docs build, snippet output, SBOM, scans, and smoke/load evidence. |

### 26.4.4 SaaS And Enterprise Cross-Cutting Controls

| Module path | Score | What exists | What is missing or weak | 10/10 solution |
| --- | ---: | --- | --- | --- |
| SaaS isolation -> Per-route object ownership | 5.5 | Many routes filter by `customer_id`. | No route metadata proof; RLS fails open without tenant context. | Add route authorization metadata, BOLA tests for every `:id` route, fail-closed RLS, and centralized tenant executor. |
| SaaS isolation -> DB role posture | 4.0 | Helper includes comments/checks. | Production startup does not enforce non-superuser/non-BYPASSRLS role. | Startup must fail if DB role is owner/superuser/BYPASSRLS or if RLS policies are permissive for app role. |
| Enterprise identity -> SSO/SCIM | 2.0 | Admin OIDC exists for platform admins. | Customer tenant SSO/SCIM absent. | Add customer SAML/OIDC, SCIM, IdP group mapping, domain claim, deprovisioning, and tenant policy controls. |
| Enterprise compliance -> Audit | 5.3 | Audit events exist. | Not durable/tamper-evident; critical mutations can proceed if audit write fails. | Add durable audit outbox, WORM/SIEM export, hash chaining, immutable retention class, and critical-action fail-closed audit. |
| Enterprise compliance -> Privacy lifecycle | 5.5 implied | Export/delete APIs exist in parts. | Account/org deletion incomplete; multi-store erasure proof not complete. | Add async privacy job ledger across Postgres, object storage, ClickHouse, queues, backups policy, legal hold, and verification artifacts. |
| Enterprise operations -> Route/API inventory | 4.5 | OpenAPI exists. | Contract is incomplete and manually maintained. | One source of truth, route parity CI, versioning policy, deprecation headers, and compatibility tests. |
| Enterprise operations -> Product evidence | 4.5 | Tests and docs exist. | No release certification artifact proving docs, SDK, OpenAPI, route parity, load, restore, and provider sandbox. | Release certification pipeline with artifacts and signed approval gates. |

## 26.5 Seventh-Pass Invalid-Claim Ledger

| Claim or implied posture | Seventh-pass verdict | Why |
| --- | --- | --- |
| Invite acceptance is strong because tokens are single-use | Overstated | Single-use helps, but existing MFA-enabled users can receive a full session with `mfaSatisfied: true` after invite acceptance. |
| Admin MFA is 8.5-level production grade | Overstated | Production uses OIDC; OIDC path does not enforce `amr`/`acr`, so local TOTP scoring does not fully apply. |
| Admin sessions are enterprise-grade | Overstated | Admin session schema lacks IP, UA, last seen, revoked timestamp, device inventory, and session list/revoke-all controls. |
| Profile/settings API is 8/10 | Overstated | Basic profile fields exist, but capability is coarse and profile update lacks strong audit posture. |
| Account deletion exists because `org:delete` exists | Incorrect | Capability string exists, but no complete customer account deletion workflow was found. |
| `/send/batch` is close to single-send maturity | Overstated | No idempotency, no warmup capacity parity, no group-unsubscribe enforcement. |
| Review approval is outbox-safe | Incorrect | Approval can enqueue directly to Redis outside the transactional send outbox. |
| IP pools are production-routed | Overstated | Worker/Haraka metadata exists, but no visible source-IP binding path was confirmed. |
| Group unsubscribe prevents future sends | Incorrect | Tracker records group membership, but send admission checks global suppression only. |
| Analytics are durable | Overstated | ClickHouse dual-write is best-effort and can drop rows when circuit-open. |
| RLS materially saves every tenant query | Incorrect | Policies allow rows when tenant context is null, and production routes do not consistently set tenant context. |
| Customer/admin dashboard exists | Overstated | Backend APIs exist, but no real customer/admin console frontend was found. |
| OpenAPI is current | Incorrect | Many public routes are missing or stale, and provider enums drift from runtime. |
| SDK docs are reliable | Incorrect | Docs use stale field names and resources not exposed by the SDK. |
| Webhook SDK verifier matches production signatures | Incorrect | Docs/guides use `X-MP-Signature t/v1`; SDK helper documents a different header/style. |

## 26.6 10/10 Remediation Backlog By Priority

### 26.6.1 Priority 0 - Security Correctness And Tenant Isolation

1. Fix invite acceptance immediately:
   - Token consume, membership grant, and session creation must be one transaction.
   - Existing users must authenticate with password/SSO and complete MFA before receiving full session.
   - New users may create password, but session should still obey tenant MFA/security policy.
   - Add regression test: existing MFA-enabled user accepts invite and cannot access `requireFullUser` route before MFA.

2. Make RLS fail closed:
   - Remove `OR current_tenant_id() IS NULL` behavior for API app role.
   - Wrap tenant API route execution with `withTenant()` or equivalent request-scoped DB executor.
   - Run API under non-owner, non-superuser, non-BYPASSRLS DB role.
   - Fail production boot if DB role can bypass RLS.
   - Add BOLA tests for every public route containing `:id`.

3. Add step-up auth:
   - MFA disable.
   - API key create, rotate, revoke.
   - Webhook secret rotate.
   - Role/member/invite changes.
   - Billing mutation.
   - Account/org deletion.
   - Admin critical actions.

4. Remove or quarantine legacy static-token admin API:
   - Replace `/v1/admin/api-keys` static-token behavior with audited admin-session route.
   - Validate scopes against a strict enum.
   - Add audit and rate limits.

### 26.6.2 Priority 1 - Message Lifecycle Correctness

1. Bring `/send/batch` to single-send parity:
   - Idempotency with replay/conflict/in-progress states.
   - Warmup pool capacity checks.
   - Group unsubscribe enforcement.
   - Bulk suppression lookup.
   - Exact quota reservation/refund ledger.

2. Fix group unsubscribe enforcement:
   - Send path checks global suppressions and group membership.
   - Batch path checks the same.
   - API returns skip reason `group_unsubscribed`.
   - E2E test: click one-click group unsubscribe, then attempt future group send and verify skip.

3. Make review approval outbox-safe:
   - Approval writes `send_outbox` row in same transaction as review status/message status/event update.
   - No direct Redis enqueue from review approval.
   - Add stranded-message regression test for Redis failure during approval.

4. Implement real IP-pool routing:
   - Select and persist selected source IP.
   - Bind outbound connection to source IP in MTA/transport.
   - Add warmup counters per IP/provider/domain.
   - Emit per-IP delivery metrics and alerts.

5. Make analytics durable:
   - Add `analytics_outbox`.
   - Retry ClickHouse writes.
   - Reconcile Postgres vs ClickHouse.
   - Expose freshness and drift metrics.

### 26.6.3 Priority 2 - Product Surface And Enterprise Workflows

1. Build or explicitly scope customer dashboard:
   - API keys, domains/DNS, templates, webhooks, usage, billing, suppression, privacy, support, audit, team, security settings.
   - Guided onboarding from sandbox to live sending.
   - Product E2E journey test.

2. Build admin/operator console:
   - Support queue, SLA breaches, deliverability health, review queue, customer risk, billing ops, webhook failures, abuse controls, audit search.
   - Admin session list/revoke-all.
   - JIT/break-glass access flow.

3. Add enterprise identity:
   - Customer SAML/OIDC SSO.
   - SCIM 2.0.
   - Domain claim and allowed domains.
   - IdP group to role mapping.
   - SSO-required tenant policy.

4. Implement account/org deletion:
   - Owner-only request.
   - Step-up required.
   - Legal hold checks.
   - Billing cancellation.
   - API key/domain/webhook shutdown.
   - Postgres/object storage/ClickHouse/queue cleanup.
   - Durable audit and recovery window.

### 26.6.4 Priority 3 - Contract, SDK, Docs, And Release Evidence

1. Choose one contract source of truth:
   - Generate OpenAPI from route schemas, or generate route schemas from OpenAPI.
   - Do not keep hand-maintained incomplete spec as the source of enterprise truth.

2. Add route parity CI:
   - Enumerate Fastify public routes.
   - Compare to OpenAPI.
   - Require auth metadata, scope/capability metadata, rate-limit metadata, tenant metadata, and audit metadata.

3. Fix SDK implementation and docs:
   - Implement documented resources or remove docs.
   - Convert stale camelCase examples to real SDK types.
   - Fix webhook verifier for `X-MP-Signature` timestamp and `v1`.
   - Compile every SDK docs snippet in CI.

4. Add release certification artifact:
   - Docs build.
   - SDK build/package.
   - OpenAPI diff.
   - Route parity output.
   - Unit/e2e/security tests.
   - Migration up/down.
   - RLS fail-closed tests.
   - SBOM and scan results.
   - Staging smoke.
   - Load test summary.
   - Backup/restore drill evidence.

## 26.7 Required Acceptance Tests Before Claiming 10/10

| Area | Required proof |
| --- | --- |
| Invite MFA bypass | Existing MFA-enabled user accepts invite and is forced through MFA before full session. |
| Step-up auth | Every sensitive mutation fails without fresh step-up and succeeds after valid step-up. |
| Tenant isolation | Every object route has cross-tenant negative tests; API DB role cannot bypass RLS; missing tenant context fails closed. |
| Batch send parity | Batch idempotency, warmup capacity, group unsubscribe, suppression, quota refund, and partial result behavior are tested. |
| Review queue transactionality | Redis failure during approval cannot strand a message outside send_outbox. |
| IP pool routing | Staging proof that messages from pool X leave using the selected source IP. |
| Group unsubscribe | One-click group unsubscribe blocks future single and batch sends for that group. |
| Analytics durability | ClickHouse outage does not lose events; reconciliation catches drift. |
| OpenAPI parity | Public runtime routes equal OpenAPI paths, including auth/scope metadata. |
| SDK docs | All SDK markdown snippets compile and run against mocked or test API responses. |
| Product journey | Signup to verify to domain to send to track to webhook to analytics to billing/support passes in CI or staging. |
| Release evidence | Each release has signed artifacts for tests, scans, docs, OpenAPI diff, SDK package, smoke, load, and restore. |

## 26.8 Seventh-Pass Verdict

The markdown report is broadly valid after the later corrections, but the older optimistic scores must not be used for decision-making.

The current mail platform is best described as:

- Stronger than a prototype.
- A serious early production candidate in some backend areas.
- Not 10/10 production-grade.
- Not 10/10 SaaS-grade.
- Not 10/10 enterprise-grade.

The main blockers are now very specific:

1. Tenant isolation is not fail-closed.
2. Invite acceptance can bypass MFA for existing MFA-enabled users.
3. `/send/batch` lacks single-send parity.
4. Review approval bypasses the transactional send outbox.
5. Group unsubscribe is recorded but not enforced on future sends.
6. IP pools are not proven as real source-IP routing.
7. Customer/admin product surface is mostly API-only.
8. SDK docs and OpenAPI are materially stale.
9. Customer SSO/SCIM and account deletion are missing.
10. Release evidence is not strong enough for enterprise claims.

Updated final score after seventh pass:

| Dimension | Score |
| --- | ---: |
| Backend implementation depth | 7.0/10 |
| Message lifecycle backend | 7.0/10 |
| Identity/account security | 6.2/10 |
| Tenant isolation/SaaS safety | 4.0/10 |
| Customer/admin product surface | 5.6/10 |
| SDK/docs/API contract | 4.5/10 |
| Enterprise identity/compliance | 4.2/10 |
| Release evidence/operational proof | 5.0/10 |
| Overall production readiness | 4.9/10 |
| Overall SaaS readiness | 4.7/10 |
| Overall enterprise readiness | 4.7/10 |

# 27. Eighth-Pass Runtime, Billing, Privacy, Deliverability, And Release Evidence Validation

This pass attempted to spawn three additional agents for infra/runtime, billing/privacy, and deliverability/QA. Those agents hit the usage limit before producing findings, so this section is based on a fresh local repo audit plus external standards cross-checks.

The key theme is important: the codebase has more production machinery than a basic prototype, but several controls are still not wired into the release path, deployment path, or runtime proof path. A 10/10 platform must prove that the control works in the exact environment it ships in.

## 27.1 External Runtime Standards Cross-Check

| Standard/reference | Relevant expectation | Repo impact |
| --- | --- | --- |
| Kubernetes probes documentation | Liveness should prove the process is alive; readiness should prove required dependencies are usable before routing traffic. | API has `/health` and `/ready`, worker has `/health` and `/ready`, tracker has `/health`; Helm still has probe path/port drift for worker and tracker. |
| Kubernetes Pod Security Standards | Restricted workloads should run with hardened pod/container security controls. | Docker images drop to `node`, which is good, but Helm deployments do not define restricted `securityContext` controls such as `runAsNonRoot`, dropped capabilities, seccomp, and read-only root filesystem. |
| Kubernetes NetworkPolicy documentation | Policies must be explicit and enforced by a compatible CNI; egress controls should be narrow enough to matter. | Helm has default deny and service policies, but egress is mostly port-only broad egress and static K8s manifests are less complete. |
| PostgreSQL row security documentation | Superusers, `BYPASSRLS`, and table owners bypass RLS unless explicitly handled with role design and `FORCE ROW LEVEL SECURITY`. | Existing report remains valid: RLS exists, but DB role/startup posture and null-tenant policy are not 10/10. |

## 27.2 Updated Runtime And Release Scorecard

| Dimension | Seventh-pass score | Eighth-pass score | Why |
| --- | ---: | ---: | --- |
| Docker image production posture | 5.8 | 5.6 | Images run as non-root, but API and worker still run migrations during container startup. |
| Helm/Kubernetes readiness | 5.8 | 5.5 | Helm exists with HPAs/resources/network policies, but worker and tracker probes are incorrect and pod security is incomplete. |
| NetworkPolicy posture | 5.5 | 5.4 | Default deny exists, but broad port-only egress reduces value. |
| Secrets/config guard | 6.0 | 6.0 | Good secret/OIDC/provider checks, still missing RLS role, storage/KMS, ClickHouse/TLS, and full provider completeness checks. |
| Billing readiness | 6.0 implied | 5.8 | Stripe/PayPal/Cashfree scaffolding exists, but docs/spec drift and provider-real launch proof are incomplete. |
| Privacy/data lifecycle | 5.5 implied | 5.4 | Recipient delete/export and object deletion exist, but org deletion, ClickHouse erasure, legal hold, and durable audit are incomplete. |
| Deliverability/reputation | 5.5 | 5.7 | Postmaster/SNDS, DNSBL, warmup, and runbooks are real; still lacks source-IP routing proof and provider/live evidence. |
| QA/release evidence | 7.0 | 6.6 | CI is broad, but still omits SDK/docs build, k6, Helm validation, route parity, and release certification artifacts. |
| Overall production readiness | 4.9 | 4.9 | No material improvement found. |
| Overall enterprise readiness | 4.7 | 4.7 | Controls exist, but enterprise proof and governance remain incomplete. |

## 27.3 Deployment, Runtime, And Infrastructure Deep Hierarchy

Current deployment/runtime score: 5.5/10

| Module path | Score | Evidence found | Gap | 10/10 solution |
| --- | ---: | --- | --- | --- |
| Runtime -> API image -> Dockerfile | 5.8 | `packages/api/Dockerfile` builds shared/API and uses `USER node`. | `CMD` runs `node packages/shared/dist/bin/migrate.js && node packages/api/dist/server.js`, so every API container can attempt migrations at startup. | Remove startup migrations from app images; use a one-shot migration Job or release step with lock, timeout, rollback plan, and audited result. |
| Runtime -> Worker image -> Dockerfile | 5.6 | `packages/worker/Dockerfile` builds shared/worker and uses `USER node`. | Worker also runs migrations before starting worker process. Multiple workers can race with deploy migrations. | Same as API: migration job only, app container starts app only, startup fails if schema version is incompatible. |
| Runtime -> Tracker image | 6.2 | Tracker image exists and is separately scanned in CI. | Needs same runtime hardening and release proof as API/worker. | Add restricted security context, image digest pinning, smoke test, and probe validation. |
| Runtime -> Health/readiness -> API | 7.0 | API exposes `/health` and `/ready`; Helm API probes use `/live` for liveness and `/ready` for readiness. | API liveness uses `/live` in Helm, while local grep found `/health` and `/ready`; if `/live` is not registered elsewhere, liveness can fail. | Standardize `/live`, `/ready`, `/metrics`; add Helm render smoke test that curls every probe path against each built container. |
| Runtime -> Health/readiness -> Worker | 4.0 | Worker defaults `WORKER_METRICS_PORT` to `9100`; worker Helm exposes `9091` and probes `/health` on that port. | Probe port mismatch can keep worker pods unhealthy. | Set Helm `WORKER_METRICS_PORT=9091` or change Helm to `9100`; add chart unit test and kubeconform/helm test. |
| Runtime -> Health/readiness -> Tracker | 4.0 | Tracker exposes `/health`; Helm tracker probes use `/live`. | Tracker pods can fail liveness/readiness despite service being healthy. | Change Helm tracker probes to `/health` or implement `/live`; add probe contract tests. |
| Runtime -> Kubernetes resources | 6.5 | Helm values define CPU/memory requests and limits; HPAs exist for API/worker. | Autoscaling is CPU-centric; queue age/depth scaling is not release-gated. | Add KEDA/BullMQ queue-depth and queue-age autoscaling, latency/error SLOs, and load-based HPA tests. |
| Runtime -> Pod security | 4.5 | Images drop root user. | Helm templates do not define full restricted pod/container `securityContext`. | Add `runAsNonRoot`, `runAsUser`, `allowPrivilegeEscalation: false`, dropped capabilities, `seccompProfile: RuntimeDefault`, read-only root filesystem where possible, and namespace Pod Security labels. |
| Runtime -> NetworkPolicy | 5.4 | Helm has default deny plus API/worker/tracker policies. | Egress allows broad ports without destination selectors/CIDRs; static `infra/k8s` manifests are less complete. | Tighten egress by namespace/pod selector and approved external CIDR/FQDN policy; add Cilium/Calico policy tests in staging. |
| Runtime -> Secrets | 5.8 | `infra/k8s/secrets.example.yaml`, Helm existing secret, and production check exist. | No ExternalSecrets/SealedSecrets/Vault integration as a chart option; `.env` remains local/dev. | Add ExternalSecrets/SecretStore templates, secret rotation runbooks, and CI check that no production manifest embeds raw secret values. |
| Runtime -> TLS/ingress | 6.0 | Static K8s has cert-manager references; nginx config exists. | Helm ingress/cert-manager path needs stronger validation and smoke proof. | Add cert-manager Helm values, TLS smoke, HSTS validation, and certificate expiry alerts. |
| Runtime -> Observability | 6.5 | Prometheus alerts, Grafana dashboards, metrics, tracing tests, worker metrics exist. | Metrics/probe mismatch and release artifact gaps remain. | Require dashboard provisioning test, alert rule lint, metrics endpoint smoke, trace export smoke, and SLO burn-rate alerts. |
| Runtime -> Backup/restore | 5.8 | `scripts/backup-restore-drill.sh` exists and verifies table counts/migration history/key row counts. | Not wired to CI/staging schedule; no object storage/ClickHouse restore drill. | Run scheduled restore drill in staging; include Postgres, object store, ClickHouse, Redis queue snapshots where relevant; publish RPO/RTO evidence. |

## 27.4 Billing, Payments, Metering, And Revenue Integrity

Current billing score: 5.8/10

| Module path | Score | Evidence found | Gap | 10/10 solution |
| --- | ---: | --- | --- | --- |
| Billing -> Provider abstraction | 6.5 | `packages/shared/src/billing-provider.ts` supports mock, Stripe, PayPal, and Cashfree classes. | Provider support is not equal depth; docs and OpenAPI still drift. | Define provider capability matrix and block enabling providers that lack checkout, portal, webhook, usage, refund/dispute, and sandbox proof. |
| Billing -> Stripe | 6.5 | Checkout, portal, usage reporting, webhook verification, and tests exist. | Needs live/sandbox launch evidence, official SDK parity, retries/idempotency around outbound calls, and invoice reconciliation proof. | Add provider sandbox CI/staging job, outbound idempotency/retry audit, invoice event matrix, and reconciliation artifact. |
| Billing -> PayPal | 5.5 | PayPal scaffold, plan map, checkout approval URL, portal redirect, webhook verification exist. | PayPal has no Stripe-style usage API; docs admit manual invoice/overage handling. | Build explicit PayPal billing model: prepaid tiers, manual overage invoice workflow, webhook event matrix, and finance reconciliation. |
| Billing -> Cashfree | 5.3 | Cashfree provider and webhook route exist; DB constraint includes `cashfree`. | OpenAPI/docs still omit Cashfree in places; launch proof incomplete. | Add Cashfree to OpenAPI and docs, sandbox tests with official headers/API version, and provider-specific reconciliation. |
| Billing -> Webhook signature verification | 7.0 | Stripe/PayPal/Cashfree verification functions exist and production can fail closed when secrets are missing. | Verification is custom; provider event schemas and replay windows need broader coverage. | Use official verification where possible, enforce timestamp/replay windows, store event raw body hash, and add provider event contract tests. |
| Billing -> Metered usage | 6.0 | `reportMeteredUsage()` and scheduler metering reconciliation exist. | Usage reporting is scheduler-driven and not proven against provider invoices in staging. | Add daily metering job evidence, provider idempotency audit, invoice drift alerts, and finance dashboard. |
| Billing -> Account billing APIs | 6.0 | `/account/billing`, checkout, portal routes exist behind `billing:manage`. | No frontend product surface; no step-up for billing mutations. | Add customer billing UI, step-up auth, invoice list, payment method state, dunning status, and billing audit export. |
| Billing -> Contract/docs | 4.5 | Docs exist. | `docs/BILLING.md` says provider webhook path supports `stripe` or `paypal`, while code also supports `cashfree`; OpenAPI provider enum omits Cashfree. | Generate docs/OpenAPI from provider registry and fail CI on provider enum drift. |

## 27.5 Privacy, Retention, Data Lifecycle, And Compliance

Current privacy/data lifecycle score: 5.4/10

| Module path | Score | Evidence found | Gap | 10/10 solution |
| --- | ---: | --- | --- | --- |
| Privacy -> Recipient deletion | 6.3 | `/privacy/delete-recipient` deletes recipient data and captures offloaded body keys; object delete happens after DB commit. | Object deletion failure is warned but not retried; ClickHouse erasure is not covered; docs mention `audit_id` while code returns `request_id`. | Add erasure job/outbox with retries, ClickHouse deletion/tombstone workflow, object-store delete verification, and docs response parity. |
| Privacy -> Recipient export | 6.0 | `/privacy/export-recipient` exists. | Export scope and schema need OpenAPI/SDK parity and data inventory proof. | Build complete data map and export every store: Postgres, object body metadata, events, webhooks, support, billing references where lawful. |
| Privacy -> Deletion ledger | 5.8 | `/privacy/deletions` and `gdpr_deletion_requests` behavior exist. | Audit/ledger is not tamper-evident or WORM. | Add durable privacy job ledger, hash chain, immutable audit export, and compliance evidence package. |
| Privacy -> Account/org deletion | 1.0 | Still no complete org deletion workflow found. | Enterprise account lifecycle is missing. | Implement owner-only async org deletion with step-up, legal hold, billing cancellation, key/domain shutdown, queue cleanup, object/ClickHouse erasure, and recovery window. |
| Retention -> Message body retention | 6.5 | `retention.ts` purges offloaded body objects only when all referencing messages are past retention. | Retention job is admin-triggered; no scheduled proof; object delete failure handling needs retry ledger. | Add scheduled retention worker, delete retry table, object-store lifecycle policy, and retention report artifact. |
| Retention -> Audit retention | 4.5 | Retention purges `audit_log` older than configured days. | Enterprise audit should not be casually purged from the primary compliance record. | Split operational audit from immutable compliance audit; WORM/SIEM export before purge; retention policies per tenant/legal hold. |
| Compliance -> KMS/encryption | 6.8 | KMS abstraction supports env, AWS, GCP, Vault; DKIM/MFA/admin secrets use encryption helpers. | Production config guard does not fully enforce non-env KMS or key rotation posture. | Require external KMS in production, add key versioning, rotation migration tests, and startup check for KMS provider readiness. |
| Compliance -> Backups and restore | 5.5 | Postgres restore drill script exists. | No ClickHouse/object store restore and no scheduled release artifact. | Scheduled DR drill for all stores with RPO/RTO report and automated fail if drift exceeds threshold. |

## 27.6 Deliverability, Reputation, And MTA Operations

Current deliverability/reputation score: 5.7/10

| Module path | Score | Evidence found | Gap | 10/10 solution |
| --- | ---: | --- | --- | --- |
| Deliverability -> Domain authentication | 7.0 | SPF/DKIM/DMARC docs, domain service tests, DKIM key generation/encryption, DMARC policy migration exist. | Live DNS verification proof and customer UX are not complete productized flows. | Add customer DNS UI, resolver diagnostics, per-record propagation evidence, BIMI/MTA-STS/TLS-RPT roadmap, and live DNS regression tests. |
| Deliverability -> Bounce/complaint handling | 7.2 | Haraka inbound parser, DSN/ARF tests, VERP forgery resistance, soft-bounce suppression exist. | Real provider FBL onboarding evidence and mailbox/provider-specific parsing corpus need expansion. | Add provider FBL setup workflow, more real-world corpus, parser fuzzing, and complaint SLA metrics. |
| Deliverability -> Reputation guard | 6.3 | `evaluatePoolHealth`, DNSBL monitoring, alerts, dashboards, runbooks exist. | Guard is pool-level; per-IP action and customer/campaign attribution are not deep enough. | Add per-IP/provider/domain reputation model, campaign attribution, automatic quarantine, and operator approval workflow. |
| Deliverability -> Warmup | 5.8 | Per-pool and per-IP warmup functions and scheduler jobs exist. | Single send checks pool cap; batch parity and source-IP routing proof are incomplete. | Enforce warmup for single and batch at selected-IP level; persist selected IP; reconcile delivered events to warmup counters. |
| Deliverability -> Source-IP routing | 3.5 | Worker emits `X-MP-IP-Pool`; Haraka stores/removes header. | No confirmed outbound source-IP binding. | Implement MTA transport binding to selected IP and add staging proof that envelope leaves from that IP. |
| Deliverability -> Postmaster/SNDS | 6.0 | `ingestPostmaster()` and scheduler credentials checks exist; docs/runbooks mention setup. | Credentials and live ingestion are optional; no release proof. | Add staging/prod credential readiness checks, ingestion freshness SLO, and alert if Postmaster/SNDS data goes stale. |
| Deliverability -> Unsubscribe compliance | 7.0 | One-click/RFC 8058-style flow exists; visible footer exists. | Group unsubscribe enforcement gap remains. | Enforce group opt-out on every future send path and add E2E proof. |
| Deliverability -> Admin ops | 5.8 | Admin deliverability endpoints and runbooks exist. | Mostly API/runbook; no full operator console or automated incident workflow. | Build deliverability console with pool/IP/customer/campaign attribution, runbook actions, approvals, and audit. |

## 27.7 QA, CI, Release Certification, And Evidence

Current QA/release score: 6.6/10

| Module path | Score | Evidence found | Gap | 10/10 solution |
| --- | ---: | --- | --- | --- |
| CI -> Build/test | 6.8 | CI builds shared, API, worker, tracker; applies migrations; runs tests. | CI still does not build SDK or docs even though root scripts include them. | CI must run root `npm run build`, `npm run build:docs`, SDK package build, and docs static export. |
| CI -> Security | 7.0 | `npm audit`, CycloneDX SBOM artifact, Trivy image scans exist. | SBOM generation uses `|| true`; SBOM absence only warns; docs claim stronger posture than actual gate. | Make SBOM fail-closed, sign SBOM, attach image digest, add provenance/SLSA attestations. |
| CI -> Image scanning | 7.0 | API/worker/tracker images scanned by Trivy and fail on fixable high/critical. | Haraka/docs images are not in the matrix. | Scan all shipped images including Haraka inbound/outbound and docs. |
| CI -> Migrations | 6.8 | Migration ordering and apply tests exist; runner has checksum behavior. | No full up/down migration test and Docker images still run migrations at startup. | Release migration job with lock, dry-run, rollback plan, and isolated migration CI. |
| CI -> OpenAPI/route parity | 4.5 | OpenAPI spot tests exist. | No runtime route inventory parity. | Add Fastify route extraction and compare against OpenAPI, SDK, auth metadata, and docs. |
| CI -> SDK/docs snippets | 3.5 | SDK E2E exists. | SDK docs snippets are not compiled; docs build omitted in CI. | Compile every SDK docs snippet and build docs in CI. |
| CI -> Load testing | 4.5 | k6 script and in-process load harness exist. | k6 is not run in CI/staging release gate despite docs checklist claim. | Run k6 against staging nightly/release; store p95/p99/error-rate artifact. |
| CI -> Helm/K8s validation | 3.8 | Helm chart and static manifests exist. | No CI evidence for `helm template`, kubeconform, kube-linter, probe smoke, or pod security lint. | Add Helm render, kubeconform, kube-linter, Polaris/Kyverno policy tests, and probe contract smoke. |
| CI -> Backup/DR evidence | 4.5 | Backup drill script exists. | Not scheduled or release-gated; incomplete for object store/ClickHouse. | Run scheduled restore drills and attach evidence to release certification. |
| Release -> Certification package | 3.5 | Pieces exist across scripts/docs/tests. | No single release artifact with commit, image digests, test outputs, OpenAPI diff, SDK package, docs build, scans, load, restore. | Add `release:certify` pipeline that produces signed release evidence and blocks promotion without it. |

## 27.8 Eighth-Pass Invalid-Claim Ledger

| Claim or implied posture | Verdict | Why |
| --- | --- | --- |
| Helm probes are production-ready | Incorrect | Worker Helm port does not match worker default metrics port; tracker Helm probes use `/live` while tracker exposes `/health`; API liveness also appears to use `/live` while grep found `/health` and `/ready`. |
| Docker images are production-clean | Overstated | Images run as non-root, but API and worker run migrations during container startup. |
| Kubernetes pod security is production-grade | Overstated | Restricted pod security controls are not present in Helm deployment templates. |
| NetworkPolicy is strong | Partially valid but overstated | Default deny exists, but egress is broad port-only and does not tightly restrict destinations. |
| Billing provider docs/spec are current | Incorrect | Runtime supports Cashfree, but docs/OpenAPI still omit it in places. |
| Privacy deletion returns `audit_id` | Incorrect | Code returns `request_id`; docs still show `audit_id`. |
| Recipient deletion fully erases all stores | Overstated | Postgres and object body cleanup exist, but ClickHouse erasure/retry proof is incomplete. |
| KMS is production-enforced | Overstated | KMS providers exist, but production config does not force external KMS posture. |
| Postmaster/SNDS is only a TODO | Too harsh | Code and scheduler exist; the remaining gap is credential/live-ingestion proof. |
| k6 load test is CI-enforced | Incorrect | k6 script exists, but CI does not run it. |
| CI builds all packages | Incorrect | CI manually builds shared/API/worker/tracker and omits SDK/docs. |
| SBOM is a hard gate | Overstated | SBOM generation uses `|| true` and artifact missing only warns. |
| OpenAPI is generated from a complete route source | Incorrect | Existing route drift remains; tests are spot checks. |

## 27.9 Eighth-Pass Priority Backlog

Priority 0 - runtime correctness bugs:

1. Fix Helm probes:
   - Worker: align `WORKER_METRICS_PORT` with Helm port or change Helm port to `9100`.
   - Tracker: use `/health` or implement `/live`.
   - API: confirm `/live`; if absent, use `/health` or implement `/live`.
   - Add probe smoke tests for all container images.

2. Remove migrations from API/worker Docker `CMD`:
   - Keep Helm migration Job or release migration step.
   - Add schema compatibility check at app startup.
   - Add deploy lock and timeout for migrations.

3. Add restricted pod/container security contexts:
   - `runAsNonRoot`.
   - `allowPrivilegeEscalation: false`.
   - Drop all capabilities.
   - `seccompProfile: RuntimeDefault`.
   - Read-only root filesystem where feasible.

Priority 1 - release gates:

1. Build SDK and docs in CI.
2. Compile SDK docs snippets.
3. Run OpenAPI route parity tests.
4. Run Helm render/kubeconform/kube-linter.
5. Run k6 in staging or nightly release gate.
6. Make SBOM generation fail-closed and include all images.

Priority 2 - billing/privacy proof:

1. Fix Cashfree provider drift in docs/OpenAPI.
2. Add provider sandbox matrix for Stripe, PayPal, Cashfree.
3. Fix privacy docs response shape from `audit_id` to `request_id` or change API to return both.
4. Add privacy erasure retry ledger across object storage and ClickHouse.
5. Implement organization/account deletion workflow.
6. Add immutable compliance audit export before audit retention purge.

Priority 3 - deliverability proof:

1. Implement real selected-source-IP binding.
2. Enforce warmup and reputation gates for batch and selected IP.
3. Add Postmaster/SNDS freshness SLO and alerts.
4. Add provider FBL onboarding evidence and parser corpus expansion.
5. Build operator deliverability console.

## 27.10 Eighth-Pass Verdict

The markdown is still valid, but the deeper runtime pass adds two important nuances:

1. Some areas deserve credit for real implementation depth:
   - Billing provider abstraction is real.
   - Privacy recipient deletion/export is real.
   - KMS provider abstraction is real.
   - Postmaster/SNDS ingestion is more than a placeholder.
   - DNSBL, warmup, alerts, dashboards, and runbooks are real.

2. Those implementations are not enough for 10/10 because the release/runtime proof is weak:
   - Helm probes can be wrong.
   - App containers still run migrations.
   - Pod security is incomplete.
   - CI omits SDK/docs and k6.
   - OpenAPI/docs/provider drift remains.
   - Privacy erasure does not prove every store.
   - IP pool routing is not proven as source-IP binding.

Updated final score after eighth pass:

| Dimension | Score |
| --- | ---: |
| Deployment/runtime readiness | 5.5/10 |
| Billing/revenue readiness | 5.8/10 |
| Privacy/data lifecycle readiness | 5.4/10 |
| Deliverability/reputation readiness | 5.7/10 |
| QA/release evidence readiness | 6.6/10 |
| Overall production readiness | 4.9/10 |
| Overall SaaS readiness | 4.7/10 |
| Overall enterprise readiness | 4.7/10 |

# 28. Ninth-Pass Database Architecture End-To-End Validation

This pass adds a database-architecture-specific review across migrations, schema typing, tenant isolation, workflow transactions, queues/outbox, analytics, privacy, retention, backup/restore, and production data operations.

Three database-focused agents were spawned as requested, but they did not return within the wait window. This section is therefore based on local code inspection plus official PostgreSQL references for RLS, constraints, partitioning, and PITR/backup.

## 28.1 External Database Standards Cross-Check

| Reference | Relevant expectation | Impact on this platform |
| --- | --- | --- |
| PostgreSQL RLS documentation | RLS only protects data when enabled, policies are fail-closed, and the active role does not bypass RLS. Superusers, table owners, and `BYPASSRLS` roles can bypass it. | Existing RLS design is not 10/10 because policies allow all rows when tenant context is unset and production routes do not consistently use `withTenant()`. |
| PostgreSQL constraints documentation | Foreign keys, unique constraints, and check constraints are the database-level backstop for data integrity. | Many core tables are constrained well, but events, tracked links, review queue, audit log, soft-bounce tracker, and billing event provider namespace need stronger relational guarantees. |
| PostgreSQL partitioning documentation | High-volume time-series tables usually need real partitions, pruning, retention operations, and migration proof. | Comments mention monthly partitioning helpers, but no real Postgres partitioned `events`/`messages` tables were found. ClickHouse is partitioned, but Postgres operational hot tables are not. |
| PostgreSQL PITR/backup documentation | Production systems need continuous archiving, restore drills, and tested recovery objectives. | A Postgres restore drill script exists, but PITR, object store, ClickHouse, and full release-gated recovery evidence are incomplete. |

## 28.2 Database Architecture Scorecard

| Database area | Score | Why |
| --- | ---: | --- |
| Schema breadth/module coverage | 7.4 | Most product modules have real tables: tenants, keys, domains, messages, events, suppressions, templates, usage, audit, review, identity, support, billing, unsubscribe groups, outbox, reputation. |
| Relational integrity | 5.8 | Good FKs in many tenant tables, but important workflow tables lack FKs or composite tenant consistency constraints. |
| Tenant isolation/RLS | 4.0 | RLS exists but fails open when tenant context is null and is not wired across normal route execution. |
| Migration architecture | 6.8 | Lexical migrations, checksums, transactional apply, advisory lock, baseline support, and tests exist. Startup migrations and lack of down/expand-contract governance reduce score. |
| Transaction/outbox consistency | 7.0 | Normal send path uses transactional `send_outbox` and `SKIP LOCKED`; review approval and some async side effects bypass the same safety. |
| High-volume events/analytics architecture | 5.5 | Postgres events are indexed; ClickHouse has partitioned MergeTree/TTL. Dual-write is best-effort/drop-on-failure and Postgres event partitioning is absent. |
| Privacy/retention data lifecycle | 5.3 | Recipient deletion/export and retention exist, but ClickHouse erasure, org deletion, legal hold, immutable audit, and retryable erasure jobs are incomplete. |
| Backup/restore/DR | 5.0 | Restore drill exists for Postgres, but not fully scheduled/release-gated and not multi-store. |
| Production DB operations | 5.2 | Pooling exists, readiness checks exist, but PgBouncer/read replicas/PITR/schema compatibility/online migration governance are not complete. |
| Overall database architecture readiness | 5.8 | Strong early architecture, not 10/10 production database platform. |

## 28.3 Database Module Hierarchy

### 28.3.1 Core Tenant Schema

Current score: 6.4/10

| Submodule | Score | What exists | Missing/gap | 10/10 solution |
| --- | ---: | --- | --- | --- |
| Tenants -> `customers` | 7.0 | UUID primary key, unique email, tier/status checks, quotas, billing status/provider, KYC level, physical address. | Email is globally unique, which blocks same email across unrelated org contexts; account/org deletion model is missing. | Add org/account lifecycle states, deletion workflow, legal hold, customer security policies, and explicit owner/contact model. |
| API keys -> `api_keys` | 7.0 | Tenant FK, scopes array, prefix index, expiry/revoke, key type, rotation pointer. | Scopes are free-form array without DB enum/constraint; no per-key IP allowlist/metadata table; rotation pointer lacks FK. | Add normalized scopes or validated enum constraint, key policy table, rotated_from FK, last-used IP/UA, per-key quotas, and service account owner. |
| Domains -> `sending_domains` + `dkim_keys` | 7.3 | Tenant FK, unique `(customer_id, domain)`, DNS verification flags, encrypted DKIM key storage, selector rotation table. | No DB-level guarantee of one active DKIM selector per domain; DNS verification history is not normalized. | Add partial unique index for active DKIM key per domain, DNS check history table, failure reason columns, and rotation state machine constraints. |
| Messages -> `messages` | 6.8 | UUID PK, unique RFC message_id, tenant FK, status check, tags GIN, queued/status indexes, body offload columns, scheduled/cancel support. | `customer_id` FK lacks `ON DELETE` policy; high-volume partitioning absent; `ip_pool` is text not FK to `ip_pools`; template_id lacks FK. | Partition by time/customer strategy, add FK to `ip_pools(name)` or dedicated pool id, FK template_id, explicit customer delete behavior, archival table, and status transition constraints. |
| Events -> `events` | 5.5 | BIGSERIAL PK, event type check, indexes by message/customer/type/time, event_key unique idempotency. | `message_id` and `customer_id` are not FK enforced; no composite consistency ensuring event belongs to message tenant; no Postgres partitioning. | Add FK to messages or controlled deferred FK/composite `(customer_id,message_id)`, monthly partitions, event type registry, retention partitions, and archival policy. |
| Tracked links -> `tracked_links` | 5.0 | Link table and message index exist. | No FK to messages; no tenant column; deletion/export depends on joins by message only. | Add `customer_id`, FK/composite FK to messages, unique link hash, and privacy erasure indexes. |
| Suppressions -> `suppressions` | 7.4 | Composite PK `(customer_id,email)`, tenant FK, reason check, email lookup index. | Email normalization enforcement depends on app; no source/event reference; no retention/legal-basis metadata. | Add normalized email generated column, suppression source enum, source_event_id, legal basis, import batch id, and audit link. |
| Templates -> `templates` | 6.7 | Tenant FK, unique `(customer_id,name)`, update trigger. | No immutable versions; comments call it versioned by `updated_at`, but updated-at is not real versioning. | Add `template_versions`, active version pointer, render checksum, approval state, and rollback. |

### 28.3.2 Identity, RBAC, And Sessions Data Model

Current score: 6.3/10

| Submodule | Score | What exists | Missing/gap | 10/10 solution |
| --- | ---: | --- | --- | --- |
| Users -> `users` | 7.0 | UUID PK, lower(email) unique index, password hash, MFA flag, lockout fields. | No tenant-level allowed domain or SSO identity mapping. | Add external identities, tenant security policy, password policy version, and user lifecycle audit fields. |
| Memberships -> `memberships` | 7.0 | User/customer FKs, role check, unique user-org pair. | No custom roles/groups; no SCIM deprovisioning state. | Add roles table, role bindings, SCIM external ids, group mappings, and membership status history. |
| User sessions -> `user_sessions` | 6.8 | Hashed token, current org, IP, UA, MFA satisfaction, expiry/revocation, indexes. | Good base, but no device table, session risk, or policy version enforcement. | Add device/session inventory, last_seen index, auth method, assurance level, policy_version, and revoke reason. |
| MFA -> `mfa_factors` and `mfa_recovery_codes` | 7.0 | Encrypted factor secret, recovery code hashes, replay tracking. | Only TOTP; no WebAuthn/passkey schema. | Add WebAuthn credentials, authenticator metadata, attestation/AAGUID, backup eligibility, and recovery event audit. |
| Invites -> `user_invites` | 5.0 | Token hash, tenant FK, role check, unique invite per customer/email. | No acceptance transaction guarantee in schema; no MFA/SSO requirement state; unique active invite can block re-invite lifecycle. | Add invite status history, accepted_by_user_id, accepted_at, policy_snapshot, SSO-required flag, and transactional accept constraints. |
| Admin sessions -> `admin_sessions` | 5.5 | Admin FK, token hash, expiry. | No unique token hash constraint in migration, no IP/UA/last_seen/revoked_at. | Add unique token hash, IP, UA, last_seen, revoked_at, auth method, assurance level, JIT grant id. |

### 28.3.3 Workflow, Queue, Outbox, And Consistency Tables

Current score: 7.0/10

| Submodule | Score | What exists | Missing/gap | 10/10 solution |
| --- | ---: | --- | --- | --- |
| Send outbox -> `send_outbox` | 8.2 | FK to messages(message_id), unique message_id, status check, pending index, customer/status index, `FOR UPDATE SKIP LOCKED` drainer. | Only normal send path uses it consistently; review approval bypasses outbox and directly adds BullMQ jobs. | Route every send-producing workflow through outbox; add outbox age SLO, dead-letter handoff, replay tooling, and transactional review approval. |
| Idempotency -> `idempotency_keys` | 7.2 | Tenant FK, unique `(customer_id,idempotency_key)`, request hash, response body/status, expiry cleanup. | Applied to `/send` only, not batch; response body as JSON may need size limits. | Extend to batch and sensitive mutation APIs; add body size limit, TTL partition/index, and conflict metrics. |
| Review -> `review_queue` | 5.8 | Risk score/reasons/status, pending index, links message_id/customer_id by values. | No FK to messages/customer; no assignment/SLA/version fields; approval not transactional with outbox. | Add FK/composite FK, assigned_to, SLA, decision reason, model version, policy version, and outbox transaction. |
| DLQ -> Redis/BullMQ metadata | 6.0 | DLQ service exists for queues and admin replay. | DLQ is not a relational durable table; replay audit and payload retention are limited. | Add DB-backed DLQ ledger with queue, job id, payload hash/location, retries, replay/delete audit, and retention. |
| Scheduler -> stale send/review/metrics jobs | 6.2 | Scheduler jobs recover stale sends, reject old reviews, reconcile metering, drain outbox. | Scheduler state/locks are mostly process/Redis oriented; no job run history table. | Add scheduler_run table, advisory locks, idempotent job keys, run duration/error metrics, and alertable stale scheduler SLO. |

### 28.3.4 Billing And Usage Data Model

Current score: 5.9/10

| Submodule | Score | What exists | Missing/gap | 10/10 solution |
| --- | ---: | --- | --- | --- |
| Usage -> `usage_daily` | 7.0 | Composite PK, tenant FK, sent/delivered/bounced/complained counters, quota reads. | Redis is source of immediate reservation; reconciliation model could drift; no per-key/campaign granularity. | Add reservation ledger, per-key/campaign dimensions, reconciliation job, and immutable billing usage snapshots. |
| Subscriptions -> `subscriptions` | 6.3 | Tenant FK, provider, provider_subscription_id unique, plan/status, period fields. | Provider enum not constrained in this table; provider_subscription_id globally unique but nullable; no provider_customer_id relation. | Add provider enum, unique `(provider, provider_subscription_id)`, provider_customer_id, cancellation reason, and state transition table. |
| Invoices -> `invoices` | 5.8 | Tenant FK, provider invoice id, period, billed/metered quantities, drift. | No line items, tax/currency model, payment attempts, hosted invoice URL, or immutable invoice snapshot. | Add invoice_items, payment_attempts, tax fields, hosted URL, provider raw event link, immutable snapshot JSON, and reconciliation status. |
| Billing events -> `billing_events` | 5.5 | Primary key by provider_event_id, processed timestamp. | No provider column in primary key, no event payload hash/raw body, no customer link. Event IDs can theoretically collide across providers. | Change to `(provider, provider_event_id)`, store type, customer_id, raw payload hash/location, signature timestamp, replay status, and processing result. |
| Quota notifications -> `quota_notifications` | 6.0 | Composite PK prevents duplicate threshold alerts. | No FK to customer in migration output; no delivery result/webhook correlation. | Add FK, notification channel/result, event_id, webhook delivery relation, and retry policy. |

### 28.3.5 Support, Admin, Audit, And Compliance Data Model

Current score: 5.9/10

| Submodule | Score | What exists | Missing/gap | 10/10 solution |
| --- | ---: | --- | --- | --- |
| Audit -> `audit_log` | 5.2 | BIGSERIAL PK, action/resource/IP/metadata, actor columns/indexes. | `customer_id` and `api_key_id` are not FK-enforced; audit is mutable/deletable; no hash chain/WORM export. | Add FK where safe, immutable append-only permissions, hash chain, audit_outbox, SIEM/WORM export, legal retention, and critical-action fail-closed behavior. |
| Support tickets -> `support_tickets` | 7.0 | Tenant FK, status/priority/category checks, user/admin references, indexes, SLA/CSAT fields. | No RLS policy coverage in migration 023; support-specific customer capabilities missing elsewhere. | Add RLS policy, customer support capabilities, attachment table, SLA policy table, escalation history. |
| Support messages/reads | 7.0 | Ticket FK cascade, author checks, read uniqueness indexes. | Attachment/PII redaction/governance missing. | Add attachment table, redaction table, visibility policy, retention policy, and audit links. |
| Admin users | 6.2 | Role check, OIDC subject unique, lockout/MFA fields later. | Admin sessions weaker; no JIT access grants table. | Add admin_access_grants, approval workflow, session inventory, and OIDC group mapping table. |
| Privacy deletion -> `deletion_requests` | 5.5 | Tenant FK, recipient, counts, status. | Named `deletion_requests` while API/docs also refer to privacy deletion; no multi-store job state, no ClickHouse/object retry details. | Add privacy_jobs with per-store steps, legal hold, requested_by user/api/admin, object keys, ClickHouse tombstone, verification timestamp. |

### 28.3.6 Analytics And High-Volume Storage

Current score: 5.5/10

| Submodule | Score | What exists | Missing/gap | 10/10 solution |
| --- | ---: | --- | --- | --- |
| Postgres events | 5.8 | Indexed by message/customer/type/time and has event_key idempotency. | No declarative partitioning; high-volume retention deletes rows directly; event FK integrity is weak. | Partition by month, add partition management, retention by dropping partitions, composite FK or integrity checks, and event archival policy. |
| ClickHouse events | 6.5 | MergeTree table, monthly partition, customer/time order, TTL 90 days, daily materialized view. | Not the source of truth and not durable because writes are best-effort and dropped during circuit-open. | Add analytics_outbox in Postgres, retry worker, exactly-once-ish insert keys, backfill/reconciliation, and freshness/drift metrics. |
| Analytics APIs | 5.5 | Postgres event aggregation endpoints exist. | Product analytics not fully moved to durable ClickHouse path; raw vs bot-filtered semantics need clearer defaults. | Query ClickHouse with fallback/reconciliation, expose raw/human/machine metrics, and SLO for analytics freshness. |
| Retention | 5.4 | Retention function purges message bodies, events, audit, review rows. | Direct deletes on huge events table will become expensive; audit purge conflicts with enterprise compliance. | Use partitions for events, immutable audit export, retention policies per tenant, legal hold, and deletion job ledger. |

### 28.3.7 Migration, Connection, Backup, And DB Ops

Current score: 5.9/10

| Submodule | Score | What exists | Missing/gap | 10/10 solution |
| --- | ---: | --- | --- | --- |
| Migration runner | 7.2 | Lexical SQL files, checksum drift detection, transactional per-file apply, advisory lock, baseline mode, migration tests. | App Dockerfiles still run migrations at startup; no expand/contract policy; no online migration lint. | Move migrations to release job only, add schema compatibility checks, lock timeout, expand/contract migration guide, no-blocking-DDL linter. |
| Migration tests | 6.8 | Fresh DB migration tests and ordering tests exist. | No production-like large-table migration simulation or downgrade/rollback plan. | Add migration performance tests with seeded volume, lock-time checks, rollback/forward-fix runbooks, and restore-before-migrate rehearsal. |
| DB connection pool | 5.8 | Shared pg Pool with max 20 and Kysely. | Static per-process pool can exhaust Postgres across API/worker replicas; no PgBouncer config found. | Add PgBouncer or managed pooler, per-service pool sizing, connection budget tests, and slow query logging. |
| Backup/restore | 5.0 | Postgres backup-restore drill script verifies schema_migrations and key table counts. | Not release-gated; no PITR config proof; no ClickHouse/object-store restore. | Scheduled PITR restore drill, object/ClickHouse restore drill, RPO/RTO artifact, and release certification evidence. |
| Read replicas/reporting | 4.5 | No clear read-replica routing found. | Analytics/admin/reporting can pressure primary Postgres. | Add read replica support for analytics/admin reads, lag-aware routing, and primary protection limits. |

## 28.4 Database-Specific Invalid-Claim Ledger

| Claim or implied posture | Ninth-pass verdict | Why |
| --- | --- | --- |
| RLS adds defense-in-depth tenant isolation for API routes | Overstated | RLS works only when `app.customer_id` is set, but policies allow all rows when it is null and production route execution does not consistently use `withTenant()`. |
| Migration 004 adds monthly partitioning helpers | Overstated | The migration comment mentions monthly partitioning helpers, but no actual Postgres partitioned `messages` or `events` table was found. |
| Events are fully relationally tied to messages | Incorrect | `events.message_id` is text without FK to `messages(message_id)` and customer/message tenant consistency is not DB-enforced. |
| Review queue is strongly tied to messages | Overstated | `review_queue.message_id` and `customer_id` are values without FK constraints in migration 002. |
| Audit log is a durable compliance record | Overstated | `audit_log` lacks strong FK enforcement, can be purged by retention, and is not tamper-evident. |
| ClickHouse analytics are durable | Incorrect | ClickHouse writes are explicitly best-effort; circuit-open drops rows. |
| `provider_event_id` is enough for multi-provider billing idempotency | Weak | It is a global primary key without provider namespace; safer design is `(provider, provider_event_id)`. |
| Account/org deletion can rely on cascade | Incorrect | Some core rows cascade, but messages do not declare cascade, and several operational tables have weak/no FK linkage. A real org deletion workflow is still required. |
| Database architecture is 10/10 because the schema is broad | Incorrect | Breadth is strong, but fail-open RLS, missing FKs, absent partitioning, weak audit immutability, and release/backup proof prevent 10/10. |

## 28.5 Database 10/10 Remediation Plan

Priority 0 - tenant isolation and data correctness:

1. Make RLS fail closed for the API role:
   - Remove `OR current_tenant_id() IS NULL` from app-role policies.
   - Use separate service roles for workers/migrations/admin where bypass is truly required.
   - Apply `FORCE ROW LEVEL SECURITY` where table-owner bypass is a risk.
   - Wire tenant route execution through `withTenant()` or a tenant-scoped DB executor.
   - Add CI that fails when a tenant route uses global `db` instead of tenant executor.

2. Add missing relational integrity:
   - `events`: add composite integrity to `messages(customer_id,message_id)` or an event FK strategy.
   - `tracked_links`: add `customer_id` and FK/composite FK.
   - `review_queue`: add FK/composite FK to message/customer.
   - `audit_log`: add nullable FKs where safe and immutable compliance sink.
   - `soft_bounce_tracker`, `quota_notifications`: add customer FKs.
   - `billing_events`: use `(provider, provider_event_id)`.

3. Fix review approval consistency:
   - Approval must update review status, message status, event row, and `send_outbox` in one DB transaction.
   - No direct `sendQueue.add` from review approval.

Priority 1 - high-volume data design:

1. Partition Postgres `events` by month or time range.
2. Consider partitioning/archiving `messages` for high-volume tenants.
3. Replace direct retention deletes with partition drop/archive where possible.
4. Add event retention jobs with lock/impact metrics.
5. Add slow query logging and explain-plan regression tests for analytics/activity/support queries.

Priority 2 - analytics durability:

1. Add `analytics_outbox` table in Postgres.
2. Event worker writes ClickHouse jobs to outbox transactionally.
3. Dedicated analytics writer retries until acknowledged.
4. Add ClickHouse backfill from Postgres events.
5. Add freshness/drift metrics and dashboards.

Priority 3 - migrations and DB operations:

1. Remove app startup migrations from API/worker containers.
2. Add release-only migration job with advisory lock timeout and schema version check.
3. Add expand/contract migration policy.
4. Add PgBouncer or managed pooler and connection budget tests.
5. Add PITR restore drill and multi-store DR evidence.
6. Add read-replica routing for analytics/admin reads.

Priority 4 - compliance/audit/privacy:

1. Split operational audit from immutable compliance audit.
2. Add audit hash chain and WORM/SIEM export.
3. Add privacy job ledger with per-store steps.
4. Add org/account deletion workflow with legal hold.
5. Add data inventory mapping every table to retention, export, deletion, and legal basis.

## 28.6 Database Architecture Verdict

The database architecture is much stronger than a prototype. It has broad module coverage, meaningful checks and indexes, a real migration runner, a transactional send outbox, support/billing/identity schemas, RLS primitives, ClickHouse schema, and restore-drill tooling.

It is not 10/10 because the highest-risk database properties are not fully enforced:

1. Tenant isolation is not fail-closed.
2. Several workflow tables are not relationally tied strongly enough.
3. High-volume Postgres tables are not partitioned.
4. ClickHouse analytics can drop rows.
5. Audit is not immutable or durable enough for enterprise compliance.
6. Migrations still run inside app container startup.
7. Backup/restore evidence does not cover every store.
8. Database operations lack full connection pooling/read-replica/online-migration governance.

Updated database architecture scores:

| Database dimension | Score |
| --- | ---: |
| Schema breadth | 7.4/10 |
| Relational integrity | 5.8/10 |
| Tenant isolation/RLS | 4.0/10 |
| Migration architecture | 6.8/10 |
| Transaction/outbox consistency | 7.0/10 |
| Analytics/high-volume design | 5.5/10 |
| Privacy/retention DB lifecycle | 5.3/10 |
| Backup/restore/DR | 5.0/10 |
| Production DB operations | 5.2/10 |
| Overall database architecture readiness | 5.8/10 |

Overall platform score remains unchanged after this database pass:

| Dimension | Score |
| --- | ---: |
| Overall production readiness | 4.9/10 |
| Overall SaaS readiness | 4.7/10 |
| Overall enterprise readiness | 4.7/10 |

# 29. Tenth-Pass Agent-Returned Database Corrections

This section incorporates the three database agents that returned after section 28 was already written. These findings are sharper than the first local database pass because they focus on crash consistency, workflow idempotency, schema drift, production database operations, and database-backed failure modes.

The important correction: section 28 credited the normal send outbox and workflow architecture too generously. The outbox pattern exists and is valuable, but several crash windows prevent it from being production-grade.

## 29.1 Revised Database Scores After Agent Findings

| Database area | Section 28 score | Revised score | Why changed |
| --- | ---: | ---: | --- |
| Database architecture overall | 5.8 | 5.5 | Agents confirmed broad schema coverage but found deeper workflow crash windows and data-platform operations gaps. |
| Workflow/outbox consistency | 7.0 | 6.1 | `send_outbox` can strand rows as `enqueued`; review approval bypasses outbox; send worker duplicate-job claim is not atomic. |
| Tenant isolation/RLS | 4.0 | 3.5 | RLS covers only early core tenant tables and remains fail-open without tenant context. |
| RLS API integration | 4.0 implied | 2.5 | `withTenant()` exists, but route execution still uses global `db` patterns. |
| Migration production rollout | 6.8 | 5.5 | Runner is good, but API/worker/tracker images run migrations and Helm has a separate migration job. |
| Schema type drift protection | 6.0 implied | 3.0 | `schema.ts` is hand-maintained; no generated Kysely types or DB-vs-type CI drift gate. |
| Analytics durability | 5.5 | 3.5 | ClickHouse path explicitly drops rows on failure/circuit-open. |
| Backups/PITR/DR | 5.0 | 4.0 | Restore drill is useful but does not prove PITR, object store, ClickHouse, Redis/DLQ, RPO/RTO, or scheduled staging execution. |
| Query/index coverage | 6.0 implied | 5.5 | Several retention/activity/scheduled/lowercase filters lack ideal indexes and EXPLAIN-budget tests. |
| Overall database readiness | 5.8 | 5.5 | Still strong for an early production candidate, not production-grade data architecture. |

## 29.2 Critical Database Workflow Findings

| Finding | Severity | Why it matters | Required 10/10 fix |
| --- | --- | --- | --- |
| `send_outbox` can strand rows as `enqueued` before Redis has the job. | Critical | The drainer marks rows `enqueued` inside a DB transaction, then adds Redis jobs afterward. A crash between those steps leaves no Redis job and no future drain because the drain only selects `pending`. | Add `claiming` state with `claimed_at`/`claim_owner`, mark `enqueued` only after Redis success, and reclaim stale `claiming/enqueued` rows if deterministic BullMQ job is missing. |
| Event idempotency can suppress required downstream side effects. | Critical | Event insert and usage increment happen first. If later message status, suppression, ClickHouse, or webhook fanout fails, a retry sees duplicate `event_key` and exits early. | Treat `event_key` as a processing ledger with stages, or move status/suppression/webhook outbox writes into the same transaction as event insert. |
| Send worker does not atomically claim messages. | Critical | Duplicate jobs or admin/DLQ replay can read the same queued message and both send because status is not claimed via `UPDATE ... WHERE status='queued' RETURNING`. | First statement in worker should atomically claim: `UPDATE messages SET status='sending', sending_at=now() WHERE message_id=? AND status IN (...) RETURNING *`; no row means skip. |
| Stale send recovery resets `messages` but not `send_outbox`. | Critical | Scheduler resets stale message state, but `send_outbox` can remain `enqueued`; the outbox drainer ignores it. | Recovery must reset/recreate the outbox row or verify/recreate deterministic Redis job. |
| `billing_events` marker is inserted before subscription state application. | High | If subscription/customer update fails after the marker insert, provider retries are skipped as duplicates. | Process billing event and state mutation in one transaction, or use `processing/applied/failed` event state with retry. |
| Idempotent send response is only recorded in `onSend`. | High | Crash after message/outbox commit but before response recording leaves idempotency key `in_progress`; after TTL cleanup, duplicate request can create another send. | Persist idempotency final result transactionally with message/outbox commit, or store deterministic message ids and recover response from DB. |
| ClickHouse dual-write is lossy by design. | High | Buffer is dropped before HTTP success and circuit-open drops events. This is acceptable only for best-effort analytics. | Add `analytics_outbox`, retry writer, backfill from Postgres, ClickHouse drift metrics, and operator replay tooling. |

## 29.3 Schema And RLS Corrections

| Area | Finding | 10/10 fix |
| --- | --- | --- |
| RLS table coverage | RLS only enables early core tables: messages, events, suppressions, templates, sending_domains, webhooks, api_keys, usage_daily, review_queue. Tenant tables such as idempotency_keys, send_outbox, support_tickets, subscriptions, invoices, deletion_requests, unsubscribe_groups, memberships, and soft_bounce_tracker are not RLS-enabled. | Add RLS or explicitly documented service-only access controls for every tenant table, with CI proving coverage. |
| RLS policy shape | Policies use `customer_id = current_tenant_id() OR current_tenant_id() IS NULL`, so missing tenant context becomes all-tenant access. | Remove null-tenant allow for app roles; use explicit service roles for workers/migrations/admin. |
| RLS API integration | `withTenant()` exists but callers must use the passed transaction. Many route/service paths still use global `db`. | Introduce request-scoped DB context and fail CI when tenant routes access global `db`. |
| `schema.ts` drift | Type coverage is broad, but it is not generated from the live migrated DB and has no drift gate. | Generate Kysely types from migrations/applied DB or add CI comparing tables, columns, nullability, FKs, indexes, checks, enums, and RLS to `schema.ts`. |
| Event/link/review FKs | `events`, `tracked_links`, and `review_queue` are not fully FK-tied to messages/customers. | Add composite message integrity, tenant consistency constraints, and explicit retention/delete behavior. |
| Unsubscribe group consistency | `unsubscribe_group_members.customer_id` can drift from the group owner because composite group/customer integrity is not enforced. | Add composite unique key on `unsubscribe_groups(id, customer_id)` and FK from members `(group_id, customer_id)`. |
| Audit durability | `recordAuditSafe()` swallows writes and retention deletes `audit_log`. | Add audit_outbox, immutable/WORM/SIEM export, hash chain, and fail-closed audit for critical mutations. |

## 29.4 Data Platform Operations Corrections

| Area | Finding | 10/10 fix |
| --- | --- | --- |
| Startup migrations | API, worker, and tracker Docker images run migrations at startup, while Helm also defines a pre-install/pre-upgrade migration job. | Remove migrations from all app image `CMD`s; use exactly one locked release migration job. |
| Helm migration command | Helm migration job runs `dist/bin/migrate.js`, but images contain/use `packages/shared/dist/bin/migrate.js`. | Fix Helm command and add Helm migration smoke test. |
| Migration checksum | Checksums are truncated to 16 hex chars. | Store full SHA-256 and include checksum verification in release evidence. |
| Migration governance | CI only checks lexical sorting, not strict numbering, gaps, destructive SQL, lock risk, or expand/contract labels. | Add strict migration linter: `NNN_name.sql`, contiguous sequence, no destructive DDL without annotation, timeout-safe DDL, expand/contract metadata. |
| HA/PITR | Docs mainly assume managed Postgres/PITR; no concrete runbook/drill evidence. | Add real PITR restore drill, failover drill, RPO/RTO evidence, TLS/least-privilege role posture, and recovery runbook. |
| Pooling/read replicas | Single `DATABASE_URL` with fixed pg pool max; no PgBouncer/RDS Proxy/read-replica routing found. | Add pooler, env-configurable per-service pool sizes, connection budget tests, read-replica routing for analytics/admin reads. |
| Partitioning | ClickHouse is partitioned, but Postgres `events`, `audit_log`, and `messages` are not. Retention is row-delete/update based. | Partition high-volume Postgres tables and perform retention by partition drop/archive. |
| Index coverage | Retention/activity/scheduled/lowercase filters need stronger matching indexes and plan tests. | Add indexes and EXPLAIN-budget tests for analytics, retention, message activity, scheduled sends, lower-case address filters, and privacy deletion. |
| KMS consistency | Shared TS code has KMS abstraction, but Haraka DKIM decrypts directly from `ENCRYPTION_KEY`. | Integrate Haraka with same KMS provider or move signing to a service that uses shared KMS. |
| Privacy DSAR | Recipient deletion covers Postgres rows and body objects, but not ClickHouse copies, backups, Redis/DLQ payloads, logs, or legal hold. | Build DSAR job ledger covering Postgres, ClickHouse, object store, Redis/DLQ, logs, backups/tombstones, and legal hold. |

## 29.5 Documentation And Claim Corrections

| Claim/document | Verdict | Required correction |
| --- | --- | --- |
| Early DB/schema/migrations score around 7.5 | Overstated | Use the later database score range: 5.4-5.8 overall, with RLS/API integration far lower. |
| `schema.ts` type coverage around 8.0 | Overstated | Split "broad hand-maintained coverage" from "generated drift protection"; drift protection is about 3/10. |
| "RLS enables important tenant tables" | Incomplete | State exactly which tables have RLS and which tenant tables do not. |
| "Stale recovery requeues via outbox drain" | Incorrect | Stale recovery resets message state and emits event; it does not reset/recreate an ignored `enqueued` outbox row. |
| "billing_events is replay-safe" | Overstated | It suppresses duplicates, but is not atomic with state application. |
| "ClickHouse dual-write" | Overstated | It is best-effort analytics firehose and lossy on failure. |
| Privacy docs "permanently erases all stored data" | Overstated | It does not erase ClickHouse/backups/Redis/DLQ/logs and docs use `email` while API delete expects `recipient`. |
| "KMS-pluggable encryption" for full mail path | Overstated | Haraka DKIM decrypt path bypasses `KMS_PROVIDER`. |
| Architecture doc "No object storage in this version" | Stale | Storage offload exists; docs should be updated. |

## 29.6 Crash-Consistency Acceptance Tests Required For 10/10

| Test | Expected proof |
| --- | --- |
| Crash after outbox DB claim before Redis add | Row is reclaimed or deterministic Redis job is created later; message is not stranded. |
| Duplicate send jobs for same message | Only one worker can atomically claim and send; the other exits without delivery. |
| Event worker failure after event insert before webhook fanout | Retry completes status/suppression/webhook side effects instead of exiting as duplicate. |
| Billing webhook failure after replay marker insert | Provider retry still applies subscription/customer state or event remains retryable. |
| Review approval double-click | Only one approval path wins and it writes send_outbox transactionally. |
| Stale send recovery with `send_outbox.enqueued` and missing Redis job | Recovery resets or recreates outbox/job and eventually sends or fails visibly. |
| ClickHouse outage | Events persist in analytics_outbox and backfill after recovery; drift monitor returns to zero. |
| Privacy deletion with object/ClickHouse failure | DSAR job remains retryable and reports per-store completion status. |
| Migration job path in Helm | Rendered Helm job runs the correct `packages/shared/dist/bin/migrate.js` command and succeeds against a migrated DB. |
| RLS missing customer filter route | A deliberately broken route/query cannot leak cross-tenant rows under app DB role. |

## 29.7 Final Database Verdict After Agent Corrections

The database architecture is broad and serious, but the production-grade score must be lower than a surface scan suggests. The platform has many correct building blocks, yet several are not composed with crash consistency, tenant fail-closed behavior, and operational proof.

Updated database score after integrating all three database agents:

| Database dimension | Score |
| --- | ---: |
| Schema breadth | 7.3/10 |
| Schema drift protection | 3.0/10 |
| Relational integrity | 5.6/10 |
| Tenant isolation/RLS policy | 3.5/10 |
| Tenant isolation/API integration | 2.5/10 |
| Workflow/outbox crash consistency | 6.1/10 |
| Send worker concurrency safety | 5.0/10 |
| Event processing/idempotency safety | 5.0/10 |
| Billing DB consistency | 5.0/10 |
| Migration runner basics | 7.0/10 |
| Migration production rollout | 5.0/10 |
| Postgres HA/PITR/read-replica architecture | 3.5/10 |
| Query/index/partitioning readiness | 5.0/10 |
| ClickHouse analytics durability | 3.5/10 |
| Cross-store privacy/compliance lifecycle | 5.3/10 |
| Overall database architecture readiness | 5.5/10 |

Overall platform score remains unchanged:

| Dimension | Score |
| --- | ---: |
| Overall production readiness | 4.9/10 |
| Overall SaaS readiness | 4.7/10 |
| Overall enterprise readiness | 4.7/10 |

# 30. Eleventh-Pass Micro-Level Architecture Validation

This pass goes below feature/module scoring and validates the micro-level architecture: how routes are registered, how auth boundaries are composed, whether validation is the runtime contract, whether queues are crash-safe, whether database isolation is actually enforced at execution time, whether shared package exports create side effects, and whether deployment/docs claims match code.

Sources used in this pass:

- Local code inspection across `packages/api`, `packages/worker`, `packages/tracker`, `packages/haraka-inbound`, `packages/haraka-outbound`, `packages/shared`, `infra/helm`, `docs`, and `infra/migrations`.
- Three read-only subagent audits: API architecture, worker/MTA/tracker architecture, and shared-package/cross-module contracts.
- External baseline references: OWASP ASVS, OWASP API Security Top 10 2023, Fastify hooks, Fastify validation/serialization, and Fastify error handling documentation.

## 30.1 Executive Micro-Architecture Verdict

The platform has many real production building blocks, but it is not 10/10 production-grade, SaaS-grade, or enterprise-grade at micro-architecture level. The repeated pattern is this: features exist, but critical guarantees are not centrally enforced or proven.

| Dimension | Score | Why |
| --- | ---: | --- |
| API micro-architecture | 5.8/10 | Fastify boot, auth scopes, headers, rate limits, and error handler exist, but route validation, OpenAPI parity, tenant execution, route metadata, and error envelopes are not enforced centrally. |
| Worker and queue micro-architecture | 6.2/10 | Queue workers, scheduler, DLQ, metrics, and graceful shutdown exist, but send claim, outbox drain, event side effects, and replay semantics are not crash-consistent enough. |
| Tracker micro-architecture | 6.3/10 | Open/click/unsubscribe flows exist with bot detection and one-click support, but config guard is not enforced, tracking links are not strongly signed, and global tracking rate limits are weaker than comments imply. |
| Haraka MTA micro-architecture | 7.0/10 | Inbound VERP/FBL parsing and outbound DKIM/header plugins are real, but KMS is bypassed in JS plugin code, live MTA proof is limited, and provider corpus testing is incomplete. |
| Shared package/cross-module architecture | 5.6/10 | Many domain modules exist, but the root barrel exports infra singletons/test utilities, schema is hand-maintained, provider contracts drift, and tenant context is optional. |
| Database execution architecture | 5.2/10 | Schema breadth is good, but API routes do not run through tenant-scoped executors, RLS policies fail open on null tenant, and crash consistency gaps remain. |
| Deployment/runtime architecture | 5.1/10 | Containers exist, but app-start migrations, Helm command/probe/port drift, and missing release evidence prevent enterprise confidence. |
| Overall micro-level production grade | 5.8/10 | Broadly functional, but not fail-closed, not contract-generated, not crash-consistency proven, and not fully operationally governed. |

## 30.2 Claims That Must Be Superseded By This Pass

| Earlier claim or score | Verdict | Corrected position |
| --- | --- | --- |
| API Server Core around 8/10 | Overstated | API core is closer to 6.5/10; route metadata, OpenAPI parity, error envelope coverage, RLS boot checks, and tenant executor integration are missing. |
| Error envelope around 7.5/10 | Overstated | Central thrown-error handling exists, but many manual `reply.code().send({ error })` paths bypass `request_id` and consistent `message/details`. |
| API-key auth around 8/10 | Slightly overstated | Prefix lookup, hashing, expiry/status checks exist, but auth does not bind requests to a tenant DB executor and response shapes are inconsistent. |
| Route validation is production-grade | Overstated | Most validation is handler-local Zod parsing, not Fastify schema-bound validation. Runtime schemas, OpenAPI, SDKs, and docs can drift. |
| OpenAPI is a single source of truth | Incorrect wording | `openapi.ts` is hand-maintained and stale versus runtime routes/providers. It is not generated from registered route schemas. |
| RLS protects API tenant routes | Incorrect for current execution path | `withTenant()` exists, but production API routes do not consistently use it. RLS policies intentionally allow all rows when tenant is null. |
| Worker needs `/ready` | Stale | Worker has `/ready`; the real issue is readiness depth and Helm wiring drift. |
| Send worker race handling is good | Overstated | The worker selects a message and then updates it without an atomic `WHERE status='queued' RETURNING` claim. |
| Outbox is fully crash-safe | Overstated | `send_outbox` rows are marked `enqueued` before BullMQ `addBulk`; a process crash in between can strand work. |
| Event idempotency is complete | Overstated | Duplicate `event_key` can skip side effects if failure happens after event insert but before status/suppression/webhook fanout. |
| DLQ is production-grade | Overstated | DLQ exists but is Redis-only, has stale docs, and lacks DB ledger, grouping, dry-run, batch replay, and retention governance. |
| KMS-pluggable encryption covers full mail path | Overstated | Shared KMS exists, but Haraka DKIM decrypts directly from `ENCRYPTION_KEY`. |
| Billing provider docs/spec are current | Incorrect | Runtime supports Cashfree, while OpenAPI/provider docs are not fully aligned. |
| Architecture doc says no object storage | Stale | Body storage/offload exists in `packages/shared/src/storage.ts`. |

## 30.3 API Service Micro-Hierarchy

### 30.3.1 Fastify Boot And Composition

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Boot guard | Config enforcement | 6.8/10 | `packages/api/src/server.ts` calls `enforceConfig()` before app registration. | Add production startup checks for RLS enforcement, DB role posture, provider readiness, queue connectivity, OpenAPI parity, and route metadata completeness. |
| App factory | Testable composition | 5.5/10 | App boot is mostly in top-level `server.ts`. | Extract `buildApp({ deps })` so tests can inspect route inventory, plugin order, schemas, and auth metadata without listening on a port. |
| Trust proxy | Client IP trust | 5.5/10 | API and tracker use `trustProxy: true`. | Replace blanket trust with explicit trusted proxy CIDRs/hop count and deployment tests. Rate limits, audit IP, and abuse controls depend on this. |
| Request IDs | Correlation | 6.5/10 | `X-Request-ID` is accepted up to 200 chars and echoed. | Restrict charset/length, reject/control invalid values, redact in logs, and add tests proving request ID propagation across API, worker jobs, tracker events, and webhooks. |
| Plugin order | Security pipeline | 7.2/10 | Error envelope, CORS, rate limit, security headers, public routes, session routes, admin, then API-key scoped routes are registered intentionally. | Convert ordering intent into a route inventory test so future routes cannot accidentally bypass auth/rate/audit requirements. |

### 30.3.2 API Authentication And Authorization

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| API-key auth | Prefix lookup and verification | 6.7/10 | `packages/api/src/plugins/auth.ts` verifies keyed requests and status/expiry. | Constant-time candidate strategy, stricter auth error envelopes, per-key audit trail for sensitive uses, and tenant DB context binding. |
| API-key scopes | Scope checks | 6.5/10 | `requireScope()` checks `admin` or named scope. | Central permission registry, route-scope parity test, deny-by-default registration, and separate read/write scopes for high-risk resources. |
| User sessions | Capability checks | 6.4/10 | `requireCapability()` checks active org, role, and MFA status. | Step-up/fresh-auth requirement for API keys, billing, domain delete, member role changes, and MFA disable. |
| Admin boundary | Admin operations | 5.8/10 | Admin routes exist under `/admin`, but legacy/static-token style paths remain in customer/admin-key flows. | Remove legacy admin-token API-key management paths; require OIDC/session admin boundary, role matrix, critical-action approval, and immutable audit. |
| BOLA prevention | Object ownership | 6.3/10 | Many handlers manually filter by `customer_id`. | Generate BOLA tests for every `:id` route and enforce object loading through tenant-aware repositories. OWASP API1 is specifically about broken object-level authorization. |

### 30.3.3 API Route Contract, Validation, And OpenAPI

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Runtime validation | Handler-local Zod | 4.8/10 | Most routes call `safeParse()` inside handlers. | Register Fastify `schema` for every route or use a Zod-to-JSON-schema compiler so validation, docs, and SDKs come from one source. |
| Validation failure shape | Schema errors | 5.0/10 | Fastify validation errors are enveloped, but handler-local Zod failures often return custom bodies. | Standard `validation_failed` shape with `request_id`, field path, stable code, and no schema leakage. |
| OpenAPI source | Hand-maintained spec | 4.0/10 | `packages/shared/src/openapi.ts` manually lists paths and omits many runtime routes. | Generate OpenAPI from route schemas or generate routes from OpenAPI; block release on runtime route inventory vs spec parity. |
| Provider parity | Billing/documentation drift | 4.0/10 | Runtime has provider support beyond OpenAPI enum. | Provider registry should generate config guard, docs, OpenAPI enum, webhook route tests, and billing provider matrix. |
| Route metadata | Auth/rate/audit matrix | 3.5/10 | No central route registry with auth type, scope, tenant requirement, rate limit, audit, sensitivity, and operation ID. | Add route metadata DSL and CI gate: every route must declare auth, tenant mode, capability/scope, rate class, audit class, response envelope, and OpenAPI operation. |

### 30.3.4 API Error, Response, And Observability Contract

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Central error handler | Thrown errors | 6.5/10 | `error-envelope.ts` maps thrown/Fastify errors to `{ error, message, request_id }`. | Replace manual reply errors with typed domain errors or `reply.error()` so every error has the same envelope. |
| Manual error replies | Route-local errors | 4.5/10 | Many handlers return `{ error }` directly. | Static scan/ESLint rule forbidding raw error bodies; contract tests for all 4xx/5xx cases. |
| Response consistency | Success shapes | 5.0/10 | Responses vary between raw rows, `{ ok }`, wrappers, `204`, metrics text, etc. | Versioned response conventions per API family and generated SDK snapshots. |
| Audit logging | Best-effort audit | 5.8/10 | `recordAuditSafe()` is used in several account/admin routes. | Critical mutations must use fail-closed audit/outbox. Audit must include actor, tenant, IP, user agent, route ID, request ID, before/after metadata, and immutable export. |
| Metrics/tracing | Basic service visibility | 6.5/10 | Prometheus metrics and tracing startup exist. | Route-level latency/error/cardinality budget, tenant-safe labels, redaction tests, exemplars, SLO burn alerts, and request-to-job trace propagation. |

### 30.3.5 API Rate Limits And Edge Security

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Global API rate limit | Redis-backed limit | 6.0/10 | `@fastify/rate-limit` is registered with Redis. | Do not fail open for login/signup/send/admin on Redis error; use local fallback or route-specific fail-closed policy. |
| Send rate limits | Route-specific limits | 7.0/10 | `/send` and batch send have route limits. | Tenant tier-aware rate classes, queue-age backpressure, per-recipient/domain abuse controls, and tests for bypass behavior. |
| Admin/auth rate limits | Sensitive endpoints | 6.5/10 | Some admin login/review/DLQ routes have specific limits. | Uniform rate policy for login, MFA, password reset, signup, invite accept, API-key create/rotate, billing portal, and support mutation endpoints. |
| CORS | Allowlist | 7.4/10 | Defaults closed unless allowed origins are configured. | CI smoke tests for allowed/blocked origins and no wildcard credential leak. |
| Security headers | Manual headers | 7.0/10 | HSTS and common security headers are set. | Use tested security-header plugin/policy snapshots, route exceptions inventory, CSP tests for docs/app surfaces. |

## 30.4 Worker, Queue, And Workflow Micro-Hierarchy

### 30.4.1 Worker Runtime

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Worker boot | Config enforcement | 7.0/10 | Worker calls `enforceConfig(logger)` and starts send/event/webhook workers and scheduler. | Provider-specific readiness checks for transport, DB, Redis, queues, ClickHouse, object storage, and selected KMS. |
| Health/readiness | HTTP probes | 6.8/10 | Worker exposes `/health`, `/ready`, and `/metrics`. | Readiness should verify DB, Redis, all queues, scheduler liveness, queue age, and dependency degradation states. |
| Shutdown | Graceful close | 6.4/10 | Shutdown pauses workers, closes queues, DB, and tracing. | Await metrics server close, enforce drain timeout behavior in tests, and record shutdown reason/remaining active job count. |
| Process failures | Unhandled rejection | 5.5/10 | `unhandledRejection` logs but keeps process alive. | For unknown worker state, either crash with supervisor restart or classify safe recoverable rejections. Add chaos tests. |

### 30.4.2 Send Worker

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Message claim | Concurrency safety | 5.0/10 | Worker selects message, checks status, then updates to sending. | Atomic claim: `UPDATE ... WHERE message_id=? AND status='queued' RETURNING *`; duplicate job test must prove one delivery only. |
| State machine | Status transitions | 5.5/10 | `queued/sending/sent/failed` transitions exist. | Formal transition table with DB constraints, transition ledger, and recovery job for illegal/stale states. |
| Transport errors | Retry taxonomy | 5.8/10 | Permanent vs retry classification exists at a shallow level. | Structured SMTP enhanced status code/provider code taxonomy, retry policy by class, bounce classification, and deliverability feedback loop. |
| Idempotency | API and job replay | 6.0/10 | Idempotency and deterministic outbox job IDs exist in parts. | End-to-end idempotency ledger linking API request, message rows, outbox row, BullMQ job, provider send attempt, and final event. |
| Suppression enforcement | Global and group suppression | 5.5/10 | Global suppression checks exist. | Enforce `unsubscribe_group_members` for all single/batch/template/review paths before enqueue and again before transport send. |

### 30.4.3 Send Outbox And Scheduler

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Outbox claim | DB-to-Redis crash window | 5.8/10 | Rows are set `enqueued` before `sendQueue.addBulk()`. | Use `pending -> claiming -> enqueued`; mark `enqueued` only after Redis success or reconcile against deterministic BullMQ job IDs. |
| Scheduler recovery | Stale sending | 5.8/10 | Scheduler recovers stale messages and emits events. | Recovery must also reset/recreate send_outbox rows and verify missing Redis jobs. |
| Review approval | Admin-to-send path | 5.5/10 | Review routes directly update DB and enqueue. | Route review approval through transactional outbox; double-click approval test must prove only one approved send. |
| Backpressure | Queue depth | 6.0/10 | Queue depth gauges exist. | Add queue age, outbox age, oldest job age, processing latency, retry storm detection, and KEDA/HPA rules on age not CPU only. |

### 30.4.4 Event Worker

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Event insert | Idempotent event key | 6.0/10 | Duplicate event keys are used to avoid double counting. | Processing ledger must track side-effect stages, not just initial event insertion. |
| Side effects | Status/suppression/webhooks | 5.0/10 | Side effects happen after event insert in several paths. | Either put status/suppression/webhook-outbox creation in the same transaction or make each stage retryable by ledger. |
| ClickHouse | Analytics firehose | 3.5/10 | ClickHouse writes are best effort. | Analytics outbox, backfill worker, drift monitor, and alert when ClickHouse lags DB event ledger. |
| Webhook fanout | Event-to-webhook | 6.5/10 | Webhook jobs use deterministic IDs in parts. | DB-backed webhook delivery outbox with exact delivery lifecycle and replay governance. |

### 30.4.5 Webhook Worker And DLQ

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Webhook delivery | SSRF defense | 8.0/10 | SSRF validation and IP pinning are strong relative to rest of platform. | Add DNS rebinding regression tests, egress allowlist option, and private-network policy audit. |
| Webhook signing | Signature model | 7.0/10 | Signatures exist. | Dual-secret rotation, replay timestamp tolerance tests, per-attempt signature evidence, and SDK examples. |
| Webhook retry | Retry behavior | 6.5/10 | Retries and DLQ handling exist. | Circuit breaker per endpoint/customer, exponential jitter by error class, bulk pause/resume, and per-endpoint SLO. |
| DLQ | Dead-letter queue | 6.5/10 | Redis DLQ and admin routes exist. | DB DLQ ledger, payload hash/body pointer, redaction, grouping, dry-run replay, batch replay, audit, retention, and docs parity. |

## 30.5 Tracker Micro-Hierarchy

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Tracker boot | Config guard | 4.5/10 | Tracker does not call `enforceConfig()` and has dev fallback secret behavior. | Call shared config guard in tracker; in production, missing/weak tracking/unsubscribe secrets must refuse boot. |
| Open pixel | Event capture | 6.5/10 | Pixel responds and enqueues open event. | Signed/rotatable token, rate limits, bot filtering proof, and durable event capture if queue fails. |
| Click redirect | URL safety | 6.8/10 | Redirect allows only HTTP(S) and records click. | Signed link token, link ownership proof, expiry/key rotation, safe redirect audit, and bot/crawler policy. |
| Unsubscribe GET/POST | One-click support | 7.4/10 | Browser confirmation, RFC 8058 one-click marker, and CSRF token exist. | Signed token rotation, group membership enforcement in send paths, consent ledger, and abuse/rate tests. |
| Tracking rate limit | Abuse controls | 5.5/10 | Unsubscribe has route rate config; open/click rate limiting is less explicit. | Explicit per-route rate policies for open/click/unsub, bot-aware limits, and failure-mode tests. |
| Tenant execution | Global DB | 5.5/10 | Tracker uses global DB as service component. | Document service-role posture, use least privilege, and add tenant/customer consistency constraints. |

## 30.6 Haraka Inbound And Outbound MTA Micro-Hierarchy

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Inbound bounce parser | VERP verification | 7.8/10 | Signed VERP bounce parsing and FBL complaint parsing exist. | Real provider corpus tests: Gmail, Microsoft, Yahoo/AOL, SES, SendGrid, Mailgun, malformed DSN/FBL, large payload, and forged complaint cases. |
| Inbound queueing | Bounce event enqueue | 7.0/10 | Bounce/complaint events enqueue to BullMQ. | DB-backed inbound event ledger, idempotency proof, and operational visibility for rejected/ignored bounces. |
| Outbound DKIM | Customer DKIM signing | 7.2/10 | DKIM plugin signs from customer domain and denys soft on required failures. | Move DKIM key decrypt behind shared KMS/signing service; add selector rotation tests and provider deliverability proof. |
| Outbound headers | Internal header cleanup | 7.0/10 | Internal routing headers are removed. | Header contract test for every outbound path, ARC/DMARC alignment checks, and no-leak snapshot testing. |
| Outbound events | Delivered/deferred/bounce hooks | 6.8/10 | Haraka hooks emit delivery events. | Exactly-once event ledger, provider-specific semantics mapping, and fallback for Haraka hook/plugin failures. |
| Live MTA operations | Production proof | 5.8/10 | Config files exist, but production TLS/queue/runbook proof is limited. | TLS cert automation, queue spool durability, IP pool warmup proof, bounce domain DNS proof, and live canary deliverability runbooks. |

## 30.7 Shared Package And Cross-Module Contract Micro-Hierarchy

### 30.7.1 Package Boundaries

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Root exports | Barrel package | 4.8/10 | `packages/shared/src/index.ts` exports DB, Redis, queues, metrics, migrations, tracing, testkit, and domain modules together. | Split into `@platform/contracts`, `@platform/domain`, `@platform/infra`, `@platform/testing`, and `@platform/bin`; production root should not export testkit or instantiate infra. |
| Import side effects | Stateful modules | 5.0/10 | Redis/queue modules create runtime clients or options at import time. | Factory-based dependency creation, no network-capable singleton from pure imports, and import-side-effect tests. |
| Global DB | Singleton executor | 5.2/10 | `db` is a lazy global Kysely proxy. | Request/job-scoped executors with `TenantCtx` and `ServiceCtx`; forbid global `db` in tenant route/service directories. |
| Testkit | Production barrel exposure | 6.0/10 | Test utilities are exported from root shared index. | Move to a separate test-only entrypoint and assert it is not bundled into production images. |

### 30.7.2 Schema, Types, And Contract Drift

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Kysely schema | Hand-maintained types | 3.0/10 | Broad schema exists, but no generated drift guarantee surfaced. | Generate schema types from migrated DB or run CI drift check covering tables, columns, nullability, enums, indexes, constraints, and RLS policies. |
| OpenAPI contracts | API docs and SDK | 4.0/10 | Hand-maintained `openapi.ts` is not route-generated. | Route-schema-generated OpenAPI, SDK generation, contract snapshots, and diff approval for breaking changes. |
| Queue contracts | Job payload types | 5.8/10 | Shared queue payload types exist. | Versioned job schemas with migration/defaulting, dead-letter schema version, and worker compatibility tests. |
| Event contracts | Event payloads | 5.5/10 | Event types exist across API/worker/tracker/MTA. | Canonical event registry with schema, producer, consumer, idempotency key, side effects, retention, PII classification, and replay policy. |
| Provider contracts | Billing/storage/transport/KMS | 5.5/10 | Provider abstractions exist but docs/spec/config drift. | Single provider registry that emits config guard rules, docs, OpenAPI enums, tests, and operational readiness checks. |

### 30.7.3 Config, Secrets, Crypto, And Storage

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Config guard | Core secrets | 5.8/10 | JWT, encryption, VERP, API pepper, admin pepper, and OIDC are checked for production. | Add selected-provider checks for KMS, storage, transport, ClickHouse, billing, webhook signing, metrics auth, tracker, Haraka, and Redis TLS/password posture. |
| KMS | Provider abstraction | 6.2/10 | AWS/GCP/Vault/env providers exist. | Async preload or async encrypt/decrypt contract, required external KMS in production, key versioning, rotation, and Haraka integration. |
| Encryption | DKIM secret encryption | 6.0/10 | AES-256-GCM and encrypted DKIM storage exist. | No plaintext legacy fallback in production, key version in ciphertext, migration validator, and envelope metadata. |
| Body storage | Inline/fs/S3 | 6.5/10 | Body offload supports inline, filesystem, and S3-compatible storage. | Production object lifecycle policies, encryption proof, DSAR delete coverage, object-store retry ledger, and large-campaign load tests. |
| API keys/passwords/tokens | Secret primitives | 6.5/10 | Hashing/pepper/session/token modules exist. | Central secret classification, rotation playbooks, leak redaction tests, and high-risk action step-up. |

## 30.8 Database And Data-Plane Micro-Hierarchy

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Tenant RLS | Policy posture | 3.5/10 | RLS policies allow rows when `current_tenant_id()` is null. | Fail closed for API app role, separate worker/admin/migration roles, and no null-tenant fallback for tenant tables. |
| Tenant execution | API integration | 2.5/10 | `withTenant()` exists, but route code does not consistently use it. | Every tenant route runs through `withTenant()` or a request-scoped `TenantCtx`; boot fails if role bypasses RLS. |
| Relational integrity | Tenant consistency | 5.6/10 | Broad tables exist, but several cross-table tenant constraints are incomplete. | Composite tenant FKs for messages/events/links/review/unsubscribe group members and delete/retention behavior. |
| Audit log | Critical mutation durability | 5.5/10 | Audit helpers exist, some best-effort. | Immutable audit outbox, hash chain/WORM/SIEM export, and fail-closed audit for critical mutations. |
| Privacy deletion | Cross-store DSAR | 5.3/10 | Postgres/object deletion exists in parts. | DSAR ledger covering Postgres, ClickHouse, Redis/DLQ, object store, logs, backups/tombstones, legal hold, and per-store retry. |
| Billing state | Webhook idempotency | 5.0/10 | Billing event marker is inserted before state mutation. | Transactional billing event ledger where duplicate marker and subscription/customer mutation are atomic or staged retryable. |
| Analytics | ClickHouse copy | 3.5/10 | Analytics writes are best-effort. | Durable analytics outbox, backfill worker, row-count drift checks, partition retention, and alerting. |

## 30.9 Deployment, Runtime, And Operations Micro-Hierarchy

| Submodule | Sub-submodule | Score | Evidence | Missing for 10/10 |
| --- | --- | ---: | --- | --- |
| Migrations | Startup vs release job | 5.0/10 | App images and Helm migration job posture drift in previous audit. | Exactly one locked migration job per release; remove app-start migrations; add migration smoke and rollback/expand-contract checks. |
| Helm probes | Port/path parity | 5.0/10 | Worker/tracker probe paths and ports drift from service code. | Rendered Helm tests must call actual `/health`/`/ready` paths and correct metrics ports. |
| Runtime readiness | Dependency health | 5.5/10 | Health endpoints exist, but depth varies. | Separate live/ready/startup checks, dependency degradation states, queue-age readiness, DB role/RLS readiness, and provider readiness. |
| HA and scaling | Service scaling | 4.8/10 | Containers can run, but HA/PITR/read replica/pooler proof is limited. | PgBouncer/RDS Proxy, connection budgets, read replica strategy, PITR restore drill, queue worker scaling by age, and regional failover runbook. |
| Release evidence | CI/CD proof | 4.8/10 | Many tests exist, but release gates do not prove full contract. | Release bundle: route parity, OpenAPI diff, schema drift, Helm render/probe, migration dry run, e2e send, webhook replay, RLS leak test, and rollback evidence. |

## 30.10 Module-by-Module 10/10 Remediation Backlog

### 30.10.1 API 10/10 Backlog

| Priority | Work item | Acceptance proof |
| ---: | --- | --- |
| P0 | Build route metadata registry for every route: auth type, scope/capability, tenant mode, rate class, audit class, sensitivity, OpenAPI operation ID. | CI fails when any route lacks metadata. Runtime route inventory equals metadata inventory. |
| P0 | Move validation to Fastify `schema` or generated schema bridge. | Every route has request/response schemas and contract tests; handler-local ad hoc validation is removed or wrapped. |
| P0 | Generate OpenAPI from route schemas or generate validators from OpenAPI. | Runtime paths/methods exactly match OpenAPI; Cashfree and all account/admin/support/privacy/team routes are included. |
| P0 | Enforce tenant DB context. | Tenant routes cannot import/use global `db`; cross-tenant BOLA tests fail closed under app DB role. |
| P1 | Replace manual error replies with typed errors/shared reply helper. | Every 4xx/5xx includes `{ error, message, request_id }`; snapshot tests cover common errors. |
| P1 | Add step-up auth for high-risk actions. | API key rotation, billing, MFA disable, domain delete, member role change, and admin critical actions require recent MFA/SSO context. |
| P1 | Harden rate-limit failure modes. | Redis outage tests prove login/signup/send/admin routes do not fail open unsafely. |

### 30.10.2 Worker/Queue 10/10 Backlog

| Priority | Work item | Acceptance proof |
| ---: | --- | --- |
| P0 | Atomic send worker claim. | Duplicate jobs for same message result in one delivery and one no-op. |
| P0 | Crash-safe outbox state machine. | Crash after DB claim before Redis add is recovered automatically. |
| P0 | Event processing ledger. | Failure after event insert resumes missing status/suppression/webhook side effects instead of skipping as duplicate. |
| P0 | Review approval through outbox. | Double-click/concurrent approval creates one send path and one audit record. |
| P1 | DB-backed DLQ ledger. | DLQ entries have schema version, payload hash/body pointer, redaction, retention, audit, dry-run replay, batch replay. |
| P1 | Queue-age SLO metrics. | Alerts and autoscaling use oldest waiting age, outbox age, retry storm rate, and processing latency. |
| P1 | Transport error taxonomy. | SMTP/provider enhanced codes map to retry/permanent/suppression/reputation actions with tests. |

### 30.10.3 Tracker/MTA 10/10 Backlog

| Priority | Work item | Acceptance proof |
| ---: | --- | --- |
| P0 | Enforce config guard in tracker and Haraka-equivalent boot checks. | Production boot fails on missing/weak VERP/tracking/unsubscribe/DKIM/KMS secrets. |
| P0 | Sign/rotate tracking and unsubscribe tokens. | Tampered/expired/wrong-key tokens fail; rotation accepts previous key only within policy. |
| P0 | Enforce group unsubscribe in send paths. | Recipient in group unsubscribe is skipped in single, batch, template, scheduled, and review-approved sends. |
| P1 | Move Haraka DKIM decrypt to shared KMS/signing service. | `KMS_PROVIDER` works consistently for API, worker, and Haraka DKIM. |
| P1 | Add bounce/FBL corpus tests. | Provider fixture suite proves hard bounce, soft bounce, complaint, forged complaint, malformed DSN, and huge payload behavior. |
| P1 | Add live MTA operational runbook proof. | TLS, queue spool, DNS, IP pool, bounce domain, and canary deliverability checks are documented and tested. |

### 30.10.4 Shared/Database 10/10 Backlog

| Priority | Work item | Acceptance proof |
| ---: | --- | --- |
| P0 | Split shared package entrypoints. | Production code cannot import testkit or accidentally initialize Redis/queues by importing pure contracts. |
| P0 | Generate or drift-check DB schema types. | CI detects any DB/table/column/nullability/enum/index/RLS mismatch with `schema.ts`. |
| P0 | Make RLS fail closed. | Null tenant cannot read tenant rows; API app role is non-owner/non-superuser/non-BYPASSRLS; boot verifies this. |
| P0 | Add provider registry. | Billing/storage/transport/KMS/ClickHouse docs, config guard, OpenAPI, and tests are generated from one provider matrix. |
| P1 | Add privacy DSAR ledger. | DSAR job reports per-store state for Postgres, ClickHouse, object store, Redis/DLQ, logs, backups/tombstones, and legal hold. |
| P1 | Add immutable audit pipeline. | Critical actions have hash-chained audit, SIEM/WORM export, and fail-closed behavior. |
| P1 | Add template/domain/suppression history. | Template versions, DKIM selector history, DNS verification history, suppression consent source, and unsubscribe group membership history are queryable. |

### 30.10.5 Deployment/Operations 10/10 Backlog

| Priority | Work item | Acceptance proof |
| ---: | --- | --- |
| P0 | Fix Helm/image migration strategy. | Only one release migration job runs; rendered command path matches built image; app containers never race migrations. |
| P0 | Fix Helm probe/port parity. | Rendered manifests hit real `/live`/`/health`/`/ready` paths and correct worker/tracker ports. |
| P1 | Add release evidence bundle. | Every release stores OpenAPI diff, route parity, schema drift, Helm render, migration dry run, RLS test, send e2e, webhook replay, and rollback proof. |
| P1 | Add HA/PITR drills. | Restore drill proves RPO/RTO; failover drill proves app reconnect and queue recovery. |
| P1 | Add observability SLOs. | Error budget, latency, queue age, outbox age, webhook success, delivery event lag, and DSAR completion are monitored with alert tests. |

## 30.11 Micro-Level Acceptance Test Matrix Required Before Calling It 10/10

| Test class | Specific test | Required result |
| --- | --- | --- |
| API route parity | Compare Fastify runtime route inventory to OpenAPI paths/methods. | Exact match or explicit internal-route exemption. |
| API metadata | Every route declares auth, tenant, rate, audit, sensitivity, schema, and operation ID. | CI fails on missing metadata. |
| API validation | Invalid body/query/params for every route. | Standard `validation_failed` envelope with `request_id`. |
| Error envelope | Manual domain errors, thrown errors, Fastify validation errors, 404s, and 500s. | Same envelope shape and no secret leakage. |
| BOLA | Cross-customer access for every `:id` route. | 404/403 with no timing/data leak. |
| RLS | Deliberately broken route/query missing customer filter. | DB role/RLS still blocks cross-tenant rows. |
| Duplicate send jobs | Two workers process same message job. | One atomic claim wins; one exits; one provider send. |
| Outbox crash | Crash after DB claim before Redis add. | Row/job is recovered and eventually sent or visibly failed. |
| Event crash | Crash after event insert before webhook fanout. | Retry completes remaining side effects. |
| Billing crash | Crash after billing event marker before customer update. | Provider retry or ledger replay applies state. |
| DLQ replay | Replay same DLQ entry twice. | Idempotent replay, audit trail, no duplicate irreversible side effects. |
| Group unsubscribe | Group-unsubscribed recipient receives future group mail. | Send is blocked in every send path. |
| Tracker token tamper | Modify open/click/unsub token. | Request fails or does not mutate state. |
| Haraka forged FBL | Complaint without valid signed VERP. | Ignored and logged without suppression/reputation mutation. |
| KMS rotation | Rotate key version. | Old ciphertext remains readable and new ciphertext uses new key version. |
| Privacy DSAR | Deletion with ClickHouse/object/Redis failure. | Job remains retryable and reports partial completion. |
| Helm render | Render production chart. | Migration command, probes, ports, env, secrets, and policies match runtime code. |

## 30.12 Final Eleventh-Pass Scores

| Area | Score |
| --- | ---: |
| API boot/config/plugin composition | 6.8/10 |
| API route validation | 4.8/10 |
| API OpenAPI/SDK contract | 4.0/10 |
| API auth/authz boundary | 6.4/10 |
| API tenant/RLS execution | 2.5/10 |
| API error/response consistency | 5.0/10 |
| API rate/security headers | 6.7/10 |
| Worker runtime/shutdown | 6.8/10 |
| Send worker concurrency/state | 5.0/10 |
| Outbox/scheduler crash consistency | 5.8/10 |
| Event worker idempotency/side effects | 5.0/10 |
| Webhook worker delivery | 8.0/10 |
| DLQ/replay operations | 6.5/10 |
| Tracker service | 6.3/10 |
| Haraka inbound/outbound | 7.0/10 |
| Shared package boundaries | 4.8/10 |
| Shared provider/config contracts | 5.8/10 |
| Schema/type drift protection | 3.0/10 |
| Database tenant isolation execution | 2.5/10 |
| Deployment/runtime operations | 5.1/10 |
| Overall micro-level architecture readiness | 5.8/10 |

The honest final position after this pass:

| Dimension | Score |
| --- | ---: |
| Overall production readiness | 4.9/10 |
| Overall SaaS readiness | 4.7/10 |
| Overall enterprise readiness | 4.7/10 |
| Overall micro-level architecture readiness | 5.8/10 |

The platform is feature-rich and has serious production-oriented components, but a 10/10 system needs enforceable contracts, fail-closed tenant isolation, generated schema/spec parity, crash-consistent workflows, provider/config governance, and operational evidence. The highest-leverage work is not adding more features; it is turning existing feature implementations into centrally enforced guarantees.

# 31. Twelfth-Pass Concrete Runtime Inventory And Micro-Gap Proof

This pass adds measurable proof under the previous micro-architecture verdict. The goal is to separate "it looks production-like" from "it is enforceably production-grade."

## 31.1 Route Surface Inventory

The API route surface is much larger than the OpenAPI contract currently documents.

| Inventory item | Count | What it means |
| --- | ---: | --- |
| API route operations found in code | 148 normalized operations |
| OpenAPI operations found in `packages/shared/src/openapi.ts` | 45 operations |
| Operations missing from OpenAPI | 104 operations |
| Stale OpenAPI operations found by simple comparison | 1 operation |
| API route files | 21 files |
| Fastify `schema:` blocks in route files | 0 |
| Zod `safeParse()` calls in route files | 64 |
| Zod `.parse()` calls in route files | 9 |
| Raw `send({ error ... })` bodies in route files | 200 |
| Route-level `rateLimit` config blocks | 13 |

Score impact:

| Submodule | Previous score | Updated micro-proof score | Reason |
| --- | ---: | ---: | --- |
| API route contract | 4.0/10 | 3.8/10 | OpenAPI covers only a minority of runtime operations. |
| API validation contract | 4.8/10 | 4.5/10 | Validation is mostly handler-local and not Fastify schema-bound. |
| Error envelope consistency | 5.0/10 | 4.6/10 | Raw error body count is high enough that central handler coverage cannot be treated as global. |
| API rate governance | 6.7/10 | 6.2/10 | Only a small subset of routes declares route-specific rate classes. |

10/10 route-contract solution:

| Step | Required implementation | Acceptance proof |
| --- | --- | --- |
| 1 | Add a `route()` wrapper/DSL used by every API module. | No direct `app.get/post/put/patch/delete` calls outside route registry helpers. |
| 2 | Require metadata: `auth`, `scope/capability`, `tenant`, `rateClass`, `auditClass`, `schema`, `response`, `operationId`, `sensitivity`. | CI fails if metadata is missing. |
| 3 | Generate OpenAPI from registered route schemas. | Runtime inventory and OpenAPI operations are equal, except explicitly marked internal health/metrics routes. |
| 4 | Add route parity test. | Test reports exact missing/stale route list on every PR. |
| 5 | Generate SDK/tests from OpenAPI. | SDK compilation and contract tests fail on breaking drift. |

High-priority missing OpenAPI examples found in route inventory:

| Missing area | Example operations |
| --- | --- |
| Admin operations | `/admins`, `/customers`, `/review-queue`, `/dlq`, `/support-tickets`, `/reputation/pools`, `/deliverability/pool-health` |
| Account/auth operations | `/auth/register`, `/auth/login`, `/auth/mfa`, `/auth/logout`, `/auth/me`, `/auth/switch-org` |
| Team operations | `/team/invites`, `/team/members`, invite accept/delete, member role changes |
| Privacy operations | `/privacy/export-recipient`, `/privacy/deletions` |
| Suppression/group operations | `/suppressions/export`, `/unsubscribe-groups`, group members add/remove/list |
| Message operations | `/messages/scheduled`, `/messages/:messageId/cancel` |
| Webhook operations | `/webhooks/:id/deliveries`, test/retry failure operations |
| Platform internal operations | `/live`, `/health`, `/ready`, `/metrics`, `/openapi.json` need either OpenAPI inclusion or explicit internal exemption. |

## 31.2 Tenant Execution Inventory

The tenant isolation issue is now measurable:

| Inventory item | Count |
| --- | ---: |
| `withTenant()` usages in `packages/api/src`, `packages/worker/src`, `packages/tracker/src`, `packages/shared/src` | 0 runtime usages found by search |
| Direct global `db.*` calls in `packages/api/src` | 56 calls across 11 files |
| Direct global `db.*` calls in `packages/worker/src` | 15 calls across 4 files |
| Direct global `db.*` calls in `packages/tracker/src` | 1 call across 1 file |
| Direct global `db.*` calls in `packages/shared/src` | 62 calls across 20 files |
| RLS migration files | 1 |
| `CREATE POLICY` statements found | 9 |
| RLS policy branches allowing null tenant | 9 |

This confirms the later report correction: tenant isolation is not a 10/10 enforced database boundary. The helper exists, but runtime code does not route tenant work through it, and every RLS policy found in the migration allows null-tenant access.

Score impact:

| Submodule | Score | Why |
| --- | ---: | --- |
| Tenant DB executor adoption | 1.5/10 | The helper exists but is not used by runtime modules in the searched surface. |
| RLS fail-closed posture | 2.0/10 | Null tenant branches mean policy behavior is intentionally fail-open for service/admin/migration patterns. |
| Tenant route BOLA defense-in-depth | 4.0/10 | Manual `customer_id` filters may work in many handlers, but DB-level backup is not enforced. |

10/10 tenant isolation solution:

| Step | Required implementation | Acceptance proof |
| --- | --- | --- |
| 1 | Introduce `TenantCtx` and `ServiceCtx` types. | Tenant services accept `ctx.db`, not global `db`. |
| 2 | Create request context in auth/session middleware. | Every authenticated tenant route has `tenantId`, `actor`, `requestId`, and tenant-bound DB executor. |
| 3 | Remove null-tenant RLS fallback for API app role. | A query without `app.customer_id` cannot read tenant rows. |
| 4 | Split DB roles. | API role is non-owner/non-superuser/non-BYPASSRLS; worker/admin/migration roles are explicit and separately audited. |
| 5 | Add lint rule banning global `db` in tenant route/service directories. | CI blocks new unsafe usage. |
| 6 | Add generated BOLA tests for every `:id` route. | Cross-tenant object access returns 404/403 even if handler misses a customer filter. |

## 31.3 Error Envelope And Response Contract Proof

The central `error-envelope` plugin is useful, but it does not make the whole API envelope-consistent because many handlers return manual error objects.

| Layer | Current behavior | Gap |
| --- | --- | --- |
| Thrown errors | Central handler adds `error`, `message`, `request_id`. | Good baseline. |
| Fastify validation errors | Central handler maps validation failures. | Mostly unused because routes do not register Fastify schemas. |
| Handler-local Zod errors | Many routes manually return validation errors. | Envelope shape can drift. |
| Auth/scope errors | Some plugin responses return only `error` and optional `message`. | Missing guaranteed `request_id/details`. |
| Business rule errors | Many route-level `reply.code().send({ error })` bodies. | Central handler is bypassed. |

10/10 response contract solution:

| Step | Required implementation | Acceptance proof |
| --- | --- | --- |
| 1 | Add typed `AppError` classes with stable codes. | No route manually constructs error bodies. |
| 2 | Add `reply.error(code, options)` helper for expected business failures. | Helper always emits standard envelope and logs at correct level. |
| 3 | Add route response schemas. | Success and error shapes are validated in test. |
| 4 | Add error registry. | Every public error code has HTTP status, message policy, retryability, docs text, and redaction policy. |
| 5 | Snapshot 401/403/404/409/422/429/500 across route families. | All snapshots include `request_id` and no secrets/PII. |

## 31.4 Provider And Billing Contract Drift Proof

Runtime billing supports Stripe, PayPal, Cashfree, and mock behavior, but the OpenAPI/provider docs are not fully aligned.

| Provider area | Current proof | Gap |
| --- | --- | --- |
| Runtime provider implementation | `CashfreeBillingProvider` exists in shared billing provider code. | Provider list comment/docs still focus on Stripe/PayPal/mock in places. |
| Billing route runtime | Billing webhook handler branches for `stripe`, `paypal`, and `cashfree`. | OpenAPI enum only lists `stripe` and `paypal`. |
| Config guard | Billing webhook secrets are conditionally checked for active providers. | Provider registry is not the source of config guard, docs, OpenAPI, and tests. |
| Billing event idempotency | `billing_events` suppresses duplicate provider events. | Marker insert is not atomic with subscription/customer mutation. |

10/10 provider solution:

| Step | Required implementation | Acceptance proof |
| --- | --- | --- |
| 1 | Create `billingProviders` registry with provider name, env requirements, webhook headers, supported events, docs fields, OpenAPI enum. | Adding a provider updates code/docs/spec/tests through one registry. |
| 2 | Generate OpenAPI provider enum from registry. | Cashfree appears anywhere runtime accepts it. |
| 3 | Generate config guard rules from registry. | Selected provider cannot boot in production with missing live webhook secrets. |
| 4 | Make billing event application staged/transactional. | Failure after marker insert remains retryable and visibly incomplete. |
| 5 | Add replay tests per provider. | Duplicate, out-of-order, invalid signature, missing customer, and state-transition events behave correctly. |

## 31.5 Deployment Drift Proof

The deployment layer has concrete mismatches that prevent enterprise-grade confidence.

| Area | Current finding | Production risk | 10/10 fix |
| --- | --- | --- | --- |
| Helm migration command | Helm uses `dist/bin/migrate.js`. | Built package path can differ from runtime path, causing release migration failure. | Render/test Helm job against built image command. |
| Worker port | Compose sets `WORKER_METRICS_PORT=9100`; Helm worker container exposes `9091`. | Probes/metrics can target wrong port. | Single values-driven port used by app env, container port, service, and probes. |
| Worker readiness | Helm probes `/health`, but worker also has `/ready`. | Readiness may not reflect dependency readiness. | Use `/ready` for readiness and `/health` for liveness. |
| Tracker probes | Helm probes `/live`; tracker code exposes `/health` and metrics. | Kubernetes can mark healthy tracker unhealthy. | Add `/live`/`/ready` in tracker or change Helm probes to existing paths. |
| App-start migrations | Previous sections found startup migration behavior mixed with Helm migration job. | Multiple replicas can race migrations. | One release migration job only; app containers refuse to run migrations. |

10/10 deployment acceptance:

| Test | Required proof |
| --- | --- |
| Helm render smoke | Rendered manifests have ports/probes/env paths matching service code. |
| Built-image migration test | Migration job command runs inside the actual production image. |
| Probe test | API, worker, tracker respond correctly to liveness/readiness paths before and after dependency failure. |
| Multi-replica startup | Three replicas start without migration race or schema drift. |
| Rollback drill | Failed migration/release has documented and tested rollback/forward-fix path. |

## 31.6 Workflow Crash Window Proof

The key production-grade weakness is not lack of queues; it is incomplete crash consistency between database state, Redis jobs, external providers, and side effects.

| Workflow | Current risk | Required 10/10 design |
| --- | --- | --- |
| API send -> DB -> outbox -> Redis | Outbox row can be marked `enqueued` before Redis `addBulk` completes. | `pending -> claiming -> enqueued` with deterministic job existence reconciliation. |
| Redis send job -> message send | Worker claim is not atomic against duplicate jobs. | Atomic `UPDATE ... WHERE status='queued' RETURNING` claim. |
| Event insert -> status/suppression/webhook side effects | Duplicate event can skip unfinished side effects. | Processing ledger with stages or one DB transaction for event plus durable side-effect outboxes. |
| Billing marker -> subscription/customer update | Duplicate marker can be written before state mutation finishes. | Billing event ledger with stage status and retryable state application. |
| Admin review approval -> send queue | Direct DB update plus queue enqueue can split. | Review approval writes send outbox transactionally. |
| Tracker response -> queued event | Pixel/click can respond before durable event capture. | Durable best-effort policy must be explicit; for paid analytics, use local buffer/outbox and loss metrics. |

## 31.7 Updated Micro-Priority Order

If the goal is to move fastest toward production-grade, do these in order:

| Order | Area | Why first |
| ---: | --- | --- |
| 1 | Route metadata + OpenAPI/validation generation | Creates the map needed to govern API auth, docs, tests, SDKs, and breaking changes. |
| 2 | Tenant context + fail-closed RLS | Prevents the highest-severity SaaS/enterprise failure: cross-tenant data exposure. |
| 3 | Error envelope standardization | Makes API behavior supportable and testable. |
| 4 | Atomic send claim + outbox crash recovery | Prevents duplicate or stranded mail delivery. |
| 5 | Event/billing processing ledgers | Prevents silent partial side effects and replay bugs. |
| 6 | Deployment probe/migration parity | Prevents production rollout failures unrelated to application logic. |
| 7 | Shared package split | Reduces long-term coupling and import side effects after the urgent safety contracts are in place. |
| 8 | Provider registry | Stops docs/config/OpenAPI/runtime drift across billing, storage, KMS, transport, and analytics. |

## 31.8 Twelfth-Pass Score Changes

| Area | Section 30 score | Section 31 evidence-adjusted score |
| --- | ---: | ---: |
| API route validation | 4.8/10 | 4.5/10 |
| API OpenAPI/SDK contract | 4.0/10 | 3.8/10 |
| API error/response consistency | 5.0/10 | 4.6/10 |
| API tenant/RLS execution | 2.5/10 | 2.0/10 |
| API rate governance | 6.7/10 | 6.2/10 |
| Deployment/runtime operations | 5.1/10 | 4.9/10 |
| Overall micro-level architecture readiness | 5.8/10 | 5.6/10 |

The overall production/SaaS/enterprise scores remain unchanged because these new findings validate the earlier conservative verdict rather than adding a new class of risk:

| Dimension | Score |
| --- | ---: |
| Overall production readiness | 4.9/10 |
| Overall SaaS readiness | 4.7/10 |
| Overall enterprise readiness | 4.7/10 |
| Overall micro-level architecture readiness | 5.6/10 |

# 32. Thirteenth-Pass Current-Tree End-To-End Validation

Validation date: 2026-07-10
Repository revision: `f05edaf` (`master`)
Method: direct current-tree review plus clean dependency installation, builds,
the complete test suite, live local runtime probes, deployment rendering checks
where locally available, Prometheus rule validation, and current official sender
requirement verification. Earlier sections remain useful historical evidence,
but the scores and findings in this section supersede conflicting older claims.

## 32.1 Executive Verdict

No: the current platform is not production-equivalent to SendGrid, Mailgun, or
Mailjet, and it is not yet 10/10 production/SaaS/enterprise grade.

It is now a strong early-production candidate with a broad, well-tested
transactional-email control plane. It is materially stronger than the tree
described in the early passes of this report. The current repository has real
tenant-scoped query execution, atomic send claiming, stale-outbox recovery,
group-unsubscribe enforcement, SDK webhook verification, consent events, legal
holds, SCIM provisioning, audit hash chaining, ClickHouse reconciliation, an
error registry, OpenAPI drift tests, security contexts, and 646 passing tests.

The remaining gap to a mature ESP is not one missing API endpoint. It is the
combination of:

- fail-closed tenant isolation still being staged rather than deployed;
- unsafe cross-tenant semantics in the new SCIM implementation;
- incomplete provider-real billing, especially PayPal verification;
- MTA topology, TLS, DKIM rotation, bounce alignment, and ISP operations not
  being production-complete;
- privacy erasure/export and audit retention still being internally
  inconsistent;
- analytics reconciliation being at-least-once without real ClickHouse
  deduplication;
- incomplete OpenAPI coverage and no generated multi-language developer
  platform;
- no staging load/failover/restore/deliverability evidence comparable to a
  mature ESP;
- release/supply-chain evidence and production configuration enforcement still
  being incomplete.

Current evidence-adjusted scores:

| Dimension | Score |
| --- | ---: |
| Code architecture | 7.6/10 |
| Core send acceptance and worker correctness | 8.0/10 |
| Local developer completeness | 8.2/10 |
| Self-hosted MVP readiness | 7.0/10 |
| Multi-tenant SaaS readiness | 5.8/10 |
| Deliverability/MTA readiness | 5.2/10 |
| Billing launch readiness | 5.0/10 |
| Privacy/compliance readiness | 5.4/10 |
| Enterprise identity readiness | 4.5/10 |
| HA/DR/SRE evidence | 4.2/10 |
| Supply-chain/release maturity | 5.0/10 |
| Overall production readiness | 5.6/10 |
| Overall SendGrid/Mailgun/Mailjet-class maturity | 4.6/10 |

## 32.2 Verification Snapshot

| Check | Current result | Meaning |
| --- | --- | --- |
| Clean dependency install | `npm ci` passed | The lockfile can recreate the workspace. The checkout initially had no installed workspaces. |
| Root TypeScript build | Pass after `npm ci` | Shared, API, worker, tracker, and SDK compile. |
| Docusaurus production build | Pass | OpenAPI export and static docs build complete. |
| Production dependency audit | 0 vulnerabilities at moderate+ | The old 27-moderate production finding is stale. |
| Full dependency install audit | 18 moderate | Development/tooling dependencies still need triage; production-only audit is clean. |
| Production readiness script | Pass in template mode | Validates the example contract, not real secrets, provider accounts, DNS, IAM, or deployed topology. |
| Complete test suite | 96 files, 646 tests passed | Coverage is broad and the new remediation tests execute successfully. |
| Test process shutdown | 10-second close timeout | Open handles/resources remain after tests; harness hygiene is not clean. |
| Fresh `npm test` without test Compose | Fail | Test env is auto-loaded, but Postgres/Redis are not auto-started; the workflow is still two-step. |
| Isolated test Compose + migrations | Pass | `.env.test` points to 5434/6380 and global setup applies migrations. |
| Live API `/live`, `/health`, `/ready` | 200 | Local API sees Postgres, Redis, and queue. |
| Live tracker `/live`, `/health`, `/ready` | 200 | Tracker probe-route mismatch found in an older pass is fixed in current code. |
| Live worker `/health`, `/ready` | 200 | Worker health server is reachable and queue/Redis checks pass locally. |
| Metrics without bearer token | 401 for API/tracker/worker | Metrics endpoints fail closed locally. |
| Prometheus rules | `promtool` pass, 15 rules | Rule syntax is valid; alert behavior/fire-drill proof is still absent. |
| Production Compose render | Pass with example env | YAML/env interpolation is structurally valid. |
| Helm render | Not executed locally | Helm CLI is not installed; CI also does not currently render/lint the chart. |
| Running API/worker/tracker containers | `user=node` | Non-root runtime is present. |
| Running Compose resilience | restart=`no`, no Docker healthcheck, writable root | Current local Compose remains development-grade. |

Important test-harness correction:

- The first build failure in this pass was caused by an empty/missing
  `node_modules`, not source defects. After `npm ci`, builds passed.
- The first test failure was caused by the documented test Postgres/Redis stack
  not running on ports 5434/6380. After starting it, all 646 tests passed.
- The suite still reports `close timed out after 10000ms`, proving one or more
  DB/Redis/BullMQ/timer/server handles are not closed cleanly.
- `.npmrc` contains `PLAYWRIGHT_BROWSERS_PATH` as an npm project config key;
  npm 11 warns that this is unknown and will stop working in a future major.

## 32.3 Material Corrections To Older Findings

| Older claim | Current-tree correction |
| --- | --- |
| No production route uses `withTenant()` | Stale. Current API code has 51 `tenantScoped()` call sites, and shared domain/webhook/activity services use `withTenant()`. |
| Startup does not check the DB role | Stale. Production API startup calls `rlsIsEnforced()` and refuses superuser/BYPASSRLS unless an explicit override is set. |
| Group unsubscribe is not enforced | Stale. Single and batch send paths check `unsubscribe_group_members`; E2E coverage exists. |
| SDK webhook verification is incompatible | Stale. Current SDK parses `X-MP-Signature: t=...,v1=...`, covers timestamp freshness, rotation secrets, multiple signatures, sync and Web Crypto paths. |
| Tracker lacks `/live` and `/ready` | Stale. Both routes now exist and the current local container returns 200. |
| Cashfree timestamp handling is broken | Stale. Current verifier accepts 13-digit milliseconds and 10-digit seconds, signing the raw timestamp. |
| Billing marker is outside state mutation | Stale. `billing_events` insert and subscription/customer mutation now share one DB transaction. |
| Send-worker duplicate claim is non-atomic | Stale. Worker uses conditional `queued -> sending UPDATE ... RETURNING`. |
| Outbox crash window has no repair | Stale. `reclaimStaleSendOutbox()` reclaims stale `enqueued` rows and deterministic job IDs reduce duplicate risk. |
| ClickHouse loss has no reconciliation | Partially stale. A watermark reconciler now exists, but its current duplicate/concurrency design is not 10/10. |
| Consent ledger/legal hold/audit hash chain/SCIM are absent | Stale as an implementation claim. All four now have code, migrations, docs, and tests; their production semantics still have gaps described below. |
| Helm lacks security contexts | Stale. API/worker/tracker and migration job now use non-root/seccomp/capability-drop settings. Read-only root filesystems and restricted-policy proof are still missing. |
| App containers run migrations at startup | Stale for current Dockerfiles. A dedicated Compose/Helm migration job is now used. |
| Production dependency audit has 27 moderate advisories | Stale. Current `npm audit --omit=dev --audit-level=moderate` reports zero. |

## 32.4 Tenant Isolation And Database Boundary

Current score: 5.5/10

What improved:

- `tenantScoped(req, fn)` maps authenticated API-key/session tenants to a
  transaction-local `app.customer_id`.
- High-risk message, analytics, template, suppression, privacy, usage, webhook,
  domain, and activity paths now use tenant transactions in many places.
- Production startup checks the current DB role for superuser/BYPASSRLS.
- Tests recognize both permissive and fail-closed RLS regimes.

What still blocks 10/10:

1. The active migration `023_rls.sql` remains fail-open when tenant context is
   absent: every policy includes `OR current_tenant_id() IS NULL`.
2. The fail-closed migration remains in `infra/migrations-pending/`; it is not
   applied by normal deploys.
3. `rlsIsEnforced()` catches any unexpected DB/probe error and returns `true`.
   A broken role-introspection query therefore reports a safe posture instead
   of failing closed.
4. `api_keys` deliberately retains a null-tenant-permissive policy for prefix
   lookup. This needs a narrow security-definer lookup, separate auth role, or
   dedicated credential index/table rather than a broad policy exception.
5. New tenant tables are inconsistent. `unsubscribe_groups`, memberships,
   SCIM tokens, deletion requests, and other tenant-derived tables do not all
   share one enforced RLS inventory policy.
6. Route security metadata is still not a first-class registry. There is no
   automatic guarantee that every new tenant route uses tenant-scoped DB access.
7. Some shared tenant services still open their own `withTenant()` transaction,
   which can fragment a logical operation across transactions instead of using
   one request context/executor end to end.

10/10 acceptance:

- Move a reviewed fail-closed migration into the normal migration stream.
- Use distinct least-privilege API, worker, admin, and migration roles.
- Make DB-role/RLS startup verification throw/fail on probe error.
- Generate a tenant-table inventory and fail CI if any table lacks the expected
  RLS mode and policies.
- Generate route metadata and fail CI when a tenant route has no tenant executor.
- Prove cross-tenant read/write denial for every ID-bearing route while
  intentionally removing an application-level `customer_id` predicate.
- Run the staging rollout/load test described by the pending migration before
  enabling it in production.

## 32.5 SCIM, Customer SSO, Sessions, And Enterprise Identity

Current score: 4.5/10

### 32.5.1 SCIM User Provisioning - 4.5/10

The new SCIM code is useful but has a serious multi-tenant modeling flaw:

- `users.status`, `users.scim_managed`, and `users.scim_external_id` are global
  user fields.
- A human can belong to multiple customer tenants.
- `PATCH active=false` or `DELETE` from tenant A sets global
  `users.status='disabled'` while preserving memberships.
- That disables the same user in tenant B, even if tenant B did not deprovision
  them.
- Reactivation by either tenant globally re-enables the user.
- Different IdPs/tenants cannot safely maintain distinct `externalId` values
  for the same user.

Additional gaps:

- No `/scim/v2/Groups`, group-to-role mapping, bulk operations, ETags, or
  enterprise IdP compatibility certification.
- SCIM request bodies use `any` and minimal manual validation.
- No dedicated SCIM rate/concurrency limits are visible.
- Membership creation errors are broadly swallowed with `.catch(() => {})`.
- SCIM operations are not consistently recorded in the durable audit chain.
- Token rotation/expiry/IP restrictions are absent; tokens reuse another
  pepper family rather than having an explicit rotation lifecycle.

10/10 solution:

- Move SCIM state to a per-tenant external identity/provisioning table keyed by
  `(customer_id, user_id)` with tenant-specific `external_id` and active state.
- Deprovision by disabling/removing the membership for that tenant and revoking
  tenant-scoped sessions; disable the global user only when no active
  memberships remain.
- Add a regression test where one user belongs to two tenants and tenant A
  deprovisioning does not affect tenant B.
- Add Groups, schema discovery, resource types, ETag/version behavior, complete
  filter validation, rate limits, audit, and Okta/Entra sandbox certification.

### 32.5.2 Customer SSO - 2.5/10

Admin OIDC is implemented, but customer-tenant SAML/OIDC SSO is still absent.
SCIM provisioning alone is not customer SSO. A SendGrid-class enterprise
offering needs per-tenant connections, verified domains, SSO-required policy,
IdP MFA assurance, JIT controls, recovery, and safe account linking.

### 32.5.3 MFA/session maturity - 7.0/10

Password sessions, TOTP, recovery codes, replay protection, revoke/list flows,
and production admin OIDC are strong foundations. Remaining gaps include
WebAuthn/passkeys, OIDC `amr`/`acr` enforcement for admins, device/session risk
metadata, step-up authentication, JIT/break-glass governance, and complete
session revocation on tenant-specific SCIM deprovisioning.

## 32.6 Send Acceptance, Outbox, Worker, And Event Consistency

Current score: 8.0/10

Strong current controls:

- Zod validation, idempotency, quota reservation, suppression checks, domain
  gates, backpressure, abuse review, body offload, and transactional outbox.
- Atomic `queued -> sending` claim prevents duplicate worker ownership.
- Deterministic BullMQ send job IDs and stale-outbox reclamation repair the main
  DB-to-Redis crash window.
- Worker preparation/transport failures are tested not to strand `sending` rows.
- Event insertion and revenue usage increments share a transaction.
- Duplicate event retries resume downstream side effects rather than treating
  event-row existence as proof every side effect completed.

Remaining submodule gaps:

| Submodule | Score | Gap |
| --- | ---: | --- |
| Single send acceptance | 8.5 | Multiple short tenant transactions fragment the request; no formal cost/render-time budget. |
| Batch send | 7.5 | Per-recipient tenant/suppression queries can be transaction-heavy; production-scale proof absent. |
| Send outbox | 8.0 | Stale timeout creates delayed recovery; no explicit claiming state/job-existence reconciliation metric. |
| Send worker claim | 8.5 | Good atomic claim; exactly-once external SMTP delivery remains impossible without provider/message-id reconciliation. |
| Event processing | 7.0 | Post-event side effects remain staged outside one durable processing ledger. |
| Soft-bounce/consent side effects | 6.5 | Retrying a partially processed event can repeat soft-bounce counters or append duplicate consent history. |
| Prometheus counters | 6.5 | Retried side effects can double-increment process metrics even when DB usage is deduplicated. |
| Review approval | 7.0 | Must be proven to use the same durable send-outbox contract for every path. |

10/10 acceptance:

- Add an event processing ledger/outboxes for status, suppression, webhook,
  analytics, and reputation stages.
- Give each side effect a deterministic idempotency key.
- Make suppression/consent events idempotent per source event.
- Add chaos tests at every commit boundary: before/after event insert, status
  update, suppression, webhook enqueue, ClickHouse ship, and SMTP response.
- Publish duplicate-delivery, stranded-send, outbox-age, and reconciliation SLOs.

## 32.7 Deliverability, Domains, DKIM, Haraka, And ISP Operations

Current score: 5.2/10

### 32.7.1 DKIM and domain authentication - 6.0/10

- Domain onboarding generates SPF/DKIM/DMARC guidance and verifies DNS.
- Haraka DKIM signing fails soft/closed when required.
- A DKIM rotation lifecycle exists in `dkim_keys`.
- The signer still reads static `sending_domains.dkim_private_key` and
  `dkim_selector`; it does not select the active `dkim_keys` record.
- DMARC is observed but is not a universal/high-volume send-eligibility gate.
- Return-path generation still uses one global `BOUNCE_DOMAIN`, not the
  per-domain bounce record advertised during onboarding.

### 32.7.2 MTA runtime and TLS - 4.5/10

- Compose runs inbound/outbound Haraka, but Helm does not deploy either MTA
  even though the legacy K8s config selects Haraka transport.
- Haraka images use `npm install`, broad build tooling, unpinned base tags, and
  run as root. Outbound listens on 2525 and does not need root to bind.
- The outbound image generates a ten-year self-signed certificate at build
  time; checked-in TLS config still contains empty key/cert placeholders.
- No production certificate mount/renewal, SMTP STARTTLS smoke evidence,
  MTA-STS/TLS-RPT implementation, TLS policy dashboard, or proven durable queue
  topology exists.
- Haraka images are excluded from CI image scanning.

### 32.7.3 Provider/ISP operations - 4.5/10

The code has reputation, warmup, blocklist, Postmaster/SNDS ingestion, failure
taxonomy, bot filtering, and alert scaffolding. It still lacks the evidence that
defines a mature ESP:

- real sending IP inventory, PTR/forward-confirmed rDNS, HELO, TLS, and pool
  graduation proof;
- 30+ day warmup and inbox-placement artifacts;
- live Google Postmaster, Microsoft SNDS/JMRP, and Yahoo complaint/FBL evidence;
- per-ISP adaptive concurrency/rate shaping tied to enhanced SMTP codes;
- automated complaint/bounce/content/policy incident response;
- production feedback-loop corpus and unknown DSN triage metrics.

Current official requirements rechecked:

- Gmail requires TLS, valid forward/reverse DNS, authentication, DMARC and
  alignment for bulk senders, one-click plus visible unsubscribe for marketing
  mail, and spam rates below 0.3%; Google recommends keeping them below 0.10%.
  Source: https://support.google.com/mail/answer/81126
- Yahoo requires visible/easy unsubscribe and bulk-sender hygiene.
  Source: https://senders.yahooinc.com/best-practices/
- Outlook high-volume sender enforcement requires SPF, DKIM, and DMARC and can
  reject non-compliant mail with `550 5.7.515`.
  Source: https://techcommunity.microsoft.com/blog/microsoftdefenderforoffice365blog/strengthening-email-ecosystem-outlook%E2%80%99s-new-requirements-for-high%E2%80%90volume-senders/4399730

10/10 acceptance:

- Wire active DKIM rotation keys into signing and prove promote/rollback.
- Implement and verify per-domain bounce return paths.
- Add production Haraka/managed-MTA topology with TLS secrets, queue storage,
  probes, PDB, metrics, non-root/capability posture, and image scans.
- Enforce provider-specific authentication/compliance gates before pool
  graduation.
- Produce sustained reputation, inbox placement, complaint, bounce, deferral,
  and warmup evidence under real production-like traffic.

## 32.8 Billing, Plans, Webhooks, And Revenue Integrity

Current score: 5.0/10

Provider-specific verdict:

| Area | Score | Current state |
| --- | ---: | --- |
| Stripe webhook verification | 8.0 | Raw-body HMAC and timestamp tolerance are directionally correct; live Stripe CLI/sandbox proof is still required. |
| PayPal webhook verification | 3.0 | Still uses a custom shared-secret HMAC. This is not PayPal's official certificate/API verification model. |
| Cashfree webhook verification | 7.0 | Millisecond bug is fixed and regression-tested; sandbox delivery proof remains absent. |
| Billing event atomicity | 8.0 | Marker and state mutation now share a transaction. Unknown-customer events are still consumed as successfully processed. |
| Billing replay | 7.0 | Payload retention and admin replay exist; provider event state/ordering and forensic workflow remain limited. |
| Plan catalog | 4.0 | Internal placeholder keys and env JSON mapping remain; checkout accepts caller-supplied price IDs rather than a governed DB catalog. |
| Metering | 7.0 | Durable usage and Stripe reporting exist; PayPal/Cashfree metering is intentionally no-op. |
| Dunning/tax/refunds/credits | 1.5 | Launch-grade workflows are largely absent. |
| Invoices/reconciliation | 4.5 | Drift detection exists, not a full provider invoice/payment correction ledger. |

Critical PayPal correction remains mandatory. Official PayPal verification uses
transmission ID/time/signature, certificate URL, auth algorithm, webhook ID,
and event payload through PayPal verification/certificate semantics. A local
test of the platform's custom HMAC proves only its own invented protocol.
Source: https://developer.paypal.com/docs/api/webhooks/v1/

10/10 acceptance:

- Replace PayPal HMAC with official verification and sandbox fixtures.
- Add a DB-backed versioned plan/price/entitlement catalog.
- Reject price IDs not active for the selected provider/environment.
- Add provider-scoped unique event identity and a received/applying/applied/
  failed/replayed state machine; unknown customers must become repairable tasks.
- Implement dunning, grace/restriction/recovery, proration preview, invoices,
  payments, refunds, credits, tax identity/calculation, and finance exports.
- Certify complete upgrade/downgrade/cancel/payment-failure/recovery flows in
  provider sandboxes without manual DB changes.

## 32.9 Consent, Privacy, Legal Hold, Audit, And Retention

Current score: 5.4/10

### 32.9.1 Consent and preferences - 7.0/10

Append-only `consent_events`, global/group suppression, one-click unsubscribe,
body unsubscribe links, and group-send enforcement now exist. Remaining gaps:

- no complete hosted branded preference center/resubscribe policy;
- consent proof lacks a mature lawful-basis/text/version/source model;
- erasure removes the operational suppression and records an unsuppress event,
  but no tenant-keyed hashed do-not-contact tombstone prevents accidental
  future re-import/re-send;
- retry idempotency for consent-event append is incomplete.

### 32.9.2 Privacy export/erasure - 5.5/10

Legal-hold blocking and body-object orphan checks are real improvements. The
current endpoint still returns `status: completed` after the Postgres
transaction even when object deletion fails. It logs and ignores S3/filesystem
delete failure. It does not orchestrate per-store erasure for ClickHouse,
BullMQ/DLQ, logs/traces, backups, or external provider records. Export remains
a limited synchronous subset and does not load complete message bodies,
headers, metadata, tracked links, group state, audit/deletion evidence, or
ClickHouse rows.

10/10 requires asynchronous export/erasure jobs with per-store state, retries,
legal exceptions, signed evidence, expiration, and backup tombstones.

### 32.9.3 Audit hash chain - 5.5/10

Hash chaining with per-chain advisory locking detects mutation, deletion, and
sequence gaps. It is not immutable storage:

- database administrators can alter both audit and hash tables;
- `recordAuditSafe()` swallows all failures with no durable outbox/alert;
- retention deletes `audit_log`; FK cascade deletes hash links, intentionally
  breaking the chain and making later verification fail from a sequence gap;
- no archived chain root, signed daily checkpoint, WORM/Object Lock sink, or
  external SIEM proof exists.

Retention and tamper evidence must be designed together: archive a signed chain
segment/root before deletion and verify the next segment against that root.

### 32.9.4 Legal hold - 6.5/10

Recipient/tenant holds block the current Postgres erasure endpoint. Holds do not
yet govern retention jobs, ClickHouse TTL/deletion, object lifecycle, queues,
logs, or backups. Hold administration uses the broad `messages` scope rather
than a dedicated compliance permission/approval flow.

## 32.10 ClickHouse, Storage, Analytics, And Data Integrity

Current score: 5.8/10

### 32.10.1 ClickHouse reconciliation - 6.0/10

The watermark reconciler prevents permanent omission when the best-effort live
write fails. Its 10/10 claims are not yet valid:

- live dual write plus reconciliation can insert the same event twice;
- the ClickHouse table is a plain `MergeTree`, not a deduplicating engine and
  has no stable Postgres event ID column;
- comments claim query-time or `ReplacingMergeTree` deduplication, but the
  checked-in schema implements neither;
- concurrent reconcilers do not lock/lease the single watermark row;
- the query converts a `BIGSERIAL` watermark through JavaScript `Number`, which
  is unsafe beyond `2^53-1`;
- one global watermark and no tenant/partition repair inventory limits
  operational diagnosis;
- privacy erasure and legal hold are not propagated to ClickHouse.

10/10 solution:

- Include immutable Postgres `event_id` in ClickHouse and use a design with
  explicit deduplication semantics.
- Use a distributed lease/advisory lock for one reconciler.
- Keep cursor comparisons as bigint/string-safe SQL values.
- Add count/hash reconciliation by tenant/day/event type, backfill tooling,
  deletion/tombstone support, backup/restore, lag alerts, and duplicate-rate
  tests.

### 32.10.2 Object storage - 6.5/10

Inline/filesystem/S3-compatible storage and body-offload tests exist. Missing
evidence includes MinIO CI, least-privilege prefix IAM, SSE/KMS enforcement,
lifecycle/versioning/replication, credential/IAM-role modes in config guard,
failure retry queues, legal hold/Object Lock integration, and restore/erasure
proof against real S3-compatible infrastructure.

### 32.10.3 Analytics privacy/scaling - 6.0/10

Analytics endpoints and ClickHouse scaffolding are useful, but small-bucket
privacy thresholds, tenant privacy modes, high-cardinality/cost guards, durable
export, and real large-scale query/load evidence are absent.

## 32.11 API, OpenAPI, SDK, Docs, And Public Lifecycle

Current score: 6.0/10

What improved:

- Stable error-code registry and compatibility test exist.
- OpenAPI baseline breaking-change tests exist.
- Route parity makes undocumented growth visible.
- SDK webhook helpers now match the worker's actual signature protocol.
- Docs and SDK production builds pass.

What still blocks 10/10:

1. The API has about 168 route declarations across 22 route files, while the
   hand-maintained OpenAPI contains only about 51 path entries.
2. Route parity explicitly allowlists many undocumented `/v1` operations. It is
   a drift ratchet, not proof of a complete public contract.
3. SCIM routes are not included in the parity collector.
4. The breaking-change detector checks operation removal, operation ID, and
   newly required parameters, but not removed/changed response fields, request
   schema changes, enum narrowing, auth/scope changes, status codes, or error
   semantics.
5. Route validation is inconsistent; several routes cast `req.body`, query, or
   params rather than using response/request schemas registered with Fastify.
6. `admin.ts` remains roughly 1,000 lines and combines many high-risk domains.
7. SDK is TypeScript-only, privately packaged, handwritten, and not proven to
   cover the complete intended public API.
8. No docs-snippet compile/run gate, SDK publish workflow, npm provenance, or
   generated Python/Go/Java clients exist.

10/10 acceptance:

- Establish one route-contract source of truth that generates runtime schemas,
  OpenAPI, SDKs, examples, and route security metadata.
- Eliminate the public-route allowlist by documenting every supported public
  route or moving internal/dashboard routes to a clearly separate contract.
- Expand compatibility diffing to full request/response/auth/error semantics.
- Compile and execute docs snippets in CI.
- Split admin routes by capability and add two-person controls for destructive
  or revenue/security-sensitive operations.
- Publish signed/provenance-backed multi-language SDK artifacts with semver and
  migration guides.

## 32.12 Configuration, Secrets, Containers, Helm, CI, And Supply Chain

Current score: 5.6/10

### 32.12.1 Config guard - 5.5/10

Core secret/default detection, admin OIDC requirements, and selected billing
webhook secret checks exist. Production still does not comprehensively reject:

- `BILLING_PROVIDER=mock` or live providers silently falling back to mock;
- PayPal without official verification fields/webhook ID;
- non-HTTPS tracking/app URLs;
- `SKIP_PHYSICAL_ADDRESS_CHECK=true`;
- incomplete S3/IAM, KMS, delivery transport, ClickHouse TLS/auth, OTel, SMTP
  TLS, and DKIM configuration;
- active fail-open RLS policy or a failed RLS introspection probe;
- incompatible retention, audit-chain, legal-hold, and analytics settings.

### 32.12.2 Images and runtime - 5.5/10

API/worker/tracker run as `node` and no longer migrate at startup. Remaining
gaps:

- base images use mutable tags, not digests;
- Docker builds use `npm install` and copy broad workspace trees;
- production runtime contains the full build workspace/dependency tree rather
  than minimal pruned artifacts;
- root filesystems remain writable in Helm;
- Dockerfile/Compose healthchecks and production restart policies are absent;
- Haraka runs as root and is not included in image scanning;
- Prometheus, Grafana, Alertmanager, Mailpit, Postgres, Redis, Jaeger, and
  ClickHouse images use mutable tags in local topology.

### 32.12.3 Helm/Kubernetes - 6.0/10

Non-root UID/GID, seccomp, capability drop, resources, PDBs, NetworkPolicies,
and probes are present. Missing items include startup probes, worker readiness
using `/ready` instead of `/health`, read-only root filesystems with explicit
writable mounts, ExternalSecrets/managed secret examples, Haraka deployments,
queue-age autoscaling, immutable image digests, restricted Pod Security
admission proof, chart lint/render tests, and cloud reference values.

### 32.12.4 CI/release - 5.0/10

Current CI builds core services, tests, audits, emits an SBOM, and scans three
images. Important gaps:

- workflow push trigger is only `main`, while the checked-out branch is
  `master`; direct pushes to `master` may not run this workflow;
- SDK and docs are not part of the enforced build job;
- no Helm lint/template/schema/policy test;
- actions use mutable version tags rather than pinned commit SHAs;
- workflow permissions are not explicitly least-privilege;
- production audit gate is high-only even though local moderate-level
  production audit currently passes;
- SBOM generation is allowed to fail via `|| true` and missing upload is only a
  warning;
- Haraka/docs images are not scanned;
- no CodeQL/secret scanning/Scorecard/provenance/signing/release workflow;
- no staging smoke/load/failover/restore gate and no signed release-evidence
  manifest.

10/10 acceptance:

- Fix branch triggers and make build/test/docs/SDK/Helm/image checks mandatory.
- Make SBOM generation/validation fail closed; generate source and image SBOMs.
- Pin actions/base images, sign images/packages, emit attestations/provenance,
  and verify them before deployment.
- Add protected production environments and signed release evidence containing
  commit/tag, image digests, SBOM hashes, audit/scans, OpenAPI diff, SDK pack,
  migration, smoke, load, failover, and restore results.

## 32.13 Test, Load, HA, DR, And Operational Proof

Current score: 5.8/10 for automated testing, 4.2/10 for production proof

Strengths:

- 646 tests cover unit, DB integration, E2E, security, RLS, idempotency,
  outbox, worker failures, billing, SCIM, legal hold, consent, audit chain,
  ClickHouse reconciliation, OpenAPI, SDK signatures, and webhooks.
- Build and docs build are clean after a deterministic install.
- k6 assets and thresholds exist.

Gaps:

- test infrastructure must be started separately and leaked handles cause a
  shutdown timeout;
- no coverage instrumentation/threshold is enforced;
- no fuzzing/property tests for MIME, DSN/ARF, SCIM filters, template rendering,
  webhook parsing, and billing payloads;
- no staging k6 artifacts for API, batch, tracker, webhook, or queue drain;
- no Redis failover, Postgres failover/PITR, worker kill, SMTP outage, DNS
  outage, object-store outage, ClickHouse restore, or network-partition drills;
- no per-workload RPO/RTO and signed restore evidence;
- no alert fire-drill or on-call integration proof;
- local running containers have no restart policy or Docker healthcheck.

10/10 acceptance:

- Provide a single command that starts isolated dependencies, migrates, runs
  tests, closes all handles, and tears down reliably.
- Run sustained/soak/burst tests in staging with multiple replicas and managed-
  topology equivalents.
- Publish capacity envelopes and SLO/error-budget results.
- Execute and retain quarterly failover/restore/alert/security game-day evidence.

## 32.14 Highest-Risk Current Gaps

| Rank | Gap | Severity | Why it blocks mature production |
| ---: | --- | --- | --- |
| 1 | Fail-closed RLS migration is still pending | Critical | Missing tenant context still turns RLS into allow-all under active policies. |
| 2 | SCIM deactivation is global, not tenant-specific | Critical | One tenant can disable a shared user in other tenants. |
| 3 | PayPal webhook verifier is not PayPal's protocol | Critical if PayPal enabled | Live events are not being verified with official semantics. |
| 4 | No real deliverability/IP reputation evidence | Critical for ESP launch | Inbox placement and provider acceptance cannot be inferred from code. |
| 5 | DKIM rotation is not wired into signing | High | Promoted keys do not control the actual signer. |
| 6 | Haraka production topology/TLS is incomplete | High | Current self-signed/root/Compose-only posture is not a production MTA fleet. |
| 7 | Privacy erasure can report complete with failed object deletion | High | Compliance status is not truthful across stores. |
| 8 | Audit retention intentionally breaks the hash chain | High | Tamper verification and retention policy conflict. |
| 9 | ClickHouse reconciliation can duplicate rows | High | Checked-in `MergeTree` does not implement claimed deduplication. |
| 10 | Billing catalog/dunning/tax/refunds incomplete | High | The SaaS revenue lifecycle is not launch-complete. |
| 11 | OpenAPI covers only a subset of public routes | High | Contract, docs, SDK, and compatibility are incomplete. |
| 12 | No staging load/failover/restore proof | High | Capacity and recovery objectives are unverified. |
| 13 | Config guard allows half-configured subsystems | High | Production can boot in unsupported provider/storage/MTA states. |
| 14 | Per-domain bounce alignment remains global | Medium-high | Return-path alignment and customer DNS claims do not match runtime. |
| 15 | CI branch/release/evidence gaps | Medium-high | Checks and artifact integrity are not guaranteed for production promotion. |
| 16 | Test runner leaks resources | Medium | Test completion is slow/noisy and can hide lifecycle defects. |
| 17 | Compose lacks service restart/health policy | Medium | Self-host runtime does not self-heal predictably. |
| 18 | Customer SSO is absent | Medium-high for enterprise | SCIM alone does not satisfy enterprise authentication. |
| 19 | Event side effects lack a durable stage ledger | Medium-high | Crash retry can duplicate or omit non-transactional side effects. |
| 20 | No governed preference center/hashed opt-out tombstone | Medium-high | Consent and erasure duties can conflict. |

## 32.15 Exact Remediation Order

### Phase 0: stop correctness/security exposure

1. Redesign SCIM state per `(customer_id, user_id)` and add the two-tenant
   deprovision regression test.
2. Make `rlsIsEnforced()` fail closed on errors and complete the staged RLS
   role/migration rollout in staging.
3. Disable PayPal in production until official webhook verification and sandbox
   certification exist.
4. Make erasure remain `pending/failed` until every required store succeeds.
5. Reconcile audit retention with chained/signed archive roots.

### Phase 1: make the mail path production-real

1. Wire `dkim_keys.state='active'` into Haraka signing.
2. Add per-domain verified bounce return paths.
3. Deploy/harden Haraka or select a managed outbound provider with a fully
   supported topology.
4. Add TLS/cert/queue/probe/metrics/scan evidence.
5. Add ISP-specific retry/throttle policy and live feedback-loop ingestion.

### Phase 2: make SaaS state durable

1. Add event side-effect processing ledger/outboxes.
2. Make ClickHouse event IDs/deduplication/concurrency/privacy correct.
3. Add DB-backed plans/entitlements and complete billing provider workflows.
4. Add asynchronous privacy export/erasure orchestration.
5. Add customer SSO and tenant-specific session/deprovision semantics.

### Phase 3: make deployment and release provable

1. Expand the production config guard across every enabled subsystem.
2. Complete OpenAPI coverage and generate SDK/docs from one contract.
3. Fix CI branch triggers, include docs/SDK/Helm/Haraka, and make SBOM/scans
   fail closed.
4. Pin/sign/attest images and packages.
5. Produce staging load, chaos, failover, restore, and alert evidence for every
   release candidate.

## 32.16 Final Current-Tree Answer

The current platform is substantially better than a prototype and has several
production-quality design patterns. The send API, quota/idempotency controls,
transactional outbox, atomic worker claim, webhook SSRF defense, unsubscribe
flow, tests, and modular infrastructure are meaningful strengths.

It is still not comparable to SendGrid, Mailgun, or Mailjet as an operated
service. Those products' maturity includes years of real ISP reputation,
globally redundant MTA/data-plane operations, abuse response, billing and
support workflows, capacity evidence, recovery drills, enterprise identity,
compliance evidence, and stable developer contracts. This repository contains
many of the right shapes, but several controls remain staged, internally
inconsistent, or proven only by local tests.

The honest current label is:

> Strong early-production transactional mail platform; suitable for controlled
> staging/pilot work after the critical isolation, SCIM, PayPal, erasure, and MTA
> issues are addressed. Not yet a general-availability multi-tenant ESP and not
> yet SendGrid/Mailgun/Mailjet-class.

# 33. Remediation Execution Log

This section records implemented remediations after the thirteenth-pass audit.
It supersedes matching open findings in section 32 when the implementation and
verification evidence below are present.

## 33.1 Step 1 Complete: Tenant-Specific SCIM State

Completion date: 2026-07-10

Resolved critical defect:

- SCIM state previously lived on global `users` columns.
- Deprovisioning a person in tenant A set global `users.status='disabled'` and
  could disable the same person in tenant B.
- A single global `scim_external_id` also could not represent different IdPs
  provisioning the same human into different tenants.

Implementation:

- Added migration `042_scim_tenant_state.sql`.
- Moved authoritative SCIM state to each `memberships` row:
  - `scim_managed`
  - `scim_external_id`
  - `scim_display_name`
  - `scim_active`
  - `scim_updated_at`
- Added tenant-scoped external-ID uniqueness on
  `(customer_id, scim_external_id)`.
- Backfilled legacy SCIM-managed users into membership state.
- SCIM GET/list/filter/create/update/delete now read and mutate tenant
  membership state rather than global user state.
- Tenant deprovisioning revokes only sessions whose current tenant is the
  deprovisioned tenant.
- Normal membership/session resolution excludes inactive SCIM memberships, so
  an existing session cannot switch back into a deprovisioned tenant.
- Sessions and memberships in other tenants remain active.
- Reprovisioning an existing owner/admin no longer overwrites the role with the
  default `analyst` role.
- SCIM display-name changes are tenant-specific and no longer modify another
  tenant's view of the shared global user.

Verification:

| Check | Result |
| --- | --- |
| Root TypeScript build | Pass |
| Fresh migration application | Pass |
| Migration baseline behavior | Pass |
| Focused SCIM/migration/topology tests | 20/20 pass |
| Full repository suite | 96 files, 648 tests pass |
| Cross-tenant deprovision regression | Pass: tenant A session revoked; tenant B session remains valid |
| Per-tenant external ID/display name | Pass |
| Existing role preservation | Pass: admin role remains admin after reprovision |

Known remaining SCIM gaps, not claimed complete:

- Customer interactive SAML/OIDC SSO is still absent.
- `/scim/v2/Groups`, ETags, bulk operations, schema/resource discovery, and
  complete RFC 7644 filtering are not implemented.
- SCIM tokens still need expiry/rotation policy, dedicated rate limits, and
  optional network restrictions.
- SCIM mutations need complete durable audit coverage and IdP sandbox
  certification with Okta/Entra.
- Legacy global SCIM columns remain temporarily for migration rollback and
  should be removed only after a verified production backfill window.

Score correction after remediation:

| Area | Before | After |
| --- | ---: | ---: |
| SCIM tenant isolation | 4.5/10 | 7.0/10 |
| Enterprise identity overall | 4.5/10 | 5.0/10 |
| Multi-tenant SaaS readiness | 5.8/10 | 6.0/10 |

The next remediation step is fail-closed RLS enforcement and safe API/service
role separation.

# 34. Remediation Execution Log — Fail-Closed RLS

Date: 2026-07-10

Step 2 is implemented and verified in the current tree.

## Changes made

- Added `infra/migrations/043_rls_fail_closed.sql`.
- Enabled `FORCE ROW LEVEL SECURITY` on the tenant tables covered by the API.
- Replaced the previous `current_tenant_id() IS NULL` allow-all policies with
  explicit `USING` and `WITH CHECK` tenant predicates.
- Kept `api_keys` as an explicit service/pre-auth exception; it is documented
  and must not be treated as tenant data access.
- Changed `rlsIsEnforced()` to fail closed when the database role or policy
  posture cannot be verified.
- Added a regression test proving a tenant A transaction cannot insert a row
  for tenant B.
- Removed the obsolete pending migration `036_rls_fail_closed.sql` so the
  migration is part of the normal forward-only migration stream.
- Split production database configuration into:
  - `API_DATABASE_URL` for the non-superuser, non-BYPASSRLS API role.
  - `SERVICE_DATABASE_URL` for worker/tracker/Haraka service-role paths.
  - `MIGRATION_DATABASE_URL` for schema migration execution.
- Updated Compose, Helm, Kubernetes secret examples, and production readiness
  validation to require the three explicit URLs.

## Verification

| Check | Result |
| --- | ---: |
| `npm run prod:check` | Pass in template mode |
| Production Compose config render | Pass |
| Focused RLS/migration tests | 7 passed |
| Full Vitest suite | 96 files, 649 tests passed |
| `npm run build` | Pass for shared/api/worker/tracker/sdk |
| `git diff --check` | Pass |

The suite still reports a Vitest 10-second close timeout after all tests pass.
This is a test-harness resource-lifecycle defect, not a failed assertion, and
remains a separate remediation item.

## Remaining operational proof

- Apply migration 043 to staging and production using a real migration role.
- Create and verify the API/service roles with `scripts/setup-rls-roles.sql` or
  the cloud-provider equivalent.
- Prove the API role is not owner, superuser, or BYPASSRLS at deployment time.
- Run a two-tenant staging smoke test through actual API routes, not only direct
  database tests.
- Prove worker, scheduler, admin, and Haraka service-role paths still access
  only the data they are explicitly authorized to access.
- Convert the remaining tenant-scoped services from global `db` imports to
  request/service executors so route-level RLS context is consistently applied.

Score correction after remediation:

| Area | Before | After |
| --- | ---: | ---: |
| RLS policy posture | 4.5/10 | 7.0/10 |
| Tenant isolation overall | 4.5/10 | 5.5/10 |
| Production database-role separation | 4.0/10 | 6.0/10 |
| Multi-tenant SaaS readiness | 6.0/10 | 6.2/10 |

The next highest-risk remediation is to enforce tenant executors in API route
execution and remove remaining global-database access from tenant services.

# 35. Remediation Execution Log — Webhook Tenant Executors

Date: 2026-07-11

The first tenant-scoped shared-service conversion is complete for customer
webhook management.

## Changes made

- `packages/shared/src/webhooks.ts` accepts an optional `TenantExecutor` for
  list, create, update, delete, and secret rotation operations.
- The service retains a `withTenant()` fallback for scheduler-safe and legacy
  callers, so this conversion is backward compatible while routes migrate.
- API-key webhook list, delete, and secret rotation now pass the request-owned
  executor from `tenantScoped()`.
- Dashboard webhook list, delete, and secret rotation do the same.
- Create and URL-changing update intentionally retain short service-owned
  tenant transactions after their DNS/SSRF validation; network resolution must
  not be performed while a database transaction is held.

## Verification

| Check | Result |
| --- | ---: |
| Shared package build | Pass |
| API package build | Pass |
| Webhook service/API/dashboard E2E tests | 22 passed |

## Remaining work

- Convert the other RLS-backed service families using the same executor-first
  pattern, prioritizing templates, domains, membership/team operations, and
  customer support.
- Add a route inventory test that requires tenant-scoped handlers to declare
  their executor/transaction policy.
- Remove global `db` imports from tenant service paths once their callers have
  migrated; retain them only for explicit service-role scheduler/admin code.

# 36. Remediation Execution Log — Domain Executors And Test Harness Shutdown

Date: 2026-07-11

Two further production-readiness gaps were remediated.

## Domain executor integration

- `packages/shared/src/domains.ts` now accepts a request `TenantExecutor` for
  list, detail, and delete operations, retaining a safe `withTenant()` fallback
  for non-request callers.
- API-key and dashboard domain read/delete handlers now pass the request-owned
  executor through `tenantScoped()`.
- Domain creation and DNS verification retain their short service-owned tenant
  transactions: DKIM key generation and DNS lookups are CPU/network operations
  and must not run while a request transaction is held open.

## Test harness shutdown fix

- `packages/tests/global-setup.ts` now closes the shared BullMQ queue clients
  and Kysely/Postgres pool during global teardown.
- The hanging-process reporter previously identified four Redis TCP handles
  from BullMQ plus dependent open handles after otherwise successful tests.
- Focused validation now exits cleanly without the previous Vitest 10-second
  shutdown timeout.

## Verification

| Check | Result |
| --- | ---: |
| Domain service/API/dashboard tests | 23 passed |
| Hanging-process regression test | Pass; no open-handle report |
| Full Vitest suite | 96 files, 649 tests passed |

Score correction after remediation:

| Area | Before | After |
| --- | ---: | ---: |
| Domain request RLS integration | 6.0/10 | 7.0/10 |
| Test-harness reliability | 6.5/10 | 8.0/10 |

The full suite no longer emits the Vitest close-timeout warning. Remaining test
infrastructure work is production-like failover, load, and cloud-provider
integration evidence rather than basic one-command test reliability.

# 37. Remediation Execution Log — Message Activity And Tenant Route Guard

Date: 2026-07-11

## Message activity executor integration

- `listMessageActivity()` now accepts an optional `TenantExecutor`.
- `GET /v1/messages/activity` passes its request transaction into that service.
- The `events` + `messages` join is therefore executed under the same
  transaction-local `app.customer_id` setting as the rest of the route.

## RLS route regression guard

- Added `packages/tests/tenant-route-rls-guard.test.ts`.
- It scans every non-admin API route module and fails when an RLS-backed table
  (`messages`, `events`, `suppressions`, `templates`, `sending_domains`,
  `webhooks`, `usage_daily`, `review_queue`, `consent_events`, or
  `legal_holds`) is queried through the global `db` handle.
- The explicit admin plane remains excluded because it is cross-tenant by
  design and must run only with the documented service role.

## Verification

| Check | Result |
| --- | ---: |
| Shared/API builds | Pass |
| Message activity E2E tests | 3 passed |
| Tenant route RLS guard | Pass |

This turns a previously review-only expectation into a CI-enforced invariant:
customer API routes cannot accidentally bypass their request tenant context for
the currently RLS-protected tables.

# 38. Remediation Execution Log — Official PayPal Webhook Verification

Date: 2026-07-11

The former custom PayPal HMAC verifier was not compatible with PayPal's
official webhook protocol and has been replaced.

## Changes made

- `verifyPayPalSignature()` is now asynchronous and uses PayPal's official
  `verify-webhook-signature` endpoint.
- It first obtains an OAuth token using `PAYPAL_CLIENT_ID` and
  `PAYPAL_CLIENT_SECRET`, then forwards the required transmission ID, time,
  signature, certificate URL, auth algorithm, configured webhook ID, and
  parsed webhook event.
- The handler requires `PayPal-Cert-Url` and `PayPal-Auth-Algo` in addition to
  the transmission headers. Missing inputs, stale messages, OAuth failures,
  network failures, non-2xx responses, and any verification status other than
  `SUCCESS` are rejected.
- The production configuration guard requires all of:
  `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_WEBHOOK_ID` whenever
  `BILLING_PROVIDER=paypal` is selected. It cannot silently use a mock or
  custom-HMAC fallback.
- Updated production environment and billing documentation to remove the old
  `PAYPAL_WEBHOOK_SECRET` claim.

## Verification

| Check | Result |
| --- | ---: |
| Official OAuth/postback protocol test | Pass |
| Missing-header/non-SUCCESS fail-closed test | Pass |
| Billing config-guard tests | Pass |
| Multi-provider billing E2E tests | Pass |
| Focused total | 26 tests passed |

## Remaining billing work

- Run the same path against a real PayPal sandbox listener and store release
  evidence.
- Add OAuth token caching and timeout/circuit-breaker metrics for the PayPal
  verification dependency.
- Complete provider-neutral plan catalog, dunning, invoices, refunds, tax, and
  reconciliation correction workflows.

Score correction after remediation:

| Area | Before | After |
| --- | ---: | ---: |
| PayPal webhook verification | 3.5/10 | 7.5/10 |
| Billing webhook security | 6.5/10 | 8.0/10 |

# 39. Remediation Execution Log — Server-Side Checkout Plan Validation

Date: 2026-07-11

## Changes made

- `POST /v1/account/billing/checkout` now validates `price_id` with the
  server-side known-plan resolver before provisioning a billing customer or
  creating a provider checkout session.
- Unknown, retired, or arbitrary caller-supplied price IDs receive
  `422 unknown_price`.
- The guard accepts only internal catalog keys or explicitly mapped live
  provider prices, preserving current Stripe/self-hosted compatibility.

## Verification

| Check | Result |
| --- | ---: |
| API build | Pass |
| Outbound billing, multiprovider, PayPal protocol E2E | 16 tests passed |
| Unknown-price provider-call regression | Pass; zero provider calls |

## Remaining work

- Replace the in-code/env catalog with database-backed plans, provider-price
  mappings, activation dates, and feature entitlements.
- Add trial, past-due, grace-period, suspension, downgrade, dunning, refund,
  tax, invoice, and financial reconciliation workflows.

# 40. Remediation Execution Log — Production Compose Runtime Health

Date: 2026-07-11

## Changes made

- Production Compose now sets `restart: unless-stopped` for API, worker, and
  tracker.
- Added Docker health checks using the services' real local endpoints:
  API `/live`, worker `/health`, and tracker `/live`.
- Added start periods, bounded retries, and timeouts so first boot is not
  mistaken for a crash.
- Added a CI topology regression test that requires restart policy and HTTP
  health checks for each production app service.

## Verification

| Check | Result |
| --- | ---: |
| Compose hardening topology test | 7 passed |
| Production readiness template check | Pass |
| Production Compose config render | Pass |

This closes the earlier Compose-specific resilience gap. It does not prove HA:
production still needs managed Postgres/Redis, multi-replica orchestration,
restore/failover drills, and Kubernetes-level probes/autoscaling evidence.

# 41. Remediation Execution Log — Kubernetes Read-Only Root Filesystems

Date: 2026-07-11

- API, worker, and tracker Helm containers now set
  `readOnlyRootFilesystem: true`.
- Each workload receives only a writable `/tmp` `emptyDir` and `TMPDIR=/tmp`.
- Existing `runAsNonRoot`, explicit UID/GID, capability drop,
  `allowPrivilegeEscalation: false`, and RuntimeDefault seccomp controls remain
  in place.
- The topology test now enforces the entire restricted workload posture for all
  three services.

Verification: 8 topology/security tests passed, including the new regression
guard. A Helm render against a real cluster policy engine remains required
before calling this production-proven.

# 42. Remediation Execution Log — Local Runtime And DKIM Haraka Proof

Date: 2026-07-11

- Main Compose API, worker, tracker, Postgres, Redis, inbound Haraka, outbound
  Haraka, and Mailpit are running.
- API `/live` and `/ready`, tracker `/live` and `/ready`, and worker `/health`
  and `/ready` all returned HTTP 200.
- API, tracker, and worker `/metrics` returned HTTP 401 without credentials.
- Haraka inbound and outbound SMTP ports accepted TCP connections.
- Outbound Haraka was rebuilt from the current tree; the running image contains
  the `LEFT JOIN dkim_keys AS active_key` signer query.
- Startup logs prove the DKIM plugin connected to Postgres, the event emitter
  connected to Redis/BullMQ, and Haraka listened successfully on port 2525.

The remaining Haraka gap is production infrastructure: trusted TLS secrets,
PTR/HELO alignment, persistent queue storage, Kubernetes workloads/services,
MTA metrics, failover testing, and real ISP deliverability evidence.

# 43. Remediation Execution Log — Haraka Kubernetes Baseline

Date: 2026-07-11

- Added an outbound Haraka StatefulSet and internal SMTP Service.
- Added PVC-backed outbound queue storage with configurable size/storage class.
- Added an inbound Haraka Deployment and configurable LoadBalancer Service
  exposing port 25 while the non-root container listens on 2526.
- Both workloads mount trusted Kubernetes TLS Secrets and generated Haraka
  `tls.ini` files, use read-only roots, drop capabilities, and define TCP
  startup/readiness/liveness probes.
- Worker SMTP host/port now resolve from the Helm release fullname.
- Both Haraka images now run as the non-root `node` user.
- Local images built successfully; recreated containers run as `node`, connect
  to Postgres/Redis, and accept SMTP TCP connections on 2525/2526.
- Ten topology tests passed, including durable queue, TLS mount, non-root, and
  non-privileged inbound-port guards.

Remaining production evidence: install/render with Helm, provision real TLS
Secrets and a static inbound IP, validate PTR/HELO and DNS, exercise STARTTLS,
and prove queue recovery during pod/node disruption.

# 44. Remediation Execution Log — Privacy Erasure Finality

Date: 2026-07-11

- Added migration `044_privacy_erasure_objects.sql` with durable per-object
  erasure items, retry status, attempt count, error, and completion timestamps.
- Recipient deletion requests now begin as `pending`, not `completed`.
- Every orphaned body object is recorded inside the erasure transaction before
  the database rows commit.
- Successful object deletion marks its item completed; storage failure records
  the error and leaves the overall request pending.
- The API returns HTTP 202 with `objects_pending` when external erasure is not
  final, and returns completed only when all required objects are gone.
- Shared/API builds pass; fresh migrations and privacy erasure tests pass,
  including simulated object-store outage and deduplicated shared-body safety.

Remaining privacy work: add a scheduled retry worker for failed object items,
then extend the same per-store state machine to ClickHouse, queues/DLQ,
logs/traces, and backup tombstones.

# 45. Remediation Execution Log — Privacy Object Erasure Retries

Date: 2026-07-11

- Added a shared retry processor for pending/failed body-object erasures.
- Retry rows are claimed with `FOR UPDATE SKIP LOCKED`, allowing multiple
  workers without duplicate concurrent deletion attempts.
- The worker scheduler runs the processor every five minutes with configurable
  batch and maximum-attempt limits.
- Storage-kind mismatches fail closed instead of deleting through the wrong
  backend.
- A parent deletion request becomes `completed` only after every object item is
  completed; exhausted requests become `failed` for operator intervention.
- Shared and worker TypeScript builds pass.
- The focused privacy suite passes all 3 tests, including outage, durable
  pending status, storage recovery, automatic retry, and final completion.

Remaining privacy work: model ClickHouse, queues/DLQ, logs/traces, and backup
tombstones as durable per-store erasure items; add metrics/alerts and an admin
repair workflow for exhausted erasure requests.

# 46. Remediation Execution Log — ClickHouse Subject Erasure

Date: 2026-07-11

- Recipient deletion now captures every affected message ID before PostgreSQL
  removes the message rows.
- When ClickHouse is enabled, each message becomes a durable erasure work item
  in the same per-store state machine used by body storage.
- The retry worker dispatches ClickHouse items through a tenant-and-message
  scoped `ALTER TABLE ... DELETE` mutation with `mutations_sync=2`.
- ClickHouse table identifiers are validated and values use ClickHouse query
  parameters rather than interpolated SQL literals.
- The API remains `pending`/HTTP 202 while any ClickHouse mutation is pending or
  failed; it no longer derives completion only from body-storage outcomes.
- Migration `045_privacy_erasure_item_identity.sql` makes durable item identity
  include the store kind.
- Shared, API, and worker builds pass. The ClickHouse and privacy suites pass
  all 8 focused tests, including verification of tenant/message parameters and
  synchronous mutation behavior.

Remaining ClickHouse privacy risk: add a durable pre-insert tombstone check so
an already-buffered or delayed event cannot be inserted after subject erasure.
Queues/DLQ, logs/traces, and backup tombstones also remain outside the durable
per-store completion state machine.

# 47. Remediation Execution Log — Analytics Erasure Reinsertion Barrier

Date: 2026-07-11

- Added migration `046_privacy_message_tombstones.sql` with a minimal durable
  `(customer_id, message_id)` erasure barrier.
- Tombstones are written inside the same tenant transaction that deletes the
  recipient's PostgreSQL messages and events.
- Tombstones intentionally do not cascade from deletion-request history, so
  retention cannot silently remove the reinsertion guard.
- Live ClickHouse writes check the barrier before buffering and re-check it at
  buffer flush time.
- ClickHouse reconciliation filters tombstoned rows while still advancing its
  durable watermark past them, avoiding an infinite reconciliation backlog.
- Shared, API, and worker builds pass; migration 046 applied successfully.
- Nine focused ClickHouse/privacy tests pass, including proof that a tombstoned
  event is not shipped and that recipient deletion creates the tombstone.

Remaining privacy stores: BullMQ waiting/delayed/failed jobs and DLQ payloads,
logs/traces, and backup erasure/tombstone evidence. Queue erasure must avoid
racing active workers and must not expose recipient PII during its scan.

# 48. Remediation Execution Log — BullMQ And DLQ Subject Erasure

Date: 2026-07-11

- Recipient deletion now creates a durable `bullmq` erasure item for every
  affected message ID.
- Added bounded, structural payload scanning across send, events, webhooks, and
  dead-letter queues, including nested webhook and DLQ payloads.
- Waiting, delayed, failed, paused, completed, prioritized, and
  waiting-children jobs containing the erased message ID are removed.
- Active matching jobs are not force-removed; they keep the deletion request
  pending and are retried after the worker releases them.
- Queue cleanup is attempted immediately after the database transaction, so a
  clean queue preserves the synchronous completed response. Redis failures or
  active jobs fall back to the scheduled durable retry processor.
- Unrelated jobs are preserved.
- Shared, API, and worker builds pass. Four focused queue/privacy tests pass,
  including send/event/webhook/DLQ removal and storage outage recovery.

Remaining queue privacy risk: an already-active webhook request cannot be
recalled after network transmission begins. Add a tombstone gate at the start
of send/event/webhook workers to minimize that race further. Logs/traces and
backup erasure evidence remain incomplete.

# 49. Remediation Execution Log — Worker Privacy Tombstone Gates

Date: 2026-07-11

- Added a shared tenant/message tombstone lookup for stale-job rejection.
- Send workers check the privacy barrier before the atomic message claim,
  transport preparation, body loading, or SMTP delivery.
- Event workers check it before event persistence, usage accounting, status
  changes, suppression changes, ClickHouse writes, or webhook fanout.
- Webhook workers extract the message ID from the structured payload and check
  the barrier before endpoint lookup, SSRF resolution, signing, logging, or
  network transmission.
- Erased jobs complete as intentionally skipped rather than retrying or entering
  the DLQ again.
- Shared and worker builds pass. Seven focused tests pass, including behavioral
  proof that tombstoned send/event/webhook jobs cause no transport, database
  event, usage, webhook log, or network side effect.

The unavoidable residual race is a webhook or SMTP request that crossed the
network boundary immediately before the erasure transaction committed; no
system can recall already transmitted data. Logs/traces and backup erasure
evidence remain the next privacy/compliance gaps.

# 50. Remediation Execution Log — Central Log And Trace Redaction

Date: 2026-07-11

- Added one shared privacy logger configuration used by API, worker, and
  tracker runtimes.
- Authorization/cookie headers, request bodies, passwords, tokens, API keys,
  secrets, recipient/from addresses, email bodies, webhook/event payloads,
  metadata, SMTP/provider responses, and webhook URLs are censored by default.
- Opaque message/customer IDs remain available for operational correlation.
- Added a dedicated error serializer so exception messages and stacks cannot
  bypass structured-field redaction.
- Added telemetry text sanitization for email addresses, bearer credentials,
  platform API-key shapes, and secret-bearing URL query parameters.
- OpenTelemetry exception recording now exports sanitized errors rather than
  the original exception text/stack.
- Shared, API, worker, and tracker builds pass. Six focused logging/tracing
  tests pass with seeded credentials, recipient PII, bodies, payloads, URLs,
  and exception data.

Remaining observability privacy work: deploy and validate collector-side
attribute allowlists, define log/trace retention and access controls, test the
real production log sink, and produce deletion/expiration evidence for backup
and immutable archival systems.

# 51. Remediation Execution Log — Retention-Safe Audit Chain Archive

Date: 2026-07-11

- Added migration `047_audit_archive.sql` for complete canonical audit rows and
  their chain links before hot-table deletion.
- Audit retention now materializes candidates, archives them, and deletes them
  atomically; an archive failure rolls back the deletion.
- Archived rows preserve actor, action, resource, IP, metadata, timestamp,
  sequence, previous hash, and row hash.
- Chain verification now walks archived and hot links as one continuous chain.
- New audit writes select their predecessor from both archive and hot storage,
  so sequence/hash continuity survives complete hot-chain archival.
- Unhashed legacy/direct audit rows are archived too, without falsely treating
  them as verified chain links.
- Migration 047 applied successfully. Shared build passes, and all 20 focused
  audit-chain/retention tests pass, including archive verification and a new
  append continuing at sequence 4 after links 1–3 were archived.

This closes the local retention-breaks-chain defect. Enterprise 10/10 still
requires exporting archive records and signed chain roots to an independently
controlled WORM sink such as S3 Object Lock or a governed SIEM, with delivery
acknowledgement, reconciliation, retention-lock proof, and restore verification.

# 52. Remediation Execution Log — Governed Billing Plan Catalog

Date: 2026-07-11

- Added migration `048_billing_plan_catalog.sql` with governed plan definitions
  and provider/environment-specific price mappings.
- Plans now carry authoritative tier, daily quota, monthly quota, features, and
  active state; price mappings carry provider, test/live environment, currency,
  provider price ID, and active state.
- Checkout validates the selected price against the customer's configured
  provider and the active database catalog before provisioning a provider
  customer or starting external billing I/O.
- Subscription webhook application resolves quotas and tier from the same
  catalog inside the billing transaction.
- Production mode fails closed for placeholder internal prices, missing
  mappings, inactive mappings, and inactive plans.
- Legacy internal keys remain available only outside production for local/test
  compatibility.
- Migration 048 applied successfully. Shared/API builds pass, and all 23
  focused catalog, price-resolution, outbound, and multi-provider tests pass.

Remaining billing work: central feature entitlement enforcement, proration and
downgrade previews, failed-payment/dunning state machine, provider invoice and
line-item ingestion, refunds/credits, tax profiles/calculation, finance exports,
and sandbox/live release evidence for every enabled provider.

# 53. Remediation Execution Log — Billing Access And Dunning Baseline

Date: 2026-07-11

- Added migration `049_billing_dunning.sql` with per-customer healthy, grace,
  restricted, recovered, and canceled states, failure counts, failure time,
  grace deadline, and recovery time.
- Catalog plans now carry baseline feature entitlements and retention/team-seat
  limits.
- Added one central billing-access evaluator returning send permission, denial
  reason, grace deadline, plan, and feature map.
- Added a shared feature-entitlement check that fails closed whenever billing
  access is restricted.
- Single and batch send acceptance now use the same evaluator rather than only
  checking `billing_status=canceled`.
- `past_due` receives a bounded, non-extending grace deadline; expired grace,
  unpaid/incomplete, restricted, and canceled states are blocked.
- Active/trialing subscription recovery clears the grace deadline and records
  recovery; cancellation creates a terminal dunning state.
- Migration 049 applied successfully. Shared/API builds pass and all 11 focused
  entitlement, catalog, multi-provider, and billing tests pass.

Remaining dunning work: ingest provider invoice/payment-failed events directly,
send staged customer notifications, schedule grace-expiry transitions and
operator alerts, enforce every catalog feature at its consuming route, and add
proration/downgrade previews. Invoice line items, refunds, credits, tax, finance
exports, and live provider lifecycle evidence remain incomplete.

# 54. Remediation Execution Log — Stripe Invoice And Payment Lifecycle

Date: 2026-07-11

- Added migration `050_invoice_lifecycle.sql` with hosted invoice/PDF URLs,
  due/paid timestamps, invoice update timestamps, and normalized invoice line
  items.
- Added parsing for Stripe invoice created, finalized, payment-failed, paid,
  voided, and marked-uncollectible events.
- Invoice processing uses the billing-event replay ledger and applies the event,
  invoice upsert, line-item upserts, customer billing status, and dunning state
  in one transaction.
- Duplicate provider events return idempotently without incrementing failure
  counts or duplicating invoice lines.
- Payment failure activates the bounded grace state; payment recovery marks the
  invoice paid, restores customer access, clears grace, and records recovery.
- Marked-uncollectible invoices immediately restrict access.
- Migration 050 applied successfully. Shared/API builds pass and all 11 focused
  invoice, entitlement, and multi-provider tests pass.

Remaining billing lifecycle work: signed end-to-end Stripe sandbox evidence,
PayPal/Cashfree payment/invoice normalization, staged dunning notifications and
grace-expiry alerts, customer invoice list/detail endpoints, proration and plan
changes, refunds/credits, tax calculation/IDs, and finance reconciliation/export.

# 55. Remediation Execution Log — Automated Dunning Notifications

Date: 2026-07-11

- Added migration `051_dunning_notifications.sql` with durable notification
  stage, billing-cycle key, pending/sent/failed state, attempts, error, and sent
  timestamps.
- Added platform-email templates for payment failure, grace ending soon,
  restriction, and recovery.
- Added an hourly cross-replica-locked scheduler sweep.
- Grace customers receive one payment-failed notification per billing cycle and
  a second warning during the final 24 hours.
- At the original deadline, the sweep atomically changes grace to restricted
  and sends the restriction notice; repeated sweeps do not resend successful
  stages.
- Failed mail delivery remains retryable and records attempts/errors rather
  than being silently treated as notified.
- The sweep supports targeted customer repair while production scans every
  outstanding grace/restricted account.
- Migration 051 applied successfully. Shared/worker builds pass and all 6
  focused dunning, invoice, and entitlement tests pass.

Remaining dunning operations: recovery notification invocation on paid events,
operator/PagerDuty alerting for notification failure or abnormal restriction
volume, plan-specific grace policies, customer-visible dunning timeline, and
credentialed provider sandbox evidence.

# 56. Remediation Execution Log — Recovery Notice And Customer Invoice API

Date: 2026-07-11

- The dunning sweep now processes recovered accounts and sends exactly one
  recovery/restored-access notification per recovery cycle.
- Added tenant-scoped invoice summary pagination under
  `GET /v1/account/billing/invoices`.
- Added invoice detail with normalized line items under
  `GET /v1/account/billing/invoices/:id`.
- Both routes require `billing:manage`; invoice detail filters by active tenant
  and returns 404 for a valid invoice UUID belonging to another organization.
- Added validation for pagination cursor/limit and invoice UUID.
- Added both operations to the published OpenAPI contract.
- Shared, API, and worker builds pass. Thirteen focused dunning/invoice/API tests
  and twenty-two OpenAPI/parity/breaking-change tests pass.

Remaining billing UX: expose the dunning notification timeline and payment
method state, add invoice download proxy/authorization policy, implement plan
change/proration preview, normalize PayPal/Cashfree invoices, and add refunds,
credits, tax profiles, and finance exports.

# 57. Remediation Execution Log — Governed Plan-Change Preview

Date: 2026-07-11

- Added migration `052_plan_change_requests.sql` with current/target plan,
  provider price, direction, request status, quota/feature deltas, warnings,
  expiry, and audit timestamps.
- Added `POST /v1/account/billing/plan-change/preview`, gated by
  `billing:manage` and the provider-specific active catalog.
- Preview calculates upgrade/downgrade/lateral direction, exact daily/monthly
  quota differences, gained/lost boolean features, and current-month usage.
- Dangerous downgrades warn when current usage exceeds the target quota or
  enabled features would be removed.
- Preview requests expire after 30 minutes and are audit-recorded.
- The endpoint deliberately does not mutate subscription/customer state and
  explicitly reports `provider_preview_required` for proration instead of
  fabricating a financial amount.
- Added the operation to OpenAPI. Migration 052 applied; shared/API builds pass;
  all 34 focused billing/OpenAPI/parity/compatibility tests pass.

Remaining plan-change work: add provider capability methods for native
proration preview and subscription update, require explicit confirmation of a
non-expired request, apply entitlement changes only from verified provider
webhooks, handle downgrade timing at period end, and provide cancellation and
rollback workflows.

# 58. Remediation Execution Log — Stripe-Native Proration And Confirmation

Date: 2026-07-12

- Verified the current Stripe create-preview and subscription-update contracts
  against official Stripe API documentation.
- Added migration `053_subscription_plan_item.sql` to persist the base plan item
  separately from the metered usage item and to retain preview amount,
  proration amount/currency, and the exact proration timestamp.
- Stripe previews now call `/v1/invoices/create_preview` with the existing
  subscription/item, target catalog price, `create_prorations`, and a fixed
  `proration_date`.
- Added explicit confirmation at
  `POST /v1/account/billing/plan-change/:id/confirm`.
- Confirmation rejects missing, expired, unpreviewed, unsupported, or incomplete
  subscription requests and reuses the preview's exact proration timestamp.
- Stripe updates use `payment_behavior=pending_if_incomplete`,
  `proration_behavior=create_prorations`, and an idempotency key derived from
  the durable request ID.
- Confirmation changes only the request to submitted/pending-provider state;
  internal tier, quota, and entitlements remain unchanged until a verified
  provider webhook confirms the new subscription price.
- Added provider capability methods and deterministic mock coverage.
- Added the confirmation operation to OpenAPI. Migration 053 applied; shared/API
  builds pass; all 35 focused billing/OpenAPI/parity/compatibility tests pass.

Remaining plan-change work: mark requests applied from the matching verified
webhook, enforce period-end scheduling for downgrades, expire stale previews,
add cancellation/rollback operations, and certify the flow with Stripe Test
Clocks plus failed-payment/SCA scenarios. PayPal and Cashfree still require
provider-specific change semantics or an explicit unsupported policy.

# 59. Remediation Execution Log — Plan-Change Lifecycle Completion

Date: 2026-07-12

- Added migration `054_plan_change_lifecycle.sql` with applied/canceled
  timestamps and an expiry index for unsubmitted previews.
- Verified active/trialing subscription webhooks now correlate submitted
  requests by tenant, provider, and provider price and mark them applied only
  after the subscription state and entitlements are transactionally updated.
- Provider update responses alone still cannot activate tier/quota changes.
- Added tenant-scoped cancellation for previewed requests; submitted, applied,
  expired, or already canceled requests return conflict and are not mutated.
- Added an hourly cross-replica-locked expiry job for stale previews; submitted
  requests are never expired by that sweep.
- Added `DELETE /v1/account/billing/plan-change/:id` and documented it in
  OpenAPI.
- Migration 054 applied successfully. Shared/API/worker builds pass; all 35
  focused lifecycle, billing, OpenAPI, parity, and compatibility tests pass.

Remaining plan-change gaps: Stripe period-end downgrade scheduling and rollback,
Test Clock/SCA/payment-failure evidence, reconciliation for a submitted request
whose webhook never arrives, and explicit unsupported/provider-specific flows
for PayPal and Cashfree.

# 60. Remediation Execution Log — Missing-Webhook Plan Reconciliation

Date: 2026-07-12

- Extended the provider capability contract with authenticated subscription
  retrieval.
- Stripe retrieval reads the current subscription status and item/price IDs;
  the mock provider models the same state deterministically for tests.
- Added a bounded five-minute reconciliation job for submitted plan changes
  older than the webhook-wait threshold.
- Reconciliation applies a request only when the provider subscription contains
  the exact requested provider price; it then reuses the transactional
  subscription-state path to update tier, quotas, dunning, and request status.
- Missing prices remain pending, unsupported providers are counted explicitly,
  and provider/network failures remain retryable and observable.
- Synthetic reconciliation event IDs are deterministic, preserving billing
  event idempotency across repeated scheduler runs.
- Shared/API/worker builds pass; all 16 focused provider, plan lifecycle, and
  catalog tests pass, including missing-webhook recovery to applied/paid tier.

Remaining work: add an operator alert/SLA for long-lived pending or unsupported
requests, provider retrieval for PayPal/Cashfree or explicitly disable plan
changes there, implement Stripe period-end downgrade scheduling/rollback, and
prove the workflow with Test Clocks, SCA, network failure, and webhook delay.

# 61. Remediation Execution Log — Full-Suite Certification Baseline

Date: 2026-07-11

Re-established a clean, trustworthy build/test/audit baseline from a fresh
clone before continuing the 7.4→10 remediation programme. The prior full-suite
run surfaced exactly one regression: the recent governed plan-change route
(`packages/api/src/routes/account-billing.ts`) began returning two
machine-readable error codes — `unknown_price` (422) and `not_cancelable`
(409) — that were never added to the stable error-code registry, so the
`error-registry` completeness guard failed.

## Changes made

- Registered `unknown_price` (422) and `not_cancelable` (409) in
  `packages/shared/src/error-codes.ts` with descriptions and HTTP statuses,
  restoring the emitted-vs-registered contract. Both are additive (new codes),
  so the backward-compatibility baseline is unaffected.

## Verification

| Check | Result |
| --- | ---: |
| Build (shared, api, worker, tracker, sdk) | passed |
| `error-registry` guard (previously failing) | 3/3 passed |
| Full test suite | 106 files / 685 tests passed, exit 0 |
| Production dependency audit (`npm audit --omit=dev`) | 0 vulnerabilities |

The suite runs green in ~131s against dockerized Postgres/Redis/Mailpit test
infrastructure with clean process shutdown (no open-handle timeout).

Remaining work (forward plan): billing completeness — Stripe period-end
downgrade scheduling and rollback, refunds/credit notes, invoice tax fields,
and an operator SLA alert for stuck plan-change/dunning requests; a durable
analytics outbox; and the operational-evidence items (Helm render, k6 soak,
Redis/Postgres failover and restore drills, Haraka TLS/PTR/HELO) that require a
live environment rather than the code sandbox.

# 62. Remediation Execution Log — Operator SLA Alert For Stuck Plan Changes

Date: 2026-07-11

Closed the §60 remaining-work item "add an operator alert/SLA for long-lived
pending or unsupported requests." A plan-change request submitted to the
provider (`status='checkout_started'`) is normally applied by a webhook or by
`reconcileSubmittedPlanChanges()`. If the provider never reflects the requested
price, or the provider is unsupported for authenticated retrieval, the request
could linger indefinitely with no operator signal. It is now observed and
alertable.

## Changes made

- `packages/shared/src/billing.ts`: added `countStuckPlanChanges(slaMinutes=60)`
  — counts `checkout_started` requests whose `updated_at` is older than the SLA
  window.
- `packages/shared/src/metrics.ts`: added gauge `mp_billing_stuck_requests`
  (label `kind`) for the breach count.
- `packages/worker/src/scheduler.ts`: added a 5-minute `billing_plan_change_sla`
  job that publishes the gauge and logs an error on any breach. The window is
  configurable via `BILLING_PLAN_CHANGE_SLA_MINUTES` (default 60).
- `infra/prometheus/alerts.yml`: added the `BillingPlanChangeStuck` warning
  alert (fires when the gauge > 0 for 15m) with operator remediation guidance.

## Verification

| Check | Result |
| --- | ---: |
| Build (shared, worker) | passed |
| New `billing-plan-change-sla` test | 2/2 passed |
| Full billing test group | 11 files / 50 tests passed |
| `alerts.yml` YAML parse | valid (3 groups, 16 rules) |

# 63. Remediation Execution Log — Period-End Downgrade Scheduling And Rollback

Date: 2026-07-11

Closed the §60 remaining-work item "implement Stripe period-end downgrade
scheduling/rollback." Previously every confirmed plan change — including
downgrades — applied immediately with provider proration, which credited unused
time and dropped the customer's capacity mid-period. Downgrades now defer to the
period boundary and stay reversible until then.

## Behaviour

- **Upgrades / lateral moves**: unchanged — applied immediately with provider
  proration (`pending_provider_confirmation`).
- **Downgrades**: `confirmPlanChange` records the request as `scheduled` with
  `scheduled_effective_at` = the subscription's `current_period_end` (falling
  back to `now + BILLING_DEFAULT_PERIOD_DAYS`, default 30). No provider mutation
  occurs and the customer keeps their paid capacity until the boundary. The
  route returns `202 { status: 'scheduled', effective_at }`.
- **Rollback**: `cancelPlanChange` (DELETE) now cancels both unsubmitted
  previews and `scheduled` downgrades, so a customer can reverse a pending
  downgrade any time before it applies.
- **Apply**: a new `applyScheduledDowngrades()` job submits each due request to
  the provider (no proration — the full period was used) and finalizes it
  through the provider-authoritative `applySubscriptionState` path, which lowers
  tier/quota and marks the request `applied`. Wired into the worker scheduler as
  `billing_scheduled_downgrade_apply` (every 10 minutes).
- `BILLING_DOWNGRADE_AT_PERIOD_END=0` restores legacy immediate proration.

## Changes made

- `infra/migrations/055_scheduled_downgrades.sql`: added the `scheduled` status
  to the plan-change CHECK constraint, a `scheduled_effective_at` column, and a
  partial index driving the apply job.
- `packages/shared/src/schema.ts`: extended the status union and added the
  column type.
- `packages/shared/src/billing.ts`: downgrade branch in `confirmPlanChange`,
  rollback in `cancelPlanChange`, and the new `applyScheduledDowngrades()`.
- `packages/api/src/routes/account-billing.ts`: `scheduled` is a 202 success
  with a distinct audit event.
- `packages/worker/src/scheduler.ts`: `billing_scheduled_downgrade_apply` job.
- `packages/shared/src/openapi.ts`: documented the scheduled/rollback semantics
  (descriptions only — non-breaking).

## Verification

| Check | Result |
| --- | ---: |
| Build (all five workspaces) | passed |
| New downgrade e2e tests (schedule / rollback / apply) | 3/3 passed |
| Full billing-outbound suite | 16/16 passed |
| Migrations (fresh apply of 055) | passed |
| OpenAPI parity + breaking-change guards | 22/22 passed |
| Full test suite | 107 files / 690 tests passed, exit 0 |

Remaining billing work: refunds/credit notes, invoice tax fields, PayPal/
Cashfree plan-change lifecycle parity, and Stripe Test Clock/SCA certification.

# 64. Remediation Execution Log — Invoice Tax Fields

Date: 2026-07-11

Invoices previously stored only a single `amount_cents` with no record of the
tax the provider assessed, so customer-facing invoices and finance exports could
not show VAT/GST/sales tax separately. We now persist the provider-calculated
tax (Stripe Tax or externally computed) rather than computing it ourselves.

## Changes made

- `infra/migrations/056_invoice_tax.sql`: `invoices.tax_cents` (default 0).
- `packages/shared/src/schema.ts`: `tax_cents` on `InvoicesTable`.
- `packages/shared/src/billing.ts`: `InvoiceEvent.tax_cents`; `applyInvoiceEvent`
  persists it on insert and update; `listCustomerInvoices` selects it (detail
  uses `selectAll`, so it is already returned).
- `packages/api/src/routes/billing.ts`: `stripeInvoiceEvent` reads Stripe's
  aggregate `tax`, falling back to summing `total_tax_amounts[].amount`.

## Verification

| Check | Result |
| --- | ---: |
| Build (shared, api) | passed |
| Invoice lifecycle tests (incl. tax parse/sum/persist) | 4/4 passed |

# 65. Remediation Execution Log — Refunds And Credit Notes

Date: 2026-07-11

Closed the billing gap "refunds and credit notes." Providers issue a credit note
when money is refunded or written off against an invoice (Stripe `credit_note`).
We now record provider-issued credit notes idempotently and expose them to the
customer, rather than initiating refunds ourselves — so billing history and
finance exports reflect exactly what the provider issued.

## Changes made

- `infra/migrations/057_credit_notes.sql`: `credit_notes` table (customer- and
  invoice-linked, unique on `provider_credit_note_id`, `issued`/`void` status).
- `packages/shared/src/schema.ts`: `CreditNotesTable` + registration.
- `packages/shared/src/billing.ts`: `CreditNoteEvent`, idempotent
  `applyCreditNoteEvent` (links to the local invoice, upserts on replay, voids on
  `credit_note.voided`), and `listCustomerCreditNotes`.
- `packages/api/src/routes/billing.ts`: `stripeCreditNoteEvent` parser wired into
  the Stripe webhook after the invoice-event branch.
- `packages/api/src/routes/account-billing.ts`: `GET /account/billing/credit-notes`
  (billing:manage, tenant-scoped).
- `packages/shared/src/openapi.ts`: documented the new route (`listAccountCreditNotes`).

## Verification

| Check | Result |
| --- | ---: |
| Build (all five workspaces) | passed |
| Credit-note unit tests (parse / apply+link / idempotent / void) | passed |
| Credit-note tenant-scoped list e2e | passed |
| OpenAPI parity + breaking-change guards | 22/22 passed |
| Full test suite | 107 files / 696 tests passed, exit 0 |

Phase 2 (billing completeness) is now done at code level: operator SLA alerts,
period-end downgrades, invoice tax, and refunds/credit notes. Remaining billing
items are provider-lifecycle parity (PayPal/Cashfree plan changes) and Stripe
Test Clock/SCA certification, both of which need live provider sandboxes.

# 66. Remediation Execution Log — ClickHouse Analytics Deduplication

Date: 2026-07-11

Closed the analytics-durability gaps "durable analytics outbox" and "strong
ClickHouse deduplication engine/key proof" at code/schema level. The durable
outbox already existed (Postgres `events` + watermark reconciler), but every
event was written to ClickHouse twice — once by the best-effort hot path and
once by the reconciler — into a plain `MergeTree` whose sorting key did not
identify an event, and a `SummingMergeTree count()` rollup. Result: duplicate
analytics rows and double-counted daily totals.

## The fix — dedup on a shared idempotency key

- Both writers now emit `event_id` = the Postgres `events.id` (globally unique,
  monotonic). The hot path reads it from the freshly-inserted event row; the
  reconciler reads it from the `events` scan — so a given event carries the same
  key on both inserts.
- `mail.events` is now a **ReplacingMergeTree** with `ORDER BY (customer_id,
  occurred_at, message_id, event_type, event_id)` — the two inserts of one event
  collapse to a single row on merge.
- `mail.events_daily` is now an **AggregatingMergeTree** over
  `uniqExact(event_id)`, counting DISTINCT events so a duplicate insert never
  inflates the count (the old `count()` rollup double-counted). Query with
  `uniqExactMerge(event_uniq)`.

## Changes made

- `infra/clickhouse/init.sql`: `event_id` column, ReplacingMergeTree base keyed
  on event_id, uniqExact daily rollup + MV.
- `packages/shared/src/clickhouse.ts`: `event_id` on `ClickhouseEvent`/`Row`,
  emitted by the hot-path buffer.
- `packages/shared/src/clickhouse-reconcile.ts`: ships `event_id = events.id`.
- `packages/worker/src/event-worker.ts`: hot-path dual-write passes
  `event_id: inserted.id`.
- `docs/CLICKHOUSE_DURABILITY.md`: documented the dedup design and the pending
  live-infra drill.

## Verification

| Check | Result |
| --- | ---: |
| Build (all five workspaces) | passed |
| `clickhouse-reconcile` (incl. stable event_id shipped) | 7/7 passed |
| `clickhouse-schema` guard (engine / dedup key / uniqExact) | 3/3 passed |
| Full test suite | 108 files / 700 tests passed, exit 0 |

Pending (live-infra evidence): insert the same event via both paths against a
real ClickHouse, force a merge, and assert one stored row and one counted event
— tracked with the Phase 4 operational drills (backup/restore, failover).

# 67. Remediation Execution Log — Operational Drills And Load Tooling

Date: 2026-07-11

Built the tooling side of the "HA/DR and failure evidence" and "operational
certification" gaps so the evidence is reproducible on demand, and produced the
evidence that is achievable in a code sandbox.

## Changes made

- `scripts/helm-render-check.sh` (new): lints the chart, renders it with default
  AND production-like overlays, and parses every document to confirm valid
  Kubernetes YAML with the required workload kinds. **Executed: PASSED** — helm
  3.16 installed, chart lints (0 failures), 27 valid manifests per overlay. This
  closes the long-standing "Helm rendering not executed (Helm unavailable)"
  certification item.
- `scripts/redis-failover-drill.sh` (new): primary + AOF replica, kills the
  primary, promotes the replica, and asserts durability (marker + queued jobs
  survive) and availability (promoted node accepts writes). **Executed: PASSED.**
- `scripts/backup-restore-drill.sh`: added a measured restore time (RTO proxy)
  to the existing dump/restore integrity drill.
- `infra/loadtest/tracker.js` (new): k6 open/click throughput scenario with
  latency/answer-rate SLO thresholds, complementing the existing `send.js`.
- `docs/OPERATIONAL_DRILLS.md` (new): operator runbook indexing every drill,
  what it proves, and what still requires live infrastructure.

## Verification

| Check | Result |
| --- | ---: |
| `helm lint` + render (default + production overlays) | PASSED — 27 valid manifests each |
| `redis-failover-drill.sh` (durability + availability) | PASSED (executed) |
| Shell scripts `bash -n` | all valid |
| k6 scenarios syntax (`node --check`, ESM) | valid |
| `migration-topology` infra test | 10/10 passed |

Remaining Phase 4 items require live infrastructure rather than code: k6 soak
against staging with a capacity report; automatic Redis/Postgres failover with
measured RPO/RTO on production-sized data; the live-ClickHouse dedup drill; real
Haraka TLS/PTR/HELO; and worker chaos (crash/partition/SMTP-outage) injection.
These are enumerated in `docs/OPERATIONAL_DRILLS.md`.

# 68. Remediation Execution Log — Customer SSO Enforcement

Date: 2026-07-11

Began Phase 5 (enterprise identity) with the "complete customer SSO enforcement"
item. The platform already had SCIM provisioning and an admin-plane
password-login-disabled posture, but a customer organization had no way to
mandate SSO for its own members — a password login always worked. Now an org can
enforce SSO, and password authentication is refused for its members.

## Behaviour

- `customers.sso_enforced` (per-tenant flag). When set, any member of that org is
  blocked from password login with `password_login_disabled` (403) — checked
  only AFTER the password is verified, so it cannot be used to probe which
  accounts exist or are SSO-enforced.
- The check fails strict (`isSsoEnforcedForUser`): if ANY of the user's active
  orgs enforces SSO, password login is refused, so an enterprise mandate can't be
  bypassed via a second, non-enforcing org. SSO login does not use the password
  path and is unaffected.
- Owners/admins toggle the policy from the dashboard; an existing session can
  disable it (not password-gated), so enabling it can never hard-lock the org.

## Changes made

- `infra/migrations/058_sso_enforcement.sql`: `customers.sso_enforced` (default
  false).
- `packages/shared/src/schema.ts`: `sso_enforced` on `CustomersTable`.
- `packages/shared/src/sso.ts` (new): `isSsoEnforcedForUser`,
  `getOrgSsoEnforcement`, `setOrgSsoEnforcement`; exported from the index.
- `packages/api/src/routes/account.ts`: login gate after `authenticate`, plus
  `GET`/`PATCH /account/settings/sso` (settings:manage) with audit events.
- `packages/tests/openapi-route-parity.test.ts`: allowlisted the two dashboard
  routes with rationale.

## Verification

| Check | Result |
| --- | ---: |
| Build (all five workspaces) | passed |
| SSO enforcement e2e (enable→block→disable→restore, validation, auth) | 2/2 passed |
| OpenAPI route-parity ratchet | passed |
| Full test suite | 109 files / 702 tests passed, exit 0 |

Remaining enterprise items need real IdPs / external auditors: SCIM
interoperability certification, phishing-resistant MFA / passkeys (WebAuthn),
JIT administration + break-glass approvals, an external WORM audit sink with
signed roots, data-residency enforcement, and an external penetration test / SOC 2.

# 69. Remediation Execution Log — Signed Audit Checkpoints And WORM Sink

Date: 2026-07-11

Continued Phase 5 with the "external WORM audit sink with signed roots" item.
The audit hash chain already detects in-place edits, but an attacker with full
DB write access could rewrite `audit_log` AND `audit_log_hashes` together and
recompute a self-consistent chain — undetectable from inside the database.
Signed checkpoints exported to an append-only sink close that gap.

## Design

- **Signed roots (Ed25519).** `signAuditCheckpoint(chainKey)` reads the current
  chain head (highest seq + row_hash across hot + archive), signs the canonical
  `(chain_key, seq, row_hash, checkpoint_at)` with an Ed25519 key, stores it in
  `audit_checkpoints`, and exports it to the WORM sink. External verifiers need
  only the published public key.
- **WORM sink seam.** `WormAuditSink` with `NullWormSink` (default) and
  `FilesystemWormSink` (append-only JSONL when `AUDIT_WORM_DIR` is set);
  production injects an S3-Object-Lock/immutable sink. Injectable like the other
  seams (`setWormAuditSink`).
- **Verification.** `verifyAuditCheckpoint` checks (1) the signature is
  authentic and (2) the live chain at that seq still carries the signed
  row_hash. A silent rewrite passes (1) but FAILS (2) — the tamper is caught by
  the externally-held root.
- **Key management.** `AUDIT_SIGNING_KEY_PEM` (PKCS#8) in production (required,
  or it throws); an ephemeral dev key with a warning otherwise. Public key
  exposed via `auditSigningPublicKeyPem()`.
- Hourly `audit_checkpoint` scheduler job signs every chain
  (`checkpointAllAuditChains`).

## Changes made

- `infra/migrations/059_audit_checkpoints.sql`; `schema.ts`
  `AuditCheckpointsTable`.
- `packages/shared/src/audit-worm.ts` (new); exported from the index.
- `packages/worker/src/scheduler.ts`: hourly `audit_checkpoint` job.

## Verification

| Check | Result |
| --- | ---: |
| Build (all five workspaces) | passed |
| WORM tests (sign+verify, rewrite detection, wrong key, checkpoint-all) | 4/4 passed |
| Full test suite | 110 files / 706 tests passed, exit 0 |

The tamper-detection test proves the core property: after a self-consistent
rewrite of the head link, the signature stays valid but `matchesChain` is false
(`row_hash_diverged`). Pending live-infra evidence: an actual immutable object
store (S3 Object Lock) as the production sink and periodic external verification.

# 70. Remediation Execution Log — JIT Admin Elevation And Break-Glass

Date: 2026-07-11

Continued Phase 5 with the "JIT administration and break-glass approvals" item.
Admins previously carried a fixed standing role with no way to run least-
privilege day-to-day and elevate only when needed. Now elevation is just-in-time,
time-boxed, reason-bound, and audited, with a flagged emergency path.

## Design

- **Effective role = max(standing, active elevation).** `resolveAdminSession`
  now computes this, so every existing `requireAdmin`/`roleAtLeast` guard honours
  an elevation automatically. `AdminContext` gains `standing_role` and `elevated`
  for transparency.
- **Normal JIT grant** (`grantElevation`, breakGlass=false): four-eyes — the
  grantor cannot elevate themselves and cannot grant above their own STANDING
  role (checked from admin_users, so an already-elevated session can't launder
  further privilege).
- **Break-glass** (breakGlass=true): self-service emergency elevation, allowed to
  exceed the actor's own role but gated by a standing floor (operator+), a
  shorter TTL cap, and a mandatory reason; the row is flagged `break_glass`.
- TTL caps (`ADMIN_ELEVATION_MAX_MINUTES` / `ADMIN_BREAK_GLASS_MAX_MINUTES`),
  `activeElevatedRole` filters on `expires_at` so a lapsed elevation stops
  counting even before the sweep, `revokeElevation` for early cutoff, and an
  `admin_elevation_expiry` scheduler job. Every grant/revoke is audited (and now
  covered by the signed audit checkpoints from §69).

## Changes made

- `infra/migrations/060_admin_elevations.sql`; `schema.ts`
  `AdminElevationsTable`.
- `packages/shared/src/admin-jit.ts` (new): grant/revoke/expire/active/list.
- `packages/shared/src/admin.ts`: effective-role computation in
  `resolveAdminSession`; `AdminContext` extended.
- `packages/api/src/routes/admin.ts`: `GET/POST /admin/elevations`,
  `POST /admin/elevations/break-glass`, `DELETE /admin/elevations/:id`.
- `packages/worker/src/scheduler.ts`: `admin_elevation_expiry` job.

## Verification

| Check | Result |
| --- | ---: |
| Build (all five workspaces) | passed |
| JIT elevation tests (four-eyes, ceiling, effective-role, break-glass floor, TTL, expiry, revoke) | 6/6 passed |
| Full test suite (admin plane regression) | 111 files / 712 tests passed, exit 0 |

Remaining enterprise items need real external parties: SCIM interoperability
certification with real IdPs, phishing-resistant MFA / passkeys (WebAuthn),
external penetration test, and SOC 2 evidence.

# 71. Remediation Execution Log — WebAuthn / Passkey Groundwork

Date: 2026-07-11

Completed the codeable part of the "phishing-resistant MFA / passkeys" item with
a self-contained WebAuthn implementation (no new dependencies, matching how the
platform builds its own TOTP/Ed25519 crypto).

## What was built

- **Minimal CBOR decoder** for the types WebAuthn uses (ints, byte/text strings,
  arrays, maps) — enough for `attestationObject` and COSE keys.
- **COSE → key**: EC2/ES256 (P-256) and OKP/Ed25519 public keys converted to
  SPKI and loaded as Node key objects.
- **authenticatorData parsing** (rpIdHash, flags, sign count, attested credential
  data).
- **clientDataJSON validation**: type + origin binding, with the challenge
  returned for single-use consumption.
- **Assertion verification**: `authenticatorData || SHA-256(clientDataJSON)`
  checked against the stored public key (ES256/EdDSA), plus **signature-counter
  clone detection**.
- **Single-use challenge lifecycle** (issue/consume, TTL, replay-proof).
- **Ceremonies**: `registerPasskey` (verifies clientData + rpIdHash, consumes the
  challenge, stores the COSE public key) and `authenticatePasskey` (verifies the
  assertion, advances/guards the counter). Plus `listPasskeys` / `deletePasskey`.
- **Dashboard routes**: `POST /account/webauthn/register/options`,
  `POST /account/webauthn/register`, `GET /account/webauthn/credentials`,
  `DELETE /account/webauthn/credentials/:id` (session-auth gated).

## Scope note

We accept `none` attestation (the common passkey case) and do not validate
attestation certificate chains (packed/tpm/android-key) — a deployment-specific
trust decision left as follow-up, along with wiring passkeys as a login/step-up
factor. The cryptographic core (challenge/origin binding, assertion
verification, clone detection) is complete and tested.

## Changes made

- `infra/migrations/061_webauthn.sql`; `schema.ts` credential + challenge tables.
- `packages/shared/src/webauthn.ts` (new); exported from the index.
- `packages/api/src/routes/account.ts`: passkey routes.
- `packages/tests/openapi-route-parity.test.ts`: allowlisted the dashboard routes.

## Verification

| Check | Result |
| --- | ---: |
| Build (all five workspaces) | passed |
| WebAuthn tests (CBOR, register, real assertion, clone detection, tamper/origin, single-use, owner-scoped delete) | 7/7 passed |
| Route-parity ratchet | passed |
| Full test suite | 112 files / 719 tests passed, exit 0 |

The register + authenticate tests drive a synthetic P-256 authenticator built
in-test (CBOR attestationObject + COSE key + real ECDSA signatures), so the full
ceremony — not just the helpers — is exercised.
