# Mail Platform Deep Module Production Audit

Date: 2026-06-25  
Scope: `packages/api`, `packages/shared`, `packages/worker`, `packages/tracker`, Haraka inbound/outbound, SDK, tests, migrations, Docker/Compose, Helm/Kubernetes, Prometheus/Grafana, docs.

## Executive Verdict

This project is a serious transactional email platform codebase, not a toy. The core send pipeline, quota handling, idempotency, webhook hardening, tracking, suppression, DKIM lifecycle, and operational scaffolding are meaningfully implemented.

It is still not a 10/10 production/SaaS/enterprise platform. The biggest blockers are active tenant RLS integration, dependency remediation, production-like load proof, real billing configuration, real deliverability operations, HA/DR validation, and independent security/compliance proof.

Overall scores:

| Area | Score |
|---|---:|
| Code implementation readiness | 8.0/10 |
| SaaS product readiness | 7.0/10 |
| Enterprise readiness | 6.5/10 |
| SendGrid/Braze-class platform parity | 5.5/10 |

## Evidence Collected

Local verification:

- `npm run build`: passed across shared, API, worker, tracker, SDK.
- `npm run prod:check`: passed only in `.env.production.example` template mode.
- `npm audit --omit=dev --audit-level=moderate --json`: 27 moderate vulnerabilities, 0 high, 0 critical.
- Full test suite after applying 33 migrations to the test DB: 510 passed, 3 skipped, 1 suite failed due to temporary RLS role cleanup.
- Isolated RLS suite after role cleanup: 3 passed.
- Repo scale: 338 relevant files under packages/infra/docs/scripts/.github, 515 route/function/schema markers found.
- Test harness issue: `.env.test` comments say the test suite loads the file automatically, but Vitest config does not load dotenv. `.env.test` also documents Postgres test port 5434 while `DATABASE_URL` points to 5432.

## Scoring Rubric

- 10: Production proven, secure by default, operationally validated, enterprise controls complete, no known unresolved launch blockers.
- 8-9: Strong implementation, good tests, only bounded configuration or proof gaps remain.
- 6-7: Usable foundation, but important SaaS/enterprise features or operational proof missing.
- 4-5: Prototype or partial implementation.
- 0-3: Unsafe or mostly absent.

## Module Score Matrix

| Module | Score | Main Reason |
|---|---:|---|
| Public API platform | 8.0 | Good Fastify structure, validation, rate limits, OpenAPI, errors; versioning and contract maturity incomplete. |
| Authentication and identity | 8.0 | Strong API keys, sessions, MFA, admin split; RLS integration gap lowers enterprise score. |
| Tenant isolation | 6.5 | App filters are mostly present and RLS policies work in tests, but API does not use `withTenant()` in production paths. |
| Send pipeline | 8.5 | Strong accept path, quotas, idempotency, abuse checks, outbox, worker pipeline. |
| Deliverability | 7.0 | Good scaffolding, but real inbox placement and postmaster/FBL operations are not proven. |
| Bounce/FBL inbound | 8.0 | DSN/FBL parsing and VERP protection implemented; live provider coverage still needs proof. |
| Tracking/unsubscribe | 8.0 | Pixel, click, bot classification, CSRF token, RFC 8058 support; public tracker needs abuse/load proof. |
| Webhooks | 8.5 | HMAC, retries, logs, SSRF guard, DNS pinning; high-volume connection pooling can improve. |
| Data model/migrations | 7.5 | Broad schema and checksum migrations; no downgrade plan, no zero-downtime migration discipline proven. |
| Storage/privacy/retention | 7.5 | Body offload, erasure, export, retention exist; object storage/lifecycle proof incomplete. |
| Billing | 6.5 | Provider seam and Stripe REST exist; price IDs placeholders, tax/dunning/invoicing/provider proof incomplete. |
| Admin/support | 7.5 | RBAC, admin auth, support workflows exist; console/product maturity and immutable audit need work. |
| Observability | 7.5 | Metrics, alerts, Grafana, tracing shim; SLOs, log aggregation, trace deployment proof missing. |
| Reliability/queues | 8.0 | BullMQ, DLQ, outbox, scheduler locks, stale recovery; HA/failover and replay tooling incomplete. |
| Security hardening | 7.5 | Good app-level controls; dependency advisories, RLS wiring, pentest, WAF/secrets process missing. |
| Infrastructure/deployment | 7.0 | Docker, Compose prod overlay, Helm, HPA, PDB, NetworkPolicy; production migration and HA gaps remain. |
| Testing/CI | 7.5 | Large suite and CI exist; local test env broken, load/security tests not enough for enterprise proof. |
| SDK/docs/devex | 7.5 | SDK and docs exist; examples and production onboarding still need polish. |

---

# 1. Public API Platform - 8.0/10

## 1.1 Fastify service composition - 8.0/10

Evidence:

- `packages/api/src/server.ts` registers public, account, admin, and API-key authenticated scopes separately.
- Health endpoints `/live`, `/health`, `/ready` exist.
- Request IDs are generated or honored from `x-request-id`.
- Security headers are applied globally.

Why not 10:

- Route registration is clear but not fully wrapped in tenant-scoped transactions.
- No explicit API version router abstraction beyond `/v1`.
- No compatibility policy enforcement tests for future API versions.

To reach 10:

- Add a versioning layer with per-version route groups, deprecation policy tests, and compatibility contract tests.
- Add tenant-scoped request context for authenticated API-key routes.
- Add per-route ownership/security metadata and automated route coverage checks.

## 1.2 Validation and error envelope - 8.0/10

Evidence:

- Zod schemas validate major route bodies.
- Send body fields are capped at 1 MB.
- Custom headers are restricted by name, count, and total size.
- Standard error envelope plugin exists.

Why not 10:

- Not every route was proven to have uniform schema coverage.
- Error taxonomy is practical but not fully documented as a stable public contract.

To reach 10:

- Require schema validation for every route via lint/test.
- Publish an error-code registry and test every documented code.
- Add generated OpenAPI diff checks in CI.

## 1.3 Rate limiting and backpressure - 8.5/10

Evidence:

- Global Redis-backed rate limit.
- Per-send endpoint limit.
- Queue-depth backpressure returns 503 with `Retry-After`.
- Per-customer queue-depth protection exists.
- Redis rate limiter fails open to avoid outage lockout.

Why not 10:

- No proven production tuning per tier, per IP, per org, and per abuse risk.
- No WAF or edge-level rate limiting shown.

To reach 10:

- Add tier-aware limits and abuse-risk dynamic throttles.
- Add edge/WAF rate limits in deployment docs/manifests.
- Add dashboards and alerts for rate-limit saturation by customer and route.

## 1.4 OpenAPI and API contract - 7.5/10

Evidence:

- `GET /openapi.json` exists.
- `openapi.test.ts` exists.
- SDK exists.

Why not 10:

- OpenAPI completeness against all routes is not guaranteed.
- No backward compatibility checks between spec versions.

To reach 10:

- Generate OpenAPI from route schemas or enforce spec-route parity.
- Add breaking-change detection in CI.
- Publish typed SDK generation tests from the spec.

---

# 2. Authentication, Identity, and Access Control - 8.0/10

## 2.1 API keys - 8.5/10

Evidence:

- API keys use high-entropy `mp_live_`, `mp_test_`, `mp_pub_` prefixes.
- Verification uses HMAC-SHA256 with pepper and constant-time comparison.
- Prefix lookup limits DB candidate set.
- `last_used_at` writes are Redis-throttled to once per 60 seconds.
- Key management and rotation tests exist.

Why not 10:

- Pepper rotation requires a customer reissue plan and is not automated.
- Publishable key scope model needs a stricter browser-client threat model.

To reach 10:

- Implement dual-pepper rotation windows.
- Add key-risk scoring, usage anomaly detection, and admin/customer key inventory exports.
- Add automated key leak detection hooks and emergency global revoke workflows.

## 2.2 Human user auth - 8.0/10

Evidence:

- Passwords use scrypt with NFKC normalization.
- User sessions use HMAC token hashes.
- Login rate limiting and lockout tests exist.
- MFA and recovery code modules exist.

Why not 10:

- Full enterprise SSO for customers is not shown, only admin OIDC is visible.
- Device/session risk signals are limited.

To reach 10:

- Add customer SAML/OIDC SSO with SCIM provisioning for enterprise tenants.
- Add session device inventory, impossible-travel detection, and forced MFA policies.
- Add tenant-level auth policies.

## 2.3 Admin auth and RBAC - 8.0/10

Evidence:

- Separate admin route plane.
- Admin OIDC path exists.
- Production guard requires `ADMIN_PASSWORD_LOGIN_DISABLED=true`.
- Admin MFA replay and brute-force fixes are tested.
- Role hierarchy and audit logging exist.

Why not 10:

- Admin OIDC depends on real IdP config.
- No evidence of just-in-time access, approval workflows, or break-glass controls.

To reach 10:

- Add JIT elevation with expiry.
- Add break-glass accounts with mandatory incident logging.
- Add admin action approval for destructive/high-risk actions.

## 2.4 Tenant isolation - 6.5/10

Evidence:

- Most app queries visibly include `customer_id` filters.
- RLS migration enables policies on core tenant tables.
- `withTenant()` correctly sets `app.customer_id` transaction-locally.
- Isolated RLS test passes after role cleanup.

Critical gap:

- `rg "withTenant(" packages` found no production usage.
- Therefore normal API request paths are not actually running inside RLS-scoped transactions.
- RLS is currently a tested mechanism, not an integrated defense-in-depth control.

Why not 10:

- A missed `WHERE customer_id` filter can still leak data if the connection role sees all rows.
- `rlsIsEnforced()` exists but is not visibly called at API startup.

To reach 10:

- Run API under a non-superuser, non-BYPASSRLS DB role.
- Wrap authenticated API-key and user-session org routes in `withTenant(customerId, trx => ...)`.
- Refactor shared service functions to accept `db | trx`.
- Make `rlsIsEnforced()` a production startup check.
- Add a route-level regression test that intentionally removes app filtering and proves RLS blocks cross-tenant rows.

---

# 3. Send Pipeline - 8.5/10

## 3.1 Send API accept path - 8.5/10

Evidence:

- Validates sender, recipients, subject, body, headers, tags, metadata, tracking, scheduling, unsubscribe groups.
- Supports up to 1000 recipients per request.
- Requires registered and verified sending domain.
- Live sends require verified account email.
- Customer status and billing gates are checked.
- New-account/KYC cap exists.

Why not 10:

- Product-level approval flows and sender onboarding are still basic.
- Enterprise policy controls per tenant, domain, and subuser are not complete.

To reach 10:

- Add sender identity policy engine.
- Add per-domain/per-IP/pool throttles and approvals.
- Add customer-configurable compliance footers and brand policies.

## 3.2 Idempotency - 8.5/10

Evidence:

- `Idempotency-Key` support exists.
- Request body hash detects key reuse with different payload.
- In-progress conflict returns 409 with `Retry-After`.
- Tests cover concurrency.

Why not 10:

- Retention window and replay semantics need public API contract clarity.
- Idempotency storage cleanup exists but operational metrics should be richer.

To reach 10:

- Publish idempotency TTL and conflict semantics.
- Add metrics by outcome: proceed, replay, conflict, in-progress.
- Add dashboard panels for idempotency hot keys.

## 3.3 Quota and metering reservation - 8.5/10

Evidence:

- Redis Lua reserves daily and monthly quota atomically.
- Durable seed from `usage_daily` prevents Redis flush from resetting quota.
- Release path clamps at zero.
- Quota threshold notification logic exists.

Why not 10:

- Redis is a critical consistency dependency; HA/cluster behavior is not proven.
- Quota reservation is based on accepted sends and later usage reconciliation, but enterprise billing needs more exact entitlement models.

To reach 10:

- Validate Redis HA failover under concurrent quota load.
- Add plan entitlements by feature, region, subuser, domain, pool, and monthly overage.
- Add formal reconciliation jobs with customer-visible usage ledger.

## 3.4 Abuse and content screening - 7.5/10

Evidence:

- Regex scan, Bayesian classifier, URL reputation blending.
- Spam trap/disposable-domain checks.
- Volume anomaly baseline.
- Review queue exists.

Why not 10:

- Bayesian/local rules are not enough for internet-scale abuse.
- No third-party threat intel feeds, URL detonation, attachment scanning, or customer risk engine proof.

To reach 10:

- Add real-time reputation feeds for domains, URLs, IPs, and customers.
- Add ML/rule feedback loop from bounces, complaints, manual review, and blocklists.
- Add attachment scanning if attachments are supported.
- Add tenant risk scores and progressive trust tiers.

## 3.5 Suppression and unsubscribe enforcement - 8.0/10

Evidence:

- Global suppressions.
- Bulk suppression import.
- Group unsubscribe support.
- Soft-bounce escalation.
- Clear-on-delivery reset.

Why not 10:

- Preference center UX and consent ledger are not visible.
- Suppression import validation can be expanded for enterprise list hygiene.

To reach 10:

- Add immutable consent events.
- Add branded preference center.
- Add suppression export/audit APIs.
- Add list import quarantine and sample validation workflow.

## 3.6 Outbox and queueing - 8.5/10

Evidence:

- Transactional send outbox exists.
- Drain uses batch limit.
- BullMQ workers process send/events/webhooks.
- Delayed/scheduled sends exist.
- Stale `sending` recovery exists.

Why not 10:

- DLQ replay tooling is present in concept but not proven as full operator workflow.
- Queue scaling and Redis failover behavior are not production-tested here.

To reach 10:

- Add admin DLQ replay with dry-run, bulk filters, and audit.
- Load test queue arrival and drain rate under worker fleet scaling.
- Add Redis failover/partition chaos tests.

## 3.7 Worker delivery path - 8.5/10

Evidence:

- Worker only sends queued messages.
- Moves message to `sending` with `sending_at`.
- Loads offloaded body.
- Rewrites links with HTML parser.
- Adds open pixel, List-Unsubscribe, signed VERP return path.
- Enforces physical postal address for live sends.
- Uses sandbox transport for test keys.

Why not 10:

- Physical address insertion is simple text/html append, not a full compliance/template policy engine.
- Transport-specific failure classification can be deeper.

To reach 10:

- Add provider-specific SMTP/SES error taxonomy.
- Add adaptive retry based on enhanced status codes.
- Add per-recipient delivery diagnostics and customer-facing event explanations.

---

# 4. Deliverability - 7.0/10

## 4.1 Sending domains and DNS verification - 8.0/10

Evidence:

- Domain routes and shared domain service exist.
- SPF, DKIM, DMARC verification fields exist.
- DMARC policy migration exists.
- DNS setup docs exist.

Why not 10:

- Real DNS propagation, multi-region DNS, branded return-path, BIMI, and automated diagnostics are not proven.

To reach 10:

- Add DNS health scanner with detailed failure remediation.
- Add branded bounce domain setup per tenant.
- Add BIMI support and monitoring.
- Add automated periodic re-verification and customer alerts.

## 4.2 DKIM and key rotation - 8.0/10

Evidence:

- Selector lifecycle: pending, active, retiring, retired.
- Private keys encrypted through KMS abstraction.
- Scheduler retires old keys.
- Haraka outbound signs per customer domain.

Why not 10:

- KMS provider config must be proven in real cloud/Vault deployments.
- No visible HSM/secrets manager rotation runbook execution proof.

To reach 10:

- Run KMS integration tests against AWS/GCP/Vault in staging.
- Add automated key compromise rotation workflow.
- Add customer-visible DKIM selector status and DNS validation timeline.

## 4.3 IP pools and warmup - 7.0/10

Evidence:

- IP pools and sending IPs schema exist.
- Per-IP warmup ramp exists.
- `recordIpSends()` counters exist.
- Warmup docs/runbook exist.

Why not 10:

- Warmup is code scaffolding, not real executed reputation history.
- No proof of dedicated IP assignment workflows, PTR validation, or ISP throttling adaptation.

To reach 10:

- Execute real IP warmup over weeks with measured inbox placement.
- Add PTR/rDNS validation and postmaster registration status.
- Add per-ISP throttling and queue routing.
- Add dedicated/shared IP pool allocation workflows.

## 4.4 Reputation guard and blocklists - 7.5/10

Evidence:

- 24h bounce/complaint rate evaluation.
- Auto throttle/pause flags in Redis.
- DNSBL checks for major lists.
- Prometheus alerts exist.

Why not 10:

- DNSBL list set is only part of real deliverability.
- No automated delisting workflow or ISP-specific escalation.

To reach 10:

- Integrate inbox placement and seed-list monitoring.
- Add automated incident creation for blocklists.
- Add provider-specific remediation playbooks and state tracking.
- Add per-ISP/domain rate shaping.

## 4.5 Google Postmaster and Microsoft SNDS - 6.5/10

Evidence:

- Google service-account JWT flow exists.
- SNDS polling exists.
- Scheduler runs ingestion when credentials exist.

Why not 10:

- Credentials are optional and not verified here.
- Mapping domain-level Google reputation to specific IPs is approximate.

To reach 10:

- Prove real credentials and API ingestion in staging.
- Store and display domain-level reputation separately from IP-level reputation.
- Add alert thresholds for spam rate, reputation class, and SNDS color changes.

---

# 5. Bounce, Complaint, and Inbound MTA - 8.0/10

## 5.1 DSN parsing - 8.0/10

Evidence:

- DSN parser handles structured status/action and fallbacks.
- Parser bounds input to reduce DoS risk.
- Tests cover DSN formats.

Why not 10:

- Real-world DSN formats are extremely messy and require continuous corpus expansion.

To reach 10:

- Build a private DSN corpus from Gmail, Yahoo, Outlook, corporate MTAs, and edge providers.
- Add parser confidence and unknown-format metrics.
- Add manual review/triage for unparsed reports.

## 5.2 ARF/FBL complaints - 8.0/10

Evidence:

- ARF complaint parsing exists.
- Signed VERP message identity is preferred over attacker-controlled body Message-ID.
- Complaint events flow to suppression/reputation.

Why not 10:

- Real FBL provider enrollment and ingestion proof are external.

To reach 10:

- Enroll and test Yahoo/AOL/Comcast/etc. FBLs.
- Add provider-level FBL source tracking.
- Add feedback loop health dashboard.

## 5.3 VERP signing - 8.5/10

Evidence:

- VERP tokens are HMAC-signed.
- Timing-safe comparisons are used.
- Long Message-ID fallback exists.

Why not 10:

- Secret rotation for VERP tokens is not clearly dual-key.

To reach 10:

- Add current/previous VERP secret verification window.
- Add secret rotation runbook and tests.

---

# 6. Tracking and Unsubscribe - 8.0/10

## 6.1 Open tracking - 7.5/10

Evidence:

- Serves 1x1 pixel immediately.
- Adds event asynchronously.
- Bot detection uses user agent, IP, and timing.

Why not 10:

- Open tracking is increasingly unreliable due to Apple MPP/proxies.
- Bot classifier likely needs continuous real-world tuning.

To reach 10:

- Surface human/bot/suspicious metrics distinctly to customers.
- Add ISP/client-specific classifier tuning.
- Add long-term model validation against known scanner traffic.

## 6.2 Click tracking - 8.0/10

Evidence:

- Links are rewritten via Cheerio parser.
- Click target is revalidated as http/https before redirect.
- Click events are queued asynchronously.

Why not 10:

- No external safe-browsing integration.
- No customer-controlled branded tracking domains beyond config.

To reach 10:

- Add URL safety scanning before redirect for high-risk tenants.
- Add branded tracking domain verification per tenant.
- Add click scanner classification feedback to reputation systems.

## 6.3 Unsubscribe - 8.5/10

Evidence:

- Browser confirmation form uses signed token.
- RFC 8058 one-click POST is accepted.
- Group-scoped unsubscribe exists.
- HTML escaping is used.

Why not 10:

- Preference center and consent history are not full SaaS-grade.

To reach 10:

- Add hosted preference center.
- Add consent/proof ledger.
- Add customer exportable unsubscribe audit logs.

---

# 7. Webhooks - 8.5/10

## 7.1 Registration and validation - 8.0/10

Evidence:

- Shared webhook utilities exist.
- SSRF URL shape validation rejects unsafe schemes, credentials, localhost, private IPs.

Why not 10:

- Enterprise customers often need endpoint verification workflow and event schemas per version.

To reach 10:

- Add endpoint challenge verification.
- Add per-webhook event schema versioning.
- Add delivery retry policy configuration.

## 7.2 Delivery security - 9.0/10

Evidence:

- HMAC signatures include timestamp.
- Delivery-time DNS validation exists.
- Undici dispatcher pins connection to validated IP, closing DNS rebinding TOCTOU.
- Redirects are disabled.

Why not 10:

- Per-delivery Agent creation can create overhead at very high webhook volume.

To reach 10:

- Add bounded pinned-dispatcher pool keyed by hostname/address.
- Add circuit breakers per failing endpoint.
- Add webhook IP allowlisting for enterprise customers.

## 7.3 Retry, logs, and DLQ - 8.5/10

Evidence:

- 408/429/5xx retry, most 4xx drop.
- Delivery log table exists.
- Exhausted jobs dead-letter.

Why not 10:

- Customer self-serve replay UI/API is not fully visible.

To reach 10:

- Add customer-facing webhook delivery inspector and replay.
- Add payload redaction controls.
- Add per-event replay idempotency guidance.

---

# 8. Data Model, Migrations, and Storage - 7.5/10

## 8.1 Postgres schema - 8.0/10

Evidence:

- 33 migrations.
- Schema covers customers, API keys, domains, messages, events, suppressions, webhooks, billing, admin, support, retention, RLS, MFA replay.
- Indexes and constraints exist on important paths.

Why not 10:

- Large-scale partitioning for events/messages is not shown.
- Data residency and regional sharding are absent.

To reach 10:

- Partition high-volume tables by time and tenant.
- Add archival strategy.
- Add data-residency aware tenant placement.

## 8.2 Migration runner - 7.5/10

Evidence:

- Tracks applied migrations and checksums.
- Uses advisory lock.
- Applies migrations transactionally per file.

Why not 10:

- No rollback/down strategy.
- Docker API/worker/tracker images also run migrations at startup, while Helm has a migration job.
- Zero-downtime expand/contract migration discipline is not enforced.

To reach 10:

- Remove app-container startup migrations in production images.
- Use one migration job with deploy gates.
- Add expand/contract migration policy and tests.
- Add migration rollback or forward-fix runbooks.

## 8.3 Body storage - 7.5/10

Evidence:

- Inline, filesystem, and S3-compatible stores exist.
- Body offload is content-addressed.
- Worker transparently loads offloaded bodies.
- GDPR erasure of body objects is tested.

Why not 10:

- S3 is implemented, but production bucket lifecycle, encryption, IAM, replication, and retention are not proven.

To reach 10:

- Add S3 integration test against MinIO in CI.
- Document bucket encryption, lifecycle, object lock, replication, and IAM least privilege.
- Add object-store health checks and metrics.

## 8.4 ClickHouse analytics firehose - 6.5/10

Evidence:

- ClickHouse init and firehose code exist.
- Dual-write appears best-effort.

Why not 10:

- Best-effort analytics can drop events unless backed by retry/outbox.
- No ClickHouse HA/retention/query performance proof.

To reach 10:

- Add analytics outbox/retry path.
- Add reconciliation between Postgres events and ClickHouse.
- Add ClickHouse retention, backup, and cluster deployment docs.

---

# 9. Privacy, Compliance, and Retention - 7.5/10

## 9.1 DSAR export - 8.0/10

Evidence:

- Recipient export endpoint exists.
- E2E tests cover privacy export.

Why not 10:

- Export completeness across all future data stores must be continuously enforced.

To reach 10:

- Add a data inventory map with automated tests for every PII column/table.
- Add customer-facing DSAR request workflow.

## 9.2 Erasure - 8.0/10

Evidence:

- Recipient delete endpoint exists.
- Offloaded body erasure regression tests exist.

Why not 10:

- Legal hold, audit retention exceptions, backups, and ClickHouse erasure need explicit treatment.

To reach 10:

- Add legal hold model.
- Add erasure propagation to analytics stores.
- Document backup erasure posture.

## 9.3 CAN-SPAM/footer compliance - 8.0/10

Evidence:

- Customer physical address stored.
- Worker rejects live sends without address.
- Footer is appended to HTML/text.

Why not 10:

- One-size footer may not satisfy all message categories and jurisdictions.

To reach 10:

- Add compliance template policies by message type, country, and tenant.
- Add preview/linting before send.

## 9.4 Consent and preference management - 5.5/10

Evidence:

- Suppressions and unsubscribe groups exist.

Why not 10:

- Consent capture, source, timestamp, IP, lawful basis, and preference center are not fully visible.

To reach 10:

- Add consent ledger.
- Add preference center.
- Add import consent validation and audit.

---

# 10. Billing and SaaS Monetization - 6.5/10

## 10.1 Provider abstraction - 7.0/10

Evidence:

- Provider interface exists.
- Mock, Stripe, PayPal, Cashfree providers exist.
- Provider selection and registry exist.

Why not 10:

- Mock fallback can hide misconfiguration outside strict production config.
- PayPal/Cashfree usage reporting is no-op due provider limitations.

To reach 10:

- Make production provider selection fail closed unless explicitly configured.
- Add provider capability matrix and plan restrictions.
- Add integration tests with provider sandboxes.

## 10.2 Subscription lifecycle - 7.0/10

Evidence:

- Idempotent billing event log.
- Subscription state updates customer tier/quota.
- Reconciliation exists.

Why not 10:

- `TIER_BY_PRICE` still contains placeholder IDs.
- Dunning, payment failure, tax, invoice PDF, credits, refunds, and proration are not complete.

To reach 10:

- Replace placeholder price IDs.
- Add dunning and grace-period policies.
- Add tax/VAT/GST handling.
- Add invoice/credit/refund workflows.

## 10.3 Usage metering - 7.0/10

Evidence:

- Usage daily table.
- Metered usage reporting exists.
- Drift metric exists.

Why not 10:

- Revenue-grade usage ledgers need immutability and replay/reconciliation controls.

To reach 10:

- Add append-only usage ledger.
- Add replayable billing exports.
- Add customer-visible usage events and invoice line reconciliation.

---

# 11. Admin and Support Operations - 7.5/10

## 11.1 Admin plane - 8.0/10

Evidence:

- Admin routes cover customers, review queue, support, DLQ/reputation style operations.
- Admin actions are audited.
- Admin auth and MFA are hardened.

Why not 10:

- Audit log is not tamper-evident/immutable.
- Admin UX maturity is unknown from API code.

To reach 10:

- Add append-only/tamper-evident audit sink.
- Add admin approval workflows.
- Add exportable audit reports.

## 11.2 Support tickets - 7.5/10

Evidence:

- Ticket schema, notes, reads, SLA, CSAT, canned responses, AI suggested reply support exist.
- E2E tests cover support desk.

Why not 10:

- Live chat is documented as out of scope.
- Enterprise support escalation, attachments, SLAs per contract, and external helpdesk integrations are not complete.

To reach 10:

- Add SLA policies per plan.
- Add escalation workflows and PagerDuty/helpdesk integration.
- Add secure attachment handling.

## 11.3 Abuse review queue - 7.5/10

Evidence:

- Held-for-review messages exist.
- Admin approve/reject flows exist.
- Customer webhook notifications on decisions are documented/tested.

Why not 10:

- Reviewer tooling, evidence bundle, appeal flow, and model feedback loop are limited.

To reach 10:

- Add review evidence views.
- Add reviewer labeling back into classifier training.
- Add customer appeal and policy notes.

---

# 12. Observability - 7.5/10

## 12.1 Metrics - 8.0/10

Evidence:

- Prometheus metrics cover accepted/sent/delivered/bounced/complaints, queues, webhooks, DLQ, DSN parse, pool health, blocklists, backpressure, metering drift, API-key verification, engagement.
- Metrics endpoint requires token in production.

Why not 10:

- Metric cardinality and tenant-level metrics policy need production validation.
- Business SLOs are not formally defined.

To reach 10:

- Add SLO definitions and burn-rate alerts.
- Add cardinality tests and scrape-budget monitoring.
- Add per-tenant dashboards with privacy controls.

## 12.2 Alerts - 7.5/10

Evidence:

- Prometheus alert rules exist for bounce/complaint rates, queues, pool pause, blocklists, services down, DLQ, webhooks.
- Alertmanager config exists.

Why not 10:

- PagerDuty/OpsGenie/Slack placeholders remain.
- No evidence of alert tuning against real traffic.

To reach 10:

- Configure real on-call integrations.
- Run alert fire drills.
- Add runbook links and severity ownership per alert.

## 12.3 Tracing - 7.0/10

Evidence:

- OpenTelemetry shim exists.
- API, worker, tracker call `startTracing`.
- Trace context is injected into queue jobs.

Why not 10:

- OpenTelemetry dependencies have moderate vulnerabilities.
- No sampling strategy, trace retention, or collector deployment proof.

To reach 10:

- Upgrade OpenTelemetry packages.
- Add collector config and sampling rules.
- Add trace-based SLO debugging runbook.

## 12.4 Logging - 6.5/10

Evidence:

- Fastify/Pino logging exists.
- Request IDs exist.

Why not 10:

- No central log aggregation, PII redaction policy, or log retention proof.

To reach 10:

- Add structured log schema.
- Add PII redaction tests.
- Add Loki/ELK/CloudWatch deployment docs and dashboards.

---

# 13. Reliability and Operations - 8.0/10

## 13.1 Queues and workers - 8.0/10

Evidence:

- BullMQ used for send, events, webhooks.
- DLQ exists.
- Scheduler locks prevent duplicate scheduled jobs.
- Graceful shutdown exists.

Why not 10:

- Redis HA behavior and queue recovery after failover are not proven.

To reach 10:

- Test Redis failover and network partitions.
- Add DLQ replay tooling.
- Add queue drain SLO and autoscaling based on queue age.

## 13.2 Scheduler - 8.0/10

Evidence:

- Handles outbox drain, reputation guard, blocklists, warmup, DKIM retire, idempotency sweep, billing reconciliation, retention, postmaster ingestion, baselines, stale send recovery, review timeouts.
- Uses scheduler locks.

Why not 10:

- In-process scheduler is convenient but less operationally clean than dedicated CronJobs.

To reach 10:

- Run all scheduled jobs as Kubernetes CronJobs in production.
- Add last-success timestamps and missed-run alerts.
- Add per-job idempotency tests.

## 13.3 Disaster recovery - 5.5/10

Evidence:

- Backup/restore drill script exists.
- Docs recommend managed Postgres PITR.

Why not 10:

- No proven RPO/RTO.
- No multi-AZ/multi-region failover validation.
- Redis and object storage recovery procedures are incomplete.

To reach 10:

- Define RPO/RTO.
- Run quarterly restore drills.
- Test region failover.
- Add object storage and ClickHouse backup procedures.

---

# 14. Security - 7.5/10

## 14.1 Secret/config guard - 8.0/10

Evidence:

- Production config guard refuses weak/default secrets.
- Production compose contract exists.
- Metrics token fail-closed in production.
- Admin password login disabled in production.

Why not 10:

- Secrets manager integration is documented more than enforced.
- Some provider misconfigs can fall back to mock outside production.

To reach 10:

- Add direct Vault/AWS/GCP secret manager support in deployment.
- Add production startup checks for every selected provider.
- Add secret rotation runbooks and automation.

## 14.2 SSRF and outbound safety - 8.5/10

Evidence:

- SSRF guard covers literal private IPs, DNS resolution, localhost, IPv6 private ranges.
- Webhook worker pins connection to validated IP.
- Billing alert webhook uses URL validation.

Why not 10:

- Full egress allowlisting at network layer is deployment-dependent.

To reach 10:

- Enforce Kubernetes egress policies to approved destinations.
- Add proxy-based egress audit logs.
- Add SSRF tests for additional IPv6 and DNS edge cases.

## 14.3 Supply chain - 6.5/10

Evidence:

- CI has npm audit high+ gate.
- SBOM generation exists.
- Trivy image scanning exists.
- Current audit shows 0 high/critical.

Why not 10:

- 27 moderate vulnerabilities remain.
- SBOM generation is allowed to fail with `|| true`.
- No lockfile signing or provenance/SLSA evidence.

To reach 10:

- Remediate moderate advisories or formally risk-accept them.
- Remove `|| true` from SBOM generation.
- Add provenance attestations and signed images.
- Pin base image digests.

## 14.4 Independent security validation - 4.0/10

Evidence:

- Internal tests and code hardening are strong.

Why not 10:

- No independent penetration test, threat model, SOC 2, ISO 27001, or bug bounty evidence.

To reach 10:

- Commission external pentest.
- Produce threat model and data-flow diagrams.
- Add security review gates for high-risk changes.
- Start SOC 2 readiness if selling to enterprises.

---

# 15. Infrastructure and Deployment - 7.0/10

## 15.1 Docker and Compose - 7.0/10

Evidence:

- Dockerfiles run as non-root `node`.
- Production compose overlay removes Postgres/Redis/worker host ports.
- Prod check validates required env and production flags.

Why not 10:

- Images use `npm install`, not `npm ci`.
- Runtime images include full app tree and likely dev/build artifacts.
- App containers run migrations at startup.

To reach 10:

- Use `npm ci --omit=dev` for production runtime.
- Build slimmer runtime images.
- Pin base image digest.
- Remove startup migrations from app containers in production.

## 15.2 Kubernetes/Helm - 7.5/10

Evidence:

- Helm chart has API/worker/tracker deployments, services, ingress, HPA, PDB, migration job, NetworkPolicy.
- Rolling update has `maxUnavailable: 0`.
- Readiness/liveness probes exist.

Why not 10:

- Example hosts and image repo placeholders remain.
- NetworkPolicy assumes namespace labels and CNI behavior.
- No managed DB/Redis modules or cloud-specific reference architecture.

To reach 10:

- Add production values examples for AWS/GCP/Azure.
- Add ExternalSecrets/CSI secret store support.
- Add PodSecurity standards, seccomp, read-only root filesystem where possible.
- Add autoscaling on queue lag, not only CPU.

## 15.3 TLS and service mesh - 7.0/10

Evidence:

- cert-manager manifests exist.
- Istio mTLS manifest exists.

Why not 10:

- These are manifests, not proof of live deployment.

To reach 10:

- Add tested Helm profile for TLS and mTLS.
- Add smoke tests verifying HTTPS, HSTS, mTLS, and certificate renewal.

---

# 16. Testing and CI - 7.5/10

## 16.1 Test coverage breadth - 8.5/10

Evidence:

- 76 test files.
- Unit and E2E tests cover auth, send, body offload, events, billing, privacy, support, webhooks, SSRF, RLS, migrations, retention, scheduler, DKIM/KMS, MFA replay.
- After migrations, 510 tests passed, 3 skipped, and RLS passed in isolation after cleanup.

Why not 10:

- Full-suite local run exposed setup defects.
- Some skipped tests remain.

To reach 10:

- Fix `.env.test` and Vitest dotenv loading.
- Make tests create/drop test DB or apply migrations automatically.
- Fix RLS role cleanup order in `beforeAll`.
- Eliminate or document every skipped test.

## 16.2 CI - 7.5/10

Evidence:

- CI builds, migrates, tests, audits high+, generates SBOM, scans images.

Why not 10:

- CI env differs from local `.env.test`.
- SBOM step can fail without failing CI.
- Load tests are not regular gating.

To reach 10:

- Add matrix for Node LTS versions.
- Add k6 staging gate.
- Make SBOM mandatory.
- Add OpenAPI compatibility diff.

## 16.3 Load testing - 6.5/10

Evidence:

- In-process load harness and k6 script exist.
- `LOAD_TEST_FINDINGS.md` reports about 164 req/s per process locally and fixed per-recipient round-trip bottleneck.

Why not 10:

- This is not cluster-scale, production-like load proof.

To reach 10:

- Run k6 against staging Kubernetes with real Postgres/Redis topology.
- Measure API accept RPS, worker drain rate, queue age, DB saturation, p99 latency, and failure modes.
- Publish capacity envelope per deployment size.

---

# 17. SDK, Docs, and Developer Experience - 7.5/10

## 17.1 SDK - 7.5/10

Evidence:

- TypeScript SDK exists.
- Webhook signature verification helpers exist.
- E2E SDK tests exist.

Why not 10:

- Only one SDK language visible.
- Retry/idempotency helpers and pagination ergonomics need review.

To reach 10:

- Add generated SDKs for common languages.
- Add retry, idempotency, pagination, and webhook verification examples.
- Add semantic versioning and changelog discipline for SDK.

## 17.2 Docs - 8.0/10

Evidence:

- Guides exist for sending, authentication, templates, tracking, webhooks, suppressions, privacy, rate limits, billing, support, DNS, deliverability.
- Runbooks exist for blocklists, DKIM failure, DLQ, IP warmup, key compromise, pool pause, queue backpressure.

Why not 10:

- Some docs contain action-required notes and placeholders.
- Docs occasionally overstate readiness compared with unproven operational reality.

To reach 10:

- Separate "implemented in code" from "validated in production".
- Add launch checklist with owners and evidence links.
- Add customer-facing docs and operator-only docs split.

## 17.3 Local developer setup - 6.5/10

Evidence:

- Docker Compose stack exists.
- Test Docker Compose stack exists.

Why not 10:

- Test env comments/config are inconsistent.
- Full test run required manual env and migration steps.

To reach 10:

- Add `npm run test:infra:up`, `npm run test:migrate`, `npm run test:clean`.
- Load `.env.test` automatically.
- Fix `.env.test` test DB port.

---

# 18. Highest Priority Path to 10/10

## P0 - Must fix before calling enterprise production grade

1. Integrate RLS into production API routes using `withTenant()` or equivalent transaction-scoped tenant context.
2. Run API with non-superuser, non-BYPASSRLS database role.
3. Fix local test harness: load `.env.test`, correct test DB port, auto-run migrations or document one command.
4. Remediate or formally accept all 27 moderate dependency advisories.
5. Replace billing placeholder price IDs and prove selected billing provider in sandbox.
6. Remove app-container startup migrations for production, relying on one migration job.

## P1 - Required for SaaS-grade launch

1. Run production-like k6 load tests against staging and publish capacity limits.
2. Prove Redis/Postgres HA failover behavior.
3. Add customer-facing webhook replay and delivery inspection.
4. Add consent ledger and preference center.
5. Add real S3/MinIO object-storage integration test and lifecycle docs.
6. Add alert fire drills and real on-call routing.

## P2 - Required for enterprise-grade sales

1. Add customer SSO/SAML/OIDC and SCIM.
2. Add tamper-evident audit export.
3. Add legal hold, data residency, and compliance evidence.
4. Add independent security assessment.
5. Add SOC 2 readiness controls.
6. Add tenant-level policy engine for auth, sending, compliance, and retention.

## P3 - Required for SendGrid/Braze-class parity

1. Execute real IP warmup over weeks/months.
2. Enroll feedback loops and postmaster tools with major mailbox providers.
3. Add seed-list inbox placement monitoring.
4. Add per-ISP adaptive throttling.
5. Add blocklist incident automation.
6. Add abuse intelligence feeds and continuous classifier feedback loop.

## Final Honest Rating

The platform is strong enough to continue toward production with focused work. It is not yet a 10/10 enterprise or SendGrid-class system.

Best current interpretation:

- Core engineering: strong.
- Production launch readiness: close but not done.
- SaaS maturity: partial.
- Enterprise maturity: needs security, compliance, tenant isolation, HA/DR, and operational evidence.
- Deliverability maturity: mostly scaffolding until proven against real mailbox providers.

