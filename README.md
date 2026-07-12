# Mail Platform

A self-hosted, multi-tenant transactional email platform — a SendGrid-style
service you can run yourself. Node.js, TypeScript, Fastify, Haraka, BullMQ,
PostgreSQL, Redis, and ClickHouse.

> **Status:** the codebase is production-grade and CI-green — **719 tests across
> 112 suites**, 0 high/critical dependency CVEs, container image scans clean, and
> 61 tracked migrations. What remains before it is *operationally* equivalent to
> a hosted ESP is real-world evidence that can only be earned on live
> infrastructure: sending-IP warmup and reputation history, disaster-recovery
> drills with measured RPO/RTO, and external security/compliance attestation.
> See [`docs/PRODUCTION_CHECKLIST.md`](docs/PRODUCTION_CHECKLIST.md) and
> [`docs/OPERATIONAL_DRILLS.md`](docs/OPERATIONAL_DRILLS.md).

---

## What's in the box

| Area | Highlights | Where |
|---|---|---|
| **Send pipeline** | Transactional send outbox, atomic daily+monthly quota reservation, idempotency keys, per-recipient fan-out, template rendering, click/open injection | `packages/api/src/routes/send.ts`, `packages/worker/src/send-worker.ts`, `packages/shared/src/{quota,outbox,templates}.ts` |
| **Multi-tenant isolation** | Fail-closed Postgres **row-level security** with per-request tenant context; non-superuser app role that cannot bypass RLS | migration `043_rls_fail_closed`, `packages/shared/src/tenant-context.ts` |
| **Deliverability** | Reputation guard (auto-throttle/pause), blocklist monitor, per-IP **warmup** schedule, DKIM selector rotation wired to the live Haraka signer, DSN/ARF parsing, failure taxonomy, open/click **bot detection** (Apple MPP / scanners / prefetch) | `packages/shared/src/{reputation,warmup,dkim-rotation,dsn,failure-taxonomy,bot-detection}.ts` |
| **Billing** | Governed plan catalog + entitlements, dunning, invoices with line items + **tax** + **credit notes/refunds**, Stripe-native proration, plan-change lifecycle with missing-webhook reconciliation; Stripe / official-PayPal / Cashfree webhook verification | `packages/shared/src/billing.ts`, `packages/api/src/routes/{billing,account-billing}.ts` |
| **Privacy / GDPR** | Durable erasure across Postgres, body storage, ClickHouse and BullMQ/DLQ; worker **tombstones**; legal hold; consent ledger | `packages/shared/src/{privacy-erasure,legal-hold,suppression}.ts` |
| **Tamper-evident audit** | Per-tenant hash chain, retention-safe archive, and **Ed25519-signed checkpoints exported to a WORM sink** | `packages/shared/src/{audit,audit-worm}.ts` |
| **Enterprise identity** | Admin RBAC + OIDC + TOTP, SCIM 2.0 provisioning, **customer SSO enforcement**, **JIT admin elevation + break-glass**, **WebAuthn / passkeys** | `packages/shared/src/{admin,admin-jit,scim,sso,webauthn}.ts` |
| **Analytics** | Event firehose to ClickHouse with **exactly-once dedup** (ReplacingMergeTree keyed on a shared idempotency key + `uniqExact` rollup) and durable watermark reconciliation | `packages/shared/src/{clickhouse,clickhouse-reconcile}.ts`, `infra/clickhouse/init.sql` |
| **Observability & safety** | `mp_`-prefixed Prometheus metrics, Grafana dashboard, Alertmanager rules, central log + trace redaction | `infra/{prometheus,grafana,alertmanager}` |
| **Ops tooling** | Docker prod compose, Helm chart, and *runnable* drills: Helm render check, Redis failover, Postgres backup/restore (with RTO), k6 load scenarios | `docker-compose.production.yml`, `infra/helm/`, `scripts/`, `infra/loadtest/` |
| **Developer surface** | OpenAPI 3.1 spec with route-parity + breaking-change guards, a typed SDK, stable error-code registry | `GET /openapi.json`, `packages/sdk`, `packages/shared/src/error-codes.ts` |

Run everything with `npm test`, or just the HTTP end-to-end layer with
`npm run test:e2e`. See [`docs/TESTING.md`](docs/TESTING.md).

---

## Architecture at a glance

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│  REST API   │───▶│   BullMQ     │───▶│  Haraka      │───▶ Internet
│ (Fastify)   │    │  (Redis)     │    │  (outbound)  │      (direct MX
└─────────────┘    └──────────────┘    └──────────────┘       or relay)
       │                  ▲                    ▲
       ▼                  │                    │
┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│ PostgreSQL  │◀───│   Workers    │◀───│   Haraka     │
│  (+ RLS)    │    │ send/events/ │    │  (inbound:   │
└─────────────┘    │  webhooks    │    │   bounces +  │
       │           └──────────────┘    │   FBLs)      │
       ▼                                └──────────────┘
┌─────────────┐    ┌──────────────┐
│  ClickHouse │◀───│   Tracker    │  opens / clicks / unsubscribe
│ (analytics) │    │              │
└─────────────┘    └──────────────┘
```

One repo, these packages:

| Package | What it does |
|---|---|
| `packages/api` | Fastify REST API — auth, send, domains, suppressions, messages, webhooks, billing, admin, privacy, support |
| `packages/worker` | BullMQ workers — send (queue → Haraka), events (status + suppression), webhooks (HMAC-signed delivery), plus scheduler jobs (retention, warmup, reputation, audit checkpoints, billing dunning/reconcile) |
| `packages/tracker` | Open pixel, click redirect, RFC 8058 one-click unsubscribe, bot detection |
| `packages/haraka-outbound` | Outbound MTA — per-customer DKIM signing, event emission, internal-header cleanup |
| `packages/haraka-inbound` | Inbound MTA — parses DSNs (bounces) and ARF (FBL complaints) |
| `packages/shared` | DB (Kysely), queues, Redis, crypto, billing, audit, identity, analytics, storage — the domain core |
| `packages/sdk` | Typed client SDK (used by the e2e suite and consumers) |
| `packages/tests` | Unit + HTTP end-to-end suites |

---

## Prerequisites

- Docker + Docker Compose
- Node.js 20+ (only needed if running outside Docker)
- For real sending: a host that allows outbound **port 25** and lets you set
  **reverse DNS (PTR)**, plus DNS control. (Most big clouds block port 25 — see
  [`docs/ENTERPRISE_DEPLOYMENT.md`](docs/ENTERPRISE_DEPLOYMENT.md).)

---

## Quick start (local development)

```bash
# 1. Copy environment template
cp .env.example .env

# 2. Boot the full stack
docker compose up -d --build

# 3. Wait for Postgres + migrations to settle, then check health
curl http://localhost:3000/health

# 4. Create a customer and API key via signup
curl -X POST http://localhost:3000/v1/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "name": "Test"}'

# 5. Register a sending domain (returns DNS records to add)
curl -X POST http://localhost:3000/v1/domains \
  -H "Authorization: Bearer mp_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain": "send.yourdomain.com"}'

# 6. Add the returned DNS records, wait for propagation, then verify
curl -X POST http://localhost:3000/v1/domains/DOMAIN_ID/verify \
  -H "Authorization: Bearer mp_live_YOUR_KEY"

# 7. Send
curl -X POST http://localhost:3000/v1/send \
  -H "Authorization: Bearer mp_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "hello@send.yourdomain.com",
    "to": "recipient@example.com",
    "subject": "Hello from your own email platform",
    "html": "<h1>It works!</h1>"
  }'
```

---

## Services and ports

| Service | URL / Port | Purpose |
|---|---|---|
| API | `http://localhost:3000` | REST API |
| Tracker | `http://localhost:4000` | Opens, clicks, unsubscribes |
| Haraka outbound | `localhost:2525` | SMTP relay for the worker |
| Haraka inbound | `localhost:2526` (→ 25) | Bounce / FBL ingestion |
| Postgres | `localhost:5432` | Database (RLS-enforced) |
| Redis | `localhost:6379` | Queues, cache, rate limit |
| Prometheus | `http://localhost:9090` | Metrics (`--profile monitoring`) |
| Grafana | `http://localhost:3001` | Dashboards, `admin`/`admin` (`--profile monitoring`) |

Start with monitoring: `docker compose --profile monitoring up -d --build`.
All app metrics are prefixed `mp_` (e.g. `mp_messages_delivered_total`,
`mp_engagement_events_total{verdict="bot"}`). Alert rules live in
`infra/prometheus/alerts.yml`.

---

## Deploying for real

- **Direct-send (own IPs):** run the API/DB/workers anywhere, but run Haraka on a
  host that allows port 25 + rDNS (e.g. Hetzner). Warm your IPs, enroll in Google
  Postmaster / Microsoft SNDS / Yahoo FBL (ingestion is built in), and tighten
  DMARC. Use `docker-compose.production.yml` for a single node or the Helm chart
  under `infra/helm/` at scale.
- **Relay:** point Haraka at an SMTP smarthost, or set `DELIVERY_TRANSPORT=ses`
  for a shared-pool relay with managed reputation.
- Reproducible reliability drills: `scripts/helm-render-check.sh`,
  `scripts/redis-failover-drill.sh`, `scripts/backup-restore-drill.sh`, and the
  k6 scenarios in `infra/loadtest/`. See [`docs/OPERATIONAL_DRILLS.md`](docs/OPERATIONAL_DRILLS.md).

Start with [`docs/ENTERPRISE_DEPLOYMENT.md`](docs/ENTERPRISE_DEPLOYMENT.md) and
the [`docs/`](docs/) set (billing, audit, ClickHouse durability, RLS rollout,
SCIM, storage, and more).

---

## How email flows

**Sending:** `POST /v1/send` → validate (key→customer, domain verified, not
suppressed, quota reserved atomically, idempotency) → persist + enqueue → send
worker renders tracking/VERP/List-Unsubscribe and hands off to Haraka →
`customer_dkim` signs → `header_cleanup` strips internal `X-MP-*` headers →
delivery → `event_emitter` pushes delivered/deferred/bounce → event worker
updates status, fans out to webhooks, dual-writes analytics to ClickHouse.

**Bounces:** recipient MX returns a DSN to the signed VERP return-path → Haraka
inbound parses it → hard bounces auto-suppress.

**Complaints (FBL):** ISP sends an ARF report to your feedback address → parsed →
recipient auto-suppressed.

---

## Development without Docker

```bash
docker compose up -d postgres redis haraka-outbound haraka-inbound
DATABASE_URL=postgresql://mail:mailpass@localhost:5432/mail_platform npm run migrate
npm install
npm run build --workspace=@platform/shared
npm run dev:api      # + dev:worker, dev:tracker in other terminals
```

---

## Project layout

```
mail-platform/
├── docker-compose.yml               # dev stack
├── docker-compose.production.yml    # single-node production
├── infra/
│   ├── migrations/                  # 61 tracked SQL migrations (001…061)
│   ├── clickhouse/init.sql          # analytics schema (dedup engine)
│   ├── helm/mail-platform/          # Kubernetes chart (HPA, PDB, network policies)
│   ├── prometheus/ · grafana/ · alertmanager/
│   └── loadtest/                    # k6 scenarios (send, tracker)
├── packages/
│   ├── shared/ api/ worker/ tracker/ sdk/ tests/
│   ├── haraka-outbound/ · haraka-inbound/
├── scripts/                         # DKIM gen, backup/restore, redis-failover, helm-render drills
└── docs/                            # architecture, billing, audit, SCIM, deployment, drills, …
```

---

## Honest assessment

The **code and tooling** are strong and fully tested; the gap to a
production-operated ESP is not more code but **live operational and compliance
evidence** that has to be earned on real infrastructure:

- **Deliverability history** — 30–90 days of IP/domain warmup, sender reputation,
  complaint/bounce data, and inbox-placement results.
- **HA / DR proof** — automatic Postgres/Redis failover and restore drills with
  measured RPO/RTO on production-sized data (drill scripts are included and run
  locally; the numbers must be produced against your infra).
- **Security & compliance** — external penetration test and SOC 2 evidence;
  WebAuthn attestation-chain trust; SCIM interoperability certification with real
  IdPs.

Everything above is enumerated in
[`docs/PRODUCTION_CHECKLIST.md`](docs/PRODUCTION_CHECKLIST.md) and
[`docs/OPERATIONAL_DRILLS.md`](docs/OPERATIONAL_DRILLS.md).

---

## License

Released as a reference implementation. Use, modify, and ship it however you want.
