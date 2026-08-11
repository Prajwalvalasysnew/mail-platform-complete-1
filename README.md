# Mail Platform

A self-hosted, multi-tenant transactional email platform with REST, SMTP, and
SendGrid-compatible sending; background delivery workers; tracking; billing;
automation; customer and admin APIs; and operational tooling.

The repository is a TypeScript monorepo built with Fastify, PostgreSQL, Redis,
BullMQ, Haraka, ClickHouse, React, and Docker.

## Current validation status

- 1,236 automated tests, including dedicated regulated-mode,
  secure-portal, rights-workflow, archive, and activation-evidence suites.
- Free, Paid Pro, and Enterprise persona journeys are covered.
- 96 PostgreSQL migration files are tracked; the latest is `097`
  (the historical numbering intentionally contains gaps).
- Production workspace builds pass.
- `npm audit --omit=dev --audit-level=high` reports no production dependency
  vulnerabilities.
- CI scans production container images with Trivy.
- The template-mode production readiness check passes.
- The final product-aware real-development aggregate on 2026-07-30 passed
  176/176 files and 1,236/1,236 tests with 75.43% statement, 64.39% branch,
  77.72% function, and 79.42% line coverage. Real local-development Free, Paid
  Pro, Enterprise, HIPAA,
  FERPA, SEC/FINRA fail-closed, and SOC2-06 evidence-review journeys also
  passed against the development database, Redis, worker, tracker, and Mailpit.
- The complete run IDs and evidence are recorded in the
  [local end-to-end validation report](docs/testing/LOCAL_END_TO_END_VALIDATION_REPORT_2026-07-29.md).
- Remaining target-host, provider, independent-assessment, and release gates
  are tracked in the
  [end-to-end production test plan](docs/testing/END_TO_END_PRODUCTION_TEST_PLAN.md).

This describes code-level readiness, not production approval. Send-path
round-trip reduction improved the best real Paid live-key run to p95 1.95s and
p99 2.46s, with 286/286 requests accepted and no HTTP failures. Repeated runs
on this Windows Docker host still missed the <250ms p95 and <500ms p99
send-accept SLO (observed optimized range: p95 1.95–3.38s, p99 2.46–4.14s).
Production operation still requires target-host performance qualification,
live IP/domain warmup, reputation evidence, backup and failover drills on the
target infrastructure, ClamAV deployment, and an independent
security/compliance assessment. See [Production checklist](docs/PRODUCTION_CHECKLIST.md)
and [Operational drills](docs/OPERATIONAL_DRILLS.md).

## Feature catalogue

For the exhaustive engineering inventory—including customer, delivery,
administration, billing, privacy, compliance, observability, infrastructure,
scheduled jobs, testing, and known boundaries—see the
[Complete Platform Feature Inventory](docs/COMPLETE_FEATURE_INVENTORY.md).

| Area | Implemented capabilities |
| --- | --- |
| Sending channels | Native REST send and batch send, authenticated SMTP submission, SendGrid v3 compatibility, and typed SDK |
| Message creation | Text/HTML content, templates and variables, per-recipient fan-out, custom headers, reply-to, attachments, scheduling, cancellation, and idempotency keys |
| Delivery pipeline | Transactional outbox, BullMQ workers, atomic claiming, retry/failure taxonomy, priority lanes, quota reservation/refund, VERP return paths, and Haraka or SES transport |
| Attachment security | Size/type validation, PE and ELF signature blocking despite renamed extensions, and optional ClamAV streaming scans with configurable failure policy |
| Sender identity | Sending-domain lifecycle, SPF/DKIM/DMARC verification state, DKIM selector rotation, reporting addresses, and domain scanner |
| Deliverability | Suppression enforcement, hard-bounce/complaint suppression, DSN and ARF parsing, reputation guard, IP pools, warmup schedules, blocklist scanning, and TLS-required sending |
| Engagement | Open pixels, click redirects, RFC 8058 one-click unsubscribe, unsubscribe groups, consent history, and bot/prefetch/Apple MPP classification |
| Messages and analytics | Message list/detail/activity, event history, usage/quota/stats, ClickHouse analytics, idempotent event processing, and reconciliation watermarks |
| Webhooks | Customer webhook lifecycle, HMAC signatures, secret rotation, delivery history, retries, SSRF protection, and replay tooling |
| Workflows | Draft validation, publishing, immutable versions, restore, simulation, single/bulk triggers, waits, event triggers, branching, A/B splits, goals, runs, cancellation, stats, and bounded definition caching |
| Authentication | Customer registration, email verification, login/logout, password reset, session/device management, organization switching, TOTP MFA, and WebAuthn/passkeys |
| Team and enterprise identity | Team invitations, role/capability enforcement, SSO policy, SCIM token management, SCIM 2.0 provisioning, admin OIDC, and JIT/break-glass elevation |
| API credentials | Scoped live/test API keys, key creation/list/rotation/revocation, SMTP scope, and on-behalf-of authorization |
| Multi-tenancy | Fail-closed PostgreSQL row-level security, non-bypass application role, parent/child isolation, subaccounts, child keys, usage rollups, and bulk template push |
| Billing | Free/Pro/Enterprise plans, quotas, priority entitlements, checkout/portal, invoices, tax, credit notes/refunds, Stripe/PayPal/Cashfree webhooks, plan-change lifecycle, dunning, and reconciliation |
| Privacy controls | Recipient export/erasure, downloadable exports, body/object-store and attachment deletion, queue tombstones, legal and regulatory retention holds, per-plan retention sweeps, DMARC retention, consent records, processing restrictions, sale/share opt-outs, sensitive-PI limits, appeals, and tenant-safe deletion |
| Audit and control evidence | Tenant hash chains, integrity verification, retention-safe archive, Ed25519 checkpoints, WORM export, default-on admin read auditing, break-glass review, persisted retention runs, monthly control-evidence collection, completeness findings, and reviewer sign-off |
| Regulated-workload controls | Enterprise-only per-mode activation, independently reviewed checksum-addressed evidence, PAN/PHI/education/broker-record classification, encrypted HIPAA/FERPA portal, pseudonymized rights/disclosure workflows, and fail-closed SEC/FINRA specialist archive receipts |
| Support and trust | Customer support tickets/messages/CSAT, admin support inbox, notes, SLA/triage helpers, abuse review queue, KYC decisions, customer suspension, and DLQ replay/purge |
| Admin console | Fleet overview, tenant management, deliverability/IP pools, support, abuse, KYC, audit, billing events, payment gateways, platform settings, retention controls, and admin team management |
| Observability | Health/readiness endpoints, `mp_` Prometheus metrics, Grafana dashboards, Alertmanager rules, Jaeger/OpenTelemetry integration, and sensitive-data log/trace redaction |
| Deployment and operations | Development and production Compose files, Helm chart, three-node Hetzner Terraform foundation, migration job, backup/restore/PITR and Redis failover drills, k6 scenarios, SBOM generation, dependency audit, and Trivy image scanning |
| Developer experience | OpenAPI 3.1 document, route-parity and breaking-change guards, stable error registry, typed SDK, testkit, isolated test stack, and local Mailpit |

## Plans and persona behavior

Plan tier currently controls quota, billing state, normal send priority, and
eligibility for the requested critical lane. Most features are authorized by
API-key scope or human membership capability rather than being hidden by plan.

| Contract | Free | Paid Pro | Enterprise |
| --- | ---: | ---: | ---: |
| Daily quota used by persona tests | 100 | 50,000 | 1,000,000 |
| Monthly quota used by persona tests | 3,000 | 1,000,000 | 50,000,000 |
| Standard send priority | 10 | 5 | 1 |
| Requested critical lane | Downgraded | Eligible | Eligible |
| Default event/activity retention | 7 days | 90 days | 365 days* |
| Default message-body retention | 7 days | 90 days | 90 days* |
| HIPAA/FERPA/SEC-FINRA eligibility | No | No | Evidence-gated |
| Billing plan | `free` | `pro` | `enterprise` |

`*` Retention is bounded by the deployment's configured physical ceilings.

The authoritative feature-by-tier contract is the
[Persona E2E feature matrix](docs/testing/PERSONA_FEATURE_MATRIX.md).

## End-to-end feature coverage

The E2E suite starts the real Fastify routes and BullMQ send worker against an
isolated PostgreSQL and Redis stack. It verifies HTTP responses, tenant-owned
database state, queue completion, event history, usage accounting, authorization
denials, idempotency, and cross-tenant isolation.

### Persona journeys

| Journey | What is exercised end to end |
| --- | --- |
| Free developer | Signup, verification, API key, sender setup, first delivery, quota protection, and free-priority behavior |
| Paid SaaS | Subscription activation, production sends, priority behavior, usage, invoices, and tenant-safe billing views |
| Enterprise organization | Team access, child accounts, on-behalf-of operations, child keys, template distribution, priority sends, quotas, and audit integrity |
| Account lifecycle | Registration, verification, login, active sessions, session revocation, password reset, organization switching, and logout |
| Credentials and domains | Scoped key lifecycle, customer and API domain surfaces, verification, DMARC reporting, and domain scanning |
| Content and delivery | Template CRUD/rendering, attachments, scheduling, cancellation, retries, idempotency, messages, events, usage, stats, and analytics |
| Channel parity | REST/SMTP/SendGrid/SDK submission paths entering the same tenant delivery pipeline |
| Consent and integrations | Suppressions, consent history, unsubscribe groups, webhooks, secret rotation, retries, and SSRF controls |
| Automation, privacy, and support | Workflow lifecycle/execution, data exports, recipient erasure, legal holds, support conversation, resolution, and CSAT |
| Governance and resilience | Team RBAC, SSO, SCIM, audit verification, admin fleet visibility, parent/child isolation, suspended access, and fail-safe behavior |

Additional suites cover billing providers, DKIM rotation, DMARC retention,
attachment malware scanning, SMTP rate limits, RLS, crash consistency, event
idempotency, retention, privacy tombstones, bot detection, security headers,
admin MFA/JIT, audit WORM checkpoints, ClickHouse reconciliation, and more.

These are API/service E2E tests using real infrastructure. Sixteen real
Playwright journeys pass across Chromium, Firefox, and WebKit, verifying admin
login, HttpOnly session restoration, all 13 console routes, WCAG 2 A/AA
automated checks, support/operator/admin/superadmin navigation and direct-route
denials, a real admin create/change/disable lifecycle, authenticated
API/console-error checks, and logout. The state-changing lifecycle runs once in
Chromium; its Firefox and WebKit duplicates are intentionally skipped.

## Compliance posture

The repository implements compliance-supporting technical controls; it is not
evidence that a deployed organization is certified or compliant with HIPAA,
GDPR/CCPA, PCI DSS, SOC 2, FERPA, SEC 17a-4, or another framework. Compliance
also depends on the production architecture, configuration, contracts,
policies, people, risk assessment, incident response, and retained operational
evidence.

### Supported compliance and regulatory areas

"Supported" below means the repository contains relevant technical controls,
workflows, tests, or evidence automation. It does **not** mean the platform,
operator, or a future deployment is certified or legally compliant.

| Framework or regulation | Platform support | Current boundary |
| --- | --- | --- |
| SOC 2 | Hash-chained audit records, immutable audit export, access reviews, retention evidence, security monitoring hooks, and monthly SOC2-06 evidence collection with completeness findings and reviewer sign-off | A CPA firm must assess the deployed organization and issue any SOC 2 report; operating-effectiveness evidence must come from production |
| ISO/IEC 27001 | Technical controls supporting identity, access control, cryptography, logging, change protection, vulnerability checks, incident preparation, backup, and resilience | Certification requires an organization-owned ISMS, risk treatment, policies, internal audit, management review, and an accredited certification audit |
| GDPR | Data access/export, rectification, restriction, objection, erasure, consent evidence/withdrawal, processing records, retention controls, legal holds, pseudonymization, and processor-assistance mappings | The controller/processor roles, lawful bases, notices, transfer mechanisms, DPIAs, vendor terms, request verification, and production procedures remain organizational/legal responsibilities |
| CCPA/CPRA | Access/deletion support, correction, sale/share opt-out, Global Privacy Control handling, sensitive-PI limitation, appeals, consent/suppression separation, and retention controls | Applicability, notices, authorized-agent verification, "sale/share" determinations, contracts, and request operations must be approved and operated by the business |
| CAN-SPAM | Commercial-message classification, sender identity/footer controls, RFC 8058 one-click and group unsubscribe, suppression enforcement, synthetic unsubscribe monitoring, and sender-health enforcement | Senders remain responsible for lawful content, accurate identity, physical-address configuration, campaign purpose, and operating the required opt-out process |
| PCI DSS | PAN classification and fail-closed blocking in messages/support paths, billing-field allowlists, payment-data scope documentation, and retention cleanup | The platform does not accept cardholder data in messages or tickets. PCI scope, SAQ/ROC, segmentation, payment-provider configuration, and assessor approval remain deployment responsibilities |
| HIPAA | Individually gated Enterprise mode, PHI classification, encrypted expiring two-credential secure portal, rights/disclosure/breach workflows, OIDC/MFA context, immutable access evidence, and remote KMS/Vault integration | Disabled by default. Activation requires genuine BAAs, applicability and risk analyses, safeguard evidence, target-environment contingency testing, and independent HIPAA assessment |
| FERPA | Individually gated Enterprise mode, education-record classification, secure portal, access/amendment/hearing workflow, disclosure accounting, redisclosure restriction, and retention interlocks | Disabled by default. Activation requires school-official/direct-control terms, institutional process allocation, applicable state-law review, training, and independent FERPA assessment |
| SEC Rule 17a-4 / FINRA | Individually gated Enterprise mode, broker-dealer content classification, archive-before-accept enforcement, immutable provider receipts, reconciliation, retention locks, and zero-acceptance fail-closed behavior | Disabled by default. Activation requires a real qualifying specialist archive, approved retention/supervision configuration, provider contracts/certification, legal applicability review, and specialist assessment |

PAN remains prohibited in every mode. HIPAA, FERPA, and SEC/FINRA are separate
Enterprise modes; satisfying or activating one never enables another. Missing,
expired, rejected, or self-approved prerequisite evidence prevents activation.

| Control | Code/E2E status | Important boundary |
| --- | --- | --- |
| Recipient access and portability | Implemented: recipient JSON export plus asynchronous downloadable event/message-metadata exports | The customer must verify the requester, choose the lawful scope, and meet applicable deadlines |
| Recipient erasure | Implemented: tenant-scoped database deletion, inline/offloaded body and attachment deletion, ClickHouse cleanup, workflow cleanup, BullMQ cleanup, durable tombstones, retry tracking, and consent attribution | Active legal holds correctly block erasure; historical backups are not selectively rewritten |
| Legal holds | Implemented for tenant-wide and recipient-specific scopes; erasure and retention honor active holds | Hold authorization, matter management, notices, and release approval remain organizational processes |
| Retention | Implemented in bounded batches for bodies, events, message metadata, links, exports, operational logs, and DMARC data; plan/tenant windows are supported | Production values, scheduler health, backup lifecycle, and regulatory schedules must be approved and monitored by the operator |
| Consent and suppression | Implemented: append-only consent events, suppression enforcement, one-click/group unsubscribe, bounce and complaint attribution | The sender remains responsible for lawful basis, consent capture, notices, and campaign content |
| Tenant isolation and access | Implemented: fail-closed PostgreSQL RLS, scoped keys, team RBAC, MFA, SSO/SCIM, admin roles, and audited privilege changes | Production IdP policy, access reviews, offboarding, and separation of duties are deployment/operations responsibilities |
| Audit integrity | Implemented: tenant hash chains, verification, archive-before-purge, Ed25519 checkpoints, and full audit segments exported with KMS encryption and S3 Object Lock COMPLIANCE retention | Independent bucket/KMS custody, review cadence, and evidence retention must be configured and validated operationally |
| Control evidence automation | Implemented for eight controls: monthly collection records explicit `complete`, `partial`, or `missing` findings; evidence writes reject email addresses and credential-shaped fields; admin reviewers can sign off collected periods | Collection proves what the application observed, not organizational operating effectiveness; production scheduling, reviewer assignment, exception remediation, and auditor acceptance remain operational responsibilities |
| Staff and emergency access review | Implemented: admin-plane reads are recorded by default in the hash-chained audit log; break-glass access has an admin-only review queue with immutable decisions; production OIDC requires an asserted MFA/authentication context | Role-matrix approval, emergency-access exercises, periodic sampling, workforce controls, and retained production review evidence remain organizational requirements |
| Processor assistance and security schedule | Partial: tenants can retrieve an Article 30(2) processing record, an Article 32 measures schedule resolved from live configuration, and mapped Article 28(3) assistance duties | Vendor identity is deployment-specific; customer exercises and the organizational-measures schedule remain outstanding |
| Encryption and transport | Partial: selected secrets use AES-256-GCM with pluggable KMS; API/SMTP TLS deployment manifests exist; outbound delivery records TLS evidence | Message bodies/database volumes/backups require infrastructure encryption; `tls_required` currently records policy/evidence but does not itself prevent every clear-text downstream SMTP delivery |
| Data residency and backup erasure | Not implemented as an application guarantee | Region pinning and backup-expiry/erasure depend on the selected database, object store, analytics, and backup topology |

### Evidence automation (SOC2-06)

The worker scheduler checks daily and collects at most once for each closed
calendar month. It currently evaluates `CANSPAM-05`, `CANSPAM-08`, `BASE-03`,
`BASE-05`, `BASE-06`, `BASE-10`, `PCI-02`, and the technical evidence used by
`HIPAA-07`. A missing run for a continuously operating control is recorded as a
finding rather than being reported as a zero count. Recollecting a period clears
the earlier sign-off because the underlying evidence has changed.

Administrative operations are intentionally outside the public OpenAPI
document:

- `GET /admin/control-evidence` lists collected evidence (support or above).
- `POST /admin/control-evidence/collect` collects a period (operator or above).
- `POST /admin/control-evidence/:id/review` records reviewer sign-off (operator
  or above).
- `GET /admin/access-review` lists staff-access review items (admin or above).
- `POST /admin/access-review/:auditId` records an immutable access decision
  (admin or above).

The manual retention endpoint also persists a `retention_runs` record, including
failures, so “the sweep did not run” is distinguishable from “nothing was due
for deletion.” See the [Compliance implementation plan](docs/COMPLIANCE_IMPLEMENTATION_PLAN.md)
for control-by-control status and remaining organizational evidence.

### HIPAA

HIPAA, FERPA, and SEC/FINRA modes are now disabled-by-default and activated
individually. The technical implementation includes evidence-backed gates,
value-free classification, an encrypted HIPAA/FERPA portal,
rights/disclosure workflows, and a fail-closed specialist archive. Legal
agreements, target-environment drill results, and independent assessment remain
real external prerequisites; the service refuses activation while their
approved evidence is missing or expired. PAN remains prohibited in every mode.
See the [regulated-workload policy](docs/REGULATED_WORKLOAD_POLICY.md) and
[activation runbook](docs/runbooks/REGULATED_MODE_ACTIVATION.md).

Recipient unsubscribe links support the full bounded RFC Message-ID size
rather than the router's small default. Canonical base64url and decoded
Message-ID validation prevents malformed public tracking URLs from reaching
PostgreSQL, while long legitimate links continue through the unauthenticated
one-page CAN-SPAM flow.

HIPAA is **not fully implemented or certified by this repository**. The code
provides useful technical building blocks—access controls, audit integrity,
tenant isolation, retention/erasure, selected-secret encryption, and transport
evidence—but a HIPAA deployment still needs, at minimum, an applicability and
ePHI data-flow review, an organization-wide risk analysis and risk-management
plan, administrative and physical safeguards, policies and workforce training,
incident/breach procedures, contingency and restore evidence, production
encryption/key-management validation, and required Business Associate
Agreements (including applicable subcontractors). No BAA offering is asserted
by this repository.

See the detailed, evidence-linked [Compliance posture](docs/COMPLIANCE_POSTURE.md)
and [Security and compliance guide](docs/guides/security-compliance.md). This is
technical documentation, not legal advice.

## Architecture

```text
REST / SMTP / SendGrid / SDK
             |
             v
      Fastify API gateway
             |
     PostgreSQL + Redis/BullMQ
             |
             v
        Send workers ------> SES or Haraka outbound ------> recipient MX
             |                         |
             |                         v
             |                  delivery events
             v
  Webhook/event workers ------> customer webhooks
             |
             +------> ClickHouse analytics

Recipient actions -----------> Tracker (open/click/unsubscribe)
DSN/ARF mail ----------------> Haraka inbound (bounce/complaint)
Operators -------------------> React admin console -> /admin API
```

PostgreSQL is the source of truth. Redis carries queues, rate limits, caches,
and short-lived coordination. ClickHouse is an analytics projection with
idempotent ingestion and reconciliation. Tenant access is enforced by both
application authorization and PostgreSQL RLS.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `packages/api` | Customer, public, compatibility, and admin Fastify APIs |
| `packages/worker` | Send, event, webhook, retention, billing, reputation, and scheduler workers |
| `packages/smtp-gateway` | Authenticated customer SMTP submission with connection/IP/recipient/message/tier limits |
| `packages/tracker` | Open, click, unsubscribe, and engagement classification endpoints |
| `packages/haraka-outbound` | DKIM signing, outbound delivery, event emission, and internal-header cleanup |
| `packages/haraka-inbound` | DSN bounce and ARF complaint ingestion |
| `packages/shared` | Database, queues, security, billing, workflows, privacy, audit, analytics, storage, and domain services |
| `packages/admin-console` | React/Vite internal operator console |
| `packages/sdk` | Typed client SDK |
| `packages/docs` | Docusaurus documentation site and generated OpenAPI reference |
| `packages/tests` | Unit, integration, RLS, and E2E suites |
| `infra/migrations` | Ordered PostgreSQL migrations |
| `infra/helm` | Kubernetes deployment chart and migration job |
| `infra/loadtest` | k6 performance scenarios |
| `scripts` | Seeding, replay, verification, backup, failover, scale, and readiness tools |

## Prerequisites

- Docker Desktop or Docker Engine with Compose.
- Node.js 20 LTS and npm for the CI/runtime baseline. `package.json` accepts
  Node.js 20+, but newer non-LTS majors may expose test timing differences.
- For real direct-to-MX sending: DNS control, an allowed outbound port 25, and
  reverse DNS/PTR control.
- For production attachment scanning: a reachable ClamAV `clamd` service.

## Quick start with Docker

```bash
# Copy configuration and set at least METRICS_TOKEN.
cp .env.example .env

# Install local tooling and start the application stack.
npm ci
docker compose up -d --build

# Confirm API health and migration completion.
curl http://localhost:3000/health
docker compose ps
```

If host port 3000 is already in use, choose another host port without changing
the API's internal Compose port:

```bash
API_HOST_PORT=3003 docker compose up -d api
DEV_REPLAY_API_BASE=http://localhost:3003 DEV_REPLAY_CONFIRM=1 \
  npx tsx scripts/replay-personas-dev.ts
```

PowerShell:

```powershell
$env:API_HOST_PORT = '3003'
docker compose up -d api
$env:DEV_REPLAY_API_BASE = 'http://localhost:3003'
$env:DEV_REPLAY_CONFIRM = '1'
npx tsx scripts/replay-personas-dev.ts
Remove-Item Env:API_HOST_PORT, Env:DEV_REPLAY_API_BASE, Env:DEV_REPLAY_CONFIRM
```

PowerShell equivalent for the first step:

```powershell
Copy-Item .env.example .env
```

The Compose `migrate` service is the single migration runner. To apply newly
pulled migrations again:

```bash
docker compose run --rm migrate
```

Do not run migrations concurrently from every application replica.

## Local URLs and ports

| Service | Local address | Purpose |
| --- | --- | --- |
| API | <http://localhost:3000> | REST/admin APIs, health, and OpenAPI |
| OpenAPI | <http://localhost:3000/openapi.json> | Generated OpenAPI 3.1 document |
| Tracker | <http://localhost:4000> | Opens, clicks, and unsubscribe |
| Admin console | <http://localhost:5174> | Internal React console; start separately with npm |
| Mailpit | <http://localhost:8025> | Captured development/test mailbox |
| Mailpit SMTP | `localhost:1025` | Direct SMTP capture endpoint |
| Customer SMTP gateway | `localhost:587` | Authenticated platform SMTP submission |
| Haraka outbound | `localhost:2525` | Worker-to-MTA handoff |
| Haraka inbound | `localhost:2526` | Bounce/complaint ingestion in development |
| PostgreSQL | `localhost:5432` | Development database |
| Redis | `localhost:6379` | Queues, cache, and rate limits |
| Worker metrics | <http://localhost:9100> | Prometheus metrics |
| SMTP metrics | <http://localhost:9102> | SMTP gateway metrics/health |
| Prometheus | <http://localhost:9090> | Metrics, monitoring profile; override with `PROMETHEUS_HOST_PORT` if occupied |
| Grafana | <http://localhost:3002> | Dashboards, monitoring profile |
| Alertmanager | <http://localhost:9093> | Alert routing, monitoring profile |
| Jaeger | <http://localhost:16686> | Trace UI, monitoring profile |
| ClickHouse HTTP | `localhost:8123` | Analytics, analytics profile |

Start optional monitoring/analytics services with the applicable Compose
profiles defined in `docker-compose.yml`:

```powershell
docker compose --profile monitoring --profile analytics up -d
```

The 2026-07-29 validation used port `9091` for Prometheus because another local
service already owned `9090`; all four configured scrape targets were healthy.

## Admin console

The admin console is intentionally not bundled into the core development
Compose stack. Start it locally after the API is healthy:

```bash
npm run dev:admin
```

Open <http://localhost:5174>. There is no universal default admin password.
Bootstrap or rotate a local superadmin explicitly:

```bash
ADMIN_PASSWORD='use-a-long-local-password' \
  npm run create-admin -- admin@localhost.test superadmin "Local Admin"
```

PowerShell:

```powershell
$env:ADMIN_PASSWORD = 'use-a-long-local-password'
npm run create-admin -- admin@localhost.test superadmin "Local Admin"
Remove-Item Env:ADMIN_PASSWORD
```

The console supports fleet overview, tenants, deliverability, IP pools, support,
abuse review, KYC, audit, billing, payment gateways, settings, retention, DLQ,
and admin team/elevation management. See [Admin API](docs/ADMIN.md) and the
[admin-console README](packages/admin-console/README.md).

### Seed rich admin demo data

The SQL seed is idempotent and intended only for the local Compose database:

```bash
docker exec -i mail-postgres psql -U mail -d mail_platform < scripts/seed-admin-demo.sql
```

PowerShell:

```powershell
Get-Content scripts/seed-admin-demo.sql -Raw |
  docker exec -i mail-postgres psql -U mail -d mail_platform
```

Refresh the admin console after seeding.

## Send a message through the API

Create a customer and API key:

```bash
curl -X POST http://localhost:3000/v1/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"developer@example.com","name":"Local Developer"}'
```

Register and verify a domain, then send:

```bash
curl -X POST http://localhost:3000/v1/domains \
  -H "Authorization: Bearer mp_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain":"send.example.com"}'

curl -X POST http://localhost:3000/v1/domains/DOMAIN_ID/verify \
  -H "Authorization: Bearer mp_live_YOUR_KEY"

curl -X POST http://localhost:3000/v1/send \
  -H "Authorization: Bearer mp_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from":"hello@send.example.com",
    "to":"recipient@example.com",
    "subject":"Hello from Mail Platform",
    "html":"<h1>It works</h1>"
  }'
```

For safe automated local messages and Mailpit visibility, use the development
persona replay below. Direct Haraka delivery is not automatically redirected to
Mailpit unless you configure Haraka/transport as a local capture sink.

## Replay Free, Paid, and Enterprise activity locally

The replay is additive, generates unique tenants, refuses non-local and test
databases, and requires an explicit confirmation flag:

```bash
DEV_REPLAY_CONFIRM=1 npx tsx scripts/replay-personas-dev.ts
npx tsx scripts/verify-personas-dev.ts
```

PowerShell:

```powershell
$env:DEV_REPLAY_CONFIRM = '1'
npx tsx scripts/replay-personas-dev.ts
npx tsx scripts/verify-personas-dev.ts
Remove-Item Env:DEV_REPLAY_CONFIRM
```

The replay creates Free, Paid, and Enterprise activity that is visible in the
development database/admin APIs and verifies matching Mailpit messages where
the local capture transport is configured. Development Compose uses the
`mailpit` SMTP transport by default, exercising real message serialization and
attachments without sending externally. Production deployments select Haraka
or SES separately.

For an assertion-based, additive end-to-end campaign against the running
development stack:

```bash
DEV_REPLAY_CONFIRM=1 \
DEV_REPLAY_API_BASE=http://localhost:3000 \
npx tsx scripts/e2e-dev-live.ts
```

This runner refuses non-local and test databases. It covers the Free, Paid, and
Enterprise account lifecycle, sessions, scoped credentials, verified development
domains, templates, suppressions and consent history, processing records,
support, idempotent sending, usage, worker/Mailpit delivery, Free quota
enforcement, and Enterprise RBAC, SSO, SCIM, subaccounts, tenant isolation, and
audit-chain verification. It is additive and does not delete existing
development records.

The admin/compliance campaign can then be run against the Enterprise tenant
created by the live runner:

```bash
DEV_REPLAY_CONFIRM=1 \
DEV_REPLAY_API_BASE=http://localhost:3000 \
DEV_COMPLIANCE_CUSTOMER_ID=<enterprise-customer-id> \
DEV_COMPLIANCE_ADMIN_EMAIL=<local-admin-email> \
DEV_COMPLIANCE_ADMIN_PASSWORD=<local-admin-password> \
npx tsx scripts/e2e-compliance-dev-live.ts
```

It validates SOC2-06 evidence collection and sign-off, HIPAA-07 tenant-data
access review, and the GDPR-13 processing record using real local development
data. It is additive and has the same local/non-test safety checks. See the
[27 July 2026 end-to-end validation report](docs/END_TO_END_VALIDATION_REPORT_2026-07-27.md)
for a recorded full-stack run.

## Testing

Start the isolated test infrastructure:

```bash
docker compose -f docker-compose.test.yml up -d
```

Run the suites:

```bash
npm test                                      # complete suite
npm run test:e2e                              # all E2E tests
npm run test:unit --workspace=@platform/tests # unit/integration tests
```

The test stack uses PostgreSQL `5434`, Redis `6380`, Mailpit SMTP `1026`, and
Mailpit UI `8026`. `.env.test` selects the non-delivering `log` transport so
live-key persona tests exercise queue/worker completion without contacting an
external SMTP server.

The dependency lock includes the Windows Rolldown and Rollup native bindings
explicitly so that `npm ci` can start Vitest and build the admin console on
supported Windows x64 development hosts.

See [Testing](docs/TESTING.md), [Test infrastructure](docs/TEST_INFRA_SETUP.md),
and the [Persona feature matrix](docs/testing/PERSONA_FEATURE_MATRIX.md).

## Security and tenant boundaries

- PostgreSQL RLS is fail-closed and tested with a non-superuser,
  non-`BYPASSRLS` role.
- Customer API keys are hashed, scoped, typed as live/test, and isolated from
  admin sessions.
- Admin roles are `support < operator < admin < superadmin`; privileged
  mutations are audited.
- Cookie-authenticated admin mutations enforce CSRF, Origin, and fetch-metadata
  checks; bearer sessions remain available for operations tooling.
- Webhooks use HMAC signatures, rotation, SSRF controls, and retry history.
- SMTP submission has bounded clients, recipients, messages/connection,
  source-IP limits, and plan-aware distributed customer limits.
- Attachment validation blocks executable signatures and can require ClamAV.
- Retention and privacy jobs use bounded batches and honor legal holds.
- CI runs production dependency auditing, SBOM generation, SQL ordering checks,
  and HIGH/CRITICAL Trivy image scans.

Development defaults are intentionally not production secrets. Replace every
credential and enable the production controls described in
`.env.production.example` before deployment.

## Build and production checks

```bash
npm run build --workspaces --if-present
npm run prod:check
```

Deployment options:

- `docker-compose.production.yml` for a single-node deployment.
- `infra/helm/mail-platform` for Kubernetes.
- `DELIVERY_TRANSPORT=ses` for managed SMTP reputation.
- Haraka direct-to-MX or smarthost operation when you control port 25, PTR,
  warmup, and reputation.

Start with [Enterprise deployment](docs/ENTERPRISE_DEPLOYMENT.md),
[Architecture](docs/ARCHITECTURE.md), [DNS setup](docs/DNS_SETUP.md), and
[HA/DR](docs/HA_DR.md).

## Documentation index

- [API guide](docs/API.md) and [API reference](docs/api-reference.md)
- [SDK](docs/SDK.md)
- [Workflows](docs/WORKFLOWS.md)
- [Billing](docs/BILLING.md)
- [Support](docs/SUPPORT.md)
- [SCIM](docs/SCIM.md)
- [Consent ledger](docs/CONSENT_LEDGER.md)
- [Legal holds](docs/LEGAL_HOLD.md)
- [Compliance posture and evidence](docs/COMPLIANCE_POSTURE.md)
- [Compliance implementation plan](docs/COMPLIANCE_IMPLEMENTATION_PLAN.md)
- [Retention and disposal](docs/RETENTION_AND_DISPOSAL.md)
- [Processor/vendor register](docs/VENDOR_REGISTER.md)
- [Security and compliance guide](docs/guides/security-compliance.md)
- [Storage](docs/STORAGE.md)
- [Audit hash chain](docs/AUDIT_HASH_CHAIN.md)
- [ClickHouse durability](docs/CLICKHOUSE_DURABILITY.md)
- [Failure taxonomy](docs/FAILURE_TAXONOMY.md)
- [SMTP relay guide](docs/guides/smtp-relay.md)

## Honest production assessment

The repository implements and tests the application controls described above.
It cannot manufacture real-world operational evidence. Before public production
traffic, complete these external steps:

1. Run production-sized load, retention, and million-row scale benchmarks.
2. Deploy and monitor ClamAV with signature updates and fail-closed policy.
3. Warm sending domains and IPs and collect 30-90 days of reputation,
   complaint, bounce, and inbox-placement evidence.
4. Exercise PostgreSQL/Redis failover and restore with measured RPO/RTO.
5. Complete penetration testing and required SOC 2/privacy evidence.
6. Validate SCIM/SSO and WebAuthn behavior with the selected production IdPs.
7. For ePHI, complete a HIPAA risk analysis, execute all required BAAs, validate
   production safeguards, and establish breach, access-review, training, and
   contingency procedures before using the platform for PHI.

## License

Released as a reference implementation. Use, modify, and ship it according to
your organization's legal and compliance requirements.
