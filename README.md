# Mail Platform

> **Phase 2–4 status:** complete. Phase 1 (correctness/safety) was already done. This revision adds scale (atomic quotas, body offload, ClickHouse), deliverability (reputation guard, blocklist monitoring, per-IP warmup, DKIM rotation), trust (Bayesian classifier, list-quality scoring, KYC tiers, GDPR delete, admin authz plane), and production polish (CI, k8s, runbooks, OpenAPI, k6). See `docs/PRODUCTION_CHECKLIST.md` for the per-section status.

## What's new in this revision

| Capability | Module / file |
|---|---|
| Atomic daily+monthly quota counters | `packages/shared/src/quota.ts` |
| Bayesian classifier + URL reputation | `packages/shared/src/classifier.ts` |
| List-quality scoring (suppression import) | `packages/shared/src/listquality.ts` |
| Reputation guard, blocklist monitor, per-IP warmup | `packages/shared/src/reputation.ts` |
| DKIM selector rotation lifecycle | `packages/shared/src/dkim-rotation.ts` |
| Soft-bounce escalation | `packages/shared/src/softbounce.ts` |
| DSN/ARF parser (testable) | `packages/shared/src/dsn.ts` |
| Fast HMAC API-key verify + test/publishable keys | `packages/shared/src/apikeys.ts` |
| Admin authz plane (OIDC, roles, audit) | `packages/shared/src/admin.ts` + `packages/api/src/routes/admin.ts` |
| KMS-pluggable encryption | `packages/shared/src/kms.ts` |
| Body offload to S3 | `packages/shared/src/storage.ts` |
| Event firehose to ClickHouse | `packages/shared/src/clickhouse.ts` + `infra/clickhouse/init.sql` |
| Tracked migration runner | `packages/shared/src/migrate.ts` + `npm run migrate -w @platform/shared` |
| Billing lifecycle + metering reconciliation | `packages/shared/src/billing.ts` |
| OpenAPI 3.1 spec | `GET /openapi.json` (source: `packages/shared/src/openapi.ts`) |
| GDPR recipient deletion | `POST /v1/privacy/delete-recipient` |
| CSRF token on unsubscribe + RFC 8058 one-click | `packages/tracker/src/server.ts` |
| CI pipeline + SBOM + k6 load test | `.github/workflows/ci.yml`, `infra/loadtest/send.js` |
| K8s manifests (HPA + PDB + CronJobs) | `infra/k8s/` |
| Operational runbooks | `docs/runbooks/` |
| Grafana dashboard | `infra/grafana/dashboards/mail-platform.json` |

Test count: **239 tests passing** across 36 suites — unit suites plus a full
**end-to-end** layer (`packages/tests/e2e/`) that boots the real Fastify API and
BullMQ send worker against live Postgres + Redis and drives the complete send
pipeline over HTTP (auth, scopes, validation, quota, idempotency, suppression,
abuse, templating, resource CRUD, signup). Run all tests with `npm test`, or just
the end-to-end layer with `npm run test:e2e`. See
[`docs/TESTING.md`](docs/TESTING.md).


A self-hosted, multi-tenant transactional email platform — a SendGrid-style service
you can run yourself. Built with Node.js, TypeScript, Fastify, Haraka, BullMQ,
PostgreSQL, and Redis.

> **What this is:** a working, runnable skeleton that demonstrates the real
> architecture of a transactional email provider. About 30 source files, ~2500
> lines of code.
>
> **What this is not:** a turnkey SendGrid replacement. Production deployment
> requires real secrets, real IPs with PTR records, DNS configuration, IP
> warming, ISP postmaster registrations, and abuse-prevention engineering.
> Start with [`docs/ENTERPRISE_DEPLOYMENT.md`](docs/ENTERPRISE_DEPLOYMENT.md),
> then use [`docs/PRODUCTION_CHECKLIST.md`](docs/PRODUCTION_CHECKLIST.md) as
> the detailed readiness checklist.

---

## Architecture at a glance

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│  REST API   │───▶│   BullMQ     │───▶│  Haraka      │───▶ Internet
│ (Fastify)   │    │  (Redis)     │    │  (outbound)  │
└─────────────┘    └──────────────┘    └──────────────┘
       │                  ▲                    ▲
       ▼                  │                    │
┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│ PostgreSQL  │◀───│   Workers    │◀───│   Haraka     │
└─────────────┘    │ send/events/ │    │  (inbound:   │
       ▲           │  webhooks    │    │   bounces +  │
       │           └──────────────┘    │   FBLs)      │
       │                                └──────────────┘
       │                  ▲
       │                  │
┌─────────────┐           │
│  Tracker    │───────────┘
│ opens/clicks│  events
│ unsub       │
└─────────────┘
```

Six services, one repo:

| Package | What it does |
|---|---|
| `packages/api` | Fastify REST API — auth, send endpoint, domains, suppressions, messages, webhooks |
| `packages/worker` | Three BullMQ workers — send (queue → Haraka), events (status updates + suppression), webhooks (HMAC-signed delivery) |
| `packages/tracker` | Open pixel, click redirect, RFC 8058 one-click unsubscribe, open/click bot detection (Apple MPP / scanner / prefetch filtering) |
| `packages/haraka-outbound` | Outbound MTA with custom DKIM signing per customer domain and event emission |
| `packages/haraka-inbound` | Inbound MTA — parses DSNs (bounces) and ARF (feedback loop complaints) |
| `packages/shared` | DB connection (Kysely), queues, Redis, suppression cache, crypto utils, types |

---

## Prerequisites

- Docker + Docker Compose
- Node.js 20+ (only needed if running outside Docker)
- For real sending: a server with static IPs, DNS control, and the ability to set PTR records

---

## Quick start (local development)

```bash
# 1. Copy environment template
cp .env.example .env

# 2. Boot the full stack
docker compose up -d --build

# 3. Wait ~20 seconds for Postgres + migrations to settle, then check health
curl http://localhost:3000/health
# {"status":"ok","ts":"..."}

# 4. Create a customer and get an API key via signup
curl -X POST http://localhost:3000/v1/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "name": "Test"}'

# Response:
# {
#   "customer": { "id": "...", "email": "...", "tier": "free", "daily_quota": 100 },
#   "api_key": "mp_live_xxxxxxxxxxxxxxxxxxxxxx",
#   "note": "Save this API key — it will not be shown again."
# }

# 5. Register a sending domain (returns DNS records to add)
curl -X POST http://localhost:3000/v1/domains \
  -H "Authorization: Bearer mp_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain": "send.yourdomain.com"}'

# 6. Add the returned DNS records to your domain's DNS, wait for propagation

# 7. Verify the domain
curl -X POST http://localhost:3000/v1/domains/DOMAIN_ID/verify \
  -H "Authorization: Bearer mp_live_YOUR_KEY"

# 8. Send mail
curl -X POST http://localhost:3000/v1/send \
  -H "Authorization: Bearer mp_live_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "hello@send.yourdomain.com",
    "to": "recipient@example.com",
    "subject": "Hello from your own email platform",
    "html": "<h1>It works!</h1><p>This was sent through your platform.</p>"
  }'
```

---

## Services and ports

When `docker compose up` is running:

| Service | URL / Port | Purpose |
|---|---|---|
| API | `http://localhost:3000` | REST API |
| Tracker | `http://localhost:4000` | Opens, clicks, unsubscribes |
| Haraka outbound | `localhost:2525` | SMTP relay for the worker |
| Haraka inbound | `localhost:2526` (→ 25) | Bounce/FBL ingestion |
| Postgres | `localhost:5432` | Database |
| Redis | `localhost:6379` | Queue, cache, rate limit |
| Prometheus | `http://localhost:9090` | Metrics (start with `--profile monitoring`) |
| Grafana | `http://localhost:3001` | Dashboards — login `admin` / `admin` (start with `--profile monitoring`) |

---

## Monitoring (Prometheus + Grafana)

Metrics and dashboards are bundled but live behind a Docker Compose profile so
they don't run unless you ask for them. To start the full stack **with**
monitoring:

```bash
docker compose --profile monitoring up -d --build
```

Then:

- **Grafana** → http://localhost:3001 (login `admin` / `admin`). The
  *Mail Platform — Operational Overview* dashboard is auto-provisioned, with the
  Prometheus datasource already wired up. Panels include send/delivery rates,
  bounce & complaint rates by IP pool, queue depth, API latency, blocklist
  status, dead-letter counts, and **open/click engagement split by bot-detection
  verdict** (human / bot / suspicious).
- **Prometheus** → http://localhost:9090 (use the Graph or Alerts tab). It
  scrapes `/metrics` on the API (`:3000`), worker (`:9100`), and tracker
  (`:4000`) every 15s, and loads the alert rules in
  `infra/prometheus/alerts.yml`.

All app metrics are prefixed `mp_` (e.g. `mp_messages_delivered_total`,
`mp_engagement_events_total{verdict="bot"}`, `mp_send_duration_seconds`). You can
hit any service's `/metrics` directly, e.g. `curl http://localhost:3000/metrics`.

If you start the stack without the profile, the app runs normally and simply
isn't scraped — no monitoring containers are launched.

## API reference

Developer guides (getting started, webhooks, errors, deliverability, ...) live in [`docs/guides/`](docs/guides/). Full endpoint reference in [`docs/API.md`](docs/API.md). Key endpoints:

- `POST /v1/signup` — create customer (public)
- `POST /v1/send` — send an email
- `POST /v1/domains` — register a sending domain (returns DNS records)
- `POST /v1/domains/:id/verify` — re-check DNS records
- `GET  /v1/messages` — list sent messages with status
- `GET  /v1/messages/:id` — detailed event timeline for one message
- `GET  /v1/suppressions` — list suppressed recipients
- `POST /v1/webhooks` — subscribe to delivery events

All routes (except `/v1/signup` and `/health`) require `Authorization: Bearer mp_live_…`.

---

## Project layout

```
mail-platform/
├── docker-compose.yml          # Full stack orchestration
├── package.json                # npm workspaces root
├── tsconfig.base.json          # Shared TS config
├── .env.example                # Copy to .env
├── infra/
│   ├── migrations/001_init.sql # Database schema
│   └── dkim/                   # Generated DKIM keys (gitignored)
├── packages/
│   ├── shared/                 # @platform/shared - DB, queues, types
│   ├── api/                    # @platform/api - Fastify REST API
│   ├── worker/                 # @platform/worker - BullMQ workers
│   ├── tracker/                # @platform/tracker - tracking server
│   ├── haraka-outbound/        # Outbound MTA + custom plugins
│   └── haraka-inbound/         # Inbound MTA for bounces
├── scripts/
│   ├── seed.ts                 # Seed a test customer
│   └── generate-dkim.sh        # Generate DKIM keypairs
└── docs/
    ├── ARCHITECTURE.md
    ├── API.md
    ├── DNS_SETUP.md
    └── PRODUCTION_CHECKLIST.md
```

---

## How email actually flows through the system

**Sending an email:**

1. Customer hits `POST /v1/send` with an API key
2. API validates: API key → customer, sender domain verified, recipient not suppressed, daily quota OK
3. API inserts a row into `messages` and enqueues a job in BullMQ (`send` queue)
4. The send worker picks up the job, renders tracking pixels/links, builds VERP return-path,
   adds `List-Unsubscribe` headers, hands the message to Haraka via authenticated SMTP
5. Haraka's `customer_dkim` plugin looks up the customer's DKIM private key from Postgres
   and signs the message
6. Haraka's `header_cleanup` plugin strips internal `X-MP-*` headers
7. Haraka delivers to the recipient's MX server (or queues for retry)
8. Haraka's `event_emitter` plugin pushes a `delivered`/`deferred`/`bounce` event to BullMQ
9. The event worker updates the message status and fans out to subscribed customer webhooks
10. If the recipient opens or clicks, the tracker server records the event

**Receiving a bounce:**

1. Recipient MX server can't deliver and sends a DSN back to the VERP return-path
   (`bounce+<encoded-message-id>@bounces.yourdomain.com`)
2. Haraka inbound accepts the DSN
3. `bounce_parser` plugin extracts the original Message-ID from the VERP address,
   parses the DSN body (Status, Diagnostic-Code), classifies hard vs soft
4. Pushes a `hard_bounce` or `soft_bounce` event
5. Event worker auto-adds hard-bounced recipients to the customer's suppression list

**Receiving a complaint (FBL):**

1. User clicks "Mark as Spam" in Gmail/Outlook/Yahoo
2. The ISP sends an ARF report to your registered FBL address
3. `bounce_parser` parses the ARF, extracts the original Message-ID
4. Event worker auto-suppresses the recipient and updates message status

---

## Development without Docker

If you want hot-reload during development:

```bash
# Terminal 1: deps in Docker
docker compose up -d postgres redis haraka-outbound haraka-inbound

# Run tracked migrations once
DATABASE_URL=postgresql://mail:mailpass@localhost:5432/mail_platform npm run migrate

# Install workspace deps
npm install

# Build the shared package first
npm run build --workspace=@platform/shared

# Terminal 2: API
npm run dev:api

# Terminal 3: Worker
npm run dev:worker

# Terminal 4: Tracker
npm run dev:tracker
```

---

## Customizing the platform domain

In production, change these `.env` values:

```bash
PLATFORM_DOMAIN=yourdomain.com
BOUNCE_DOMAIN=bounces.yourdomain.com
TRACKING_DOMAIN=https://track.yourdomain.com
```

Also update:
- `packages/haraka-outbound/config/me` — your MTA hostname (must match PTR record)
- `packages/haraka-inbound/config/me` — your bounce MTA hostname
- `packages/haraka-inbound/config/host_list` — add your real bounce + FBL domains

---

## Honest assessment of what's missing for production

This skeleton gets you about 30% of the way to a production transactional email
provider. The remaining 70% is:

- **IP warming** — fresh IPs send <100/day on day 1, ramping over weeks
- **ISP postmaster registration** — Google Postmaster Tools, Microsoft SNDS/JMRP, Yahoo CFL
- **Abuse detection** — content scanning, anomaly detection, automatic quarantining
- **Per-IP reputation tracking** — pause sending on a hot IP automatically
- **Admin dashboard / customer UI** — none included; API only
- **Observability stack** — Prometheus, Grafana, alerting on bounce/complaint rates
- **Multi-region deployment** — single-region docker-compose included
- **Comprehensive tests** — core subsystems now covered (239 tests, incl. open/click bot detection, migration runner coverage, and OpenAPI contract checks); load/chaos/soak testing still needed

> **Note:** DKIM keys are encrypted at rest (AES-256-GCM), API-key scopes are
> enforced, DKIM signing uses the `mailauth` library and fails closed, VERP
> bounce tokens are HMAC-signed, and `POST /v1/send` supports idempotency keys.
> See `docs/PRODUCTION_CHECKLIST.md` for the full status.

See [`docs/PRODUCTION_CHECKLIST.md`](docs/PRODUCTION_CHECKLIST.md) for the full punch list.

---

## License

Released as a reference implementation. Use, modify, and ship it however you want.
