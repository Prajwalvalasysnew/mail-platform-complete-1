# Mail Platform

A self-hosted, multi-tenant transactional email platform with REST, SMTP, and
SendGrid-compatible sending; background delivery workers; tracking; billing;
automation; customer and admin APIs; and operational tooling.

The repository is a TypeScript monorepo built with Fastify, PostgreSQL, Redis,
BullMQ, Haraka, ClickHouse, React, and Docker.

## Current validation status

- 927 automated tests: 545 unit/integration and 382 end-to-end.
- Free, Paid Pro, and Enterprise persona journeys are covered.
- 73 PostgreSQL migration files are tracked; the latest is `074`
  (the historical sequence intentionally has no `036` file).
- Production workspace builds pass.
- Production dependency audit reports no high/critical vulnerabilities.
- CI scans production container images with Trivy.

This describes code-level readiness. Production operation still requires live
IP/domain warmup, reputation evidence, backup and failover drills on the target
infrastructure, production load testing, ClamAV deployment, and an independent
security/compliance assessment. See [Production checklist](docs/PRODUCTION_CHECKLIST.md)
and [Operational drills](docs/OPERATIONAL_DRILLS.md).

## Feature catalogue

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
| Privacy and compliance | Recipient export/erasure, downloadable exports, body/object-store deletion, queue tombstones, legal holds, retention sweeps, DMARC retention, consent ledger, and tenant-safe deletion |
| Audit | Tenant hash chains, integrity verification, retention-safe archive, Ed25519 checkpoints, WORM export, and admin mutation audit records |
| Support and trust | Customer support tickets/messages/CSAT, admin support inbox, notes, SLA/triage helpers, abuse review queue, KYC decisions, customer suspension, and DLQ replay/purge |
| Admin console | Fleet overview, tenant management, deliverability/IP pools, support, abuse, KYC, audit, billing events, payment gateways, platform settings, retention controls, and admin team management |
| Observability | Health/readiness endpoints, `mp_` Prometheus metrics, Grafana dashboards, Alertmanager rules, Jaeger/OpenTelemetry integration, and sensitive-data log/trace redaction |
| Deployment and operations | Development and production Compose files, Helm chart, migration job, backup/restore and Redis failover drills, k6 scenarios, SBOM generation, dependency audit, and Trivy image scanning |
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
| Billing plan | `free` | `pro` | `enterprise` |

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

These are API/service E2E tests using real infrastructure. The admin console has
build/type checks and its backend flows are covered, but a separate browser
Playwright suite is not currently claimed.

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
- Node.js 20+ and npm for local development and tests.
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
| Prometheus | <http://localhost:9090> | Metrics, monitoring profile |
| Grafana | <http://localhost:3002> | Dashboards, monitoring profile |
| Alertmanager | <http://localhost:9093> | Alert routing, monitoring profile |
| Jaeger | <http://localhost:16686> | Trace UI, monitoring profile |
| ClickHouse HTTP | `localhost:8123` | Analytics, analytics profile |

Start optional monitoring/analytics services with the applicable Compose
profiles defined in `docker-compose.yml`.

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
the local capture transport is configured.

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

## License

Released as a reference implementation. Use, modify, and ship it according to
your organization's legal and compliance requirements.
