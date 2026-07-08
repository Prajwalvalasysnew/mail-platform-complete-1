# Testing

The platform has two test layers, both run by [Vitest](https://vitest.dev) from
the `@platform/tests` package.

## Layers

**Unit & integration tests** (`packages/tests/*.test.ts`) — isolated logic and
single-subsystem behavior. Pure-function suites (no external services): API-key
hashing, the Bayesian/abuse classifier, DSN/ARF parsing, the inbound Haraka
bounce/complaint parser (incl. forged-VERP rejection), VERP token signing,
envelope encryption, KMS providers, warmup math, Handlebars template rendering
and injection-escaping, the open/click bot-detection classifier (machine UAs,
datacenter IP CIDRs, prefetch timing, click-without-open), OpenAPI shape, and the
production config guard. Integration suites (require live Postgres + Redis):
atomic quota reservation (incl. concurrent no-oversell), the suppression list,
soft-bounce escalation, the reputation auto-pause/throttle guard, and end-to-end
bot detection through the real event worker (human vs machine open/click
routing).

**End-to-end tests** (`packages/tests/e2e/*.e2e.test.ts`) — boot the *real*
Fastify API (the same route modules used in production) and the real BullMQ send
worker against a live **Postgres** and **Redis**, then drive the full pipeline
over HTTP using Fastify's `inject`. Test-mode API keys (`mp_test_…`) route the
send worker to the sandbox transport, so the entire pipeline runs — quota
reservation, abuse scanning, suppression filtering, queueing, the worker, status
transitions, usage accounting, and the event trail — without any real SMTP
delivery.

E2E coverage includes:

- **Send pipeline** — accept → queue → worker → `accepted`, multi-recipient
  fan-out, click-link rewriting and open-pixel injection, usage + event trail.
- **Auth & validation** — missing/malformed/unknown keys, scope enforcement,
  domain registration/verification gates, body validation, suspended accounts,
  and public signup issuing a key that authenticates immediately.
- **Quota** — daily-limit rejection (429) and incremental consumption.
- **Idempotency** — replay of a stored response for a repeated `Idempotency-Key`,
  and 422 conflict when a key is reused with a different body.
- **Suppression** — suppressed recipients are filtered; all-suppressed returns
  `accepted: 0`.
- **Abuse** — obvious spam is blocked (422) or held for review.
- **Resources** — domain, suppression, and template CRUD, plus a
  template-driven send with variable substitution.

- **Migrations** - fresh temporary DBs apply all migrations through the tracked
  runner, and raw-SQL initialized DBs can be baselined without replaying files.
- **OpenAPI contract** - verifies the public send/activity/privacy surfaces plus
  the customer support ticket paths and human-session auth scheme.

## Running

The test suite is self-provisioning: it loads `.env.test` (+ optional
`.env.test.local`) and applies all migrations to the test database
automatically in global setup. You do NOT need a separate manual migrate step
against the correct port.

```bash
# 1. Bring up the ISOLATED test infra (postgres:5434, redis:6380, mailpit).
#    Note: this is docker-compose.test.yml, NOT the dev compose — the ports are
#    offset (5434/6380) so a dev stack on 5432/6379 can run alongside it.
docker compose -f docker-compose.test.yml up -d

# 2. Build the workspace packages (E2E imports their compiled dist, and global
#    setup imports runMigrations from @platform/shared's dist).
npm run build

# 3. Run everything (unit + e2e). Migrations are applied automatically first.
npm test

# Just the end-to-end layer:
npm run test:e2e

# Just the pure-logic unit tests, no database needed:
SKIP_TEST_MIGRATE=1 npm run test:unit
```

Environment variables:
- `SKIP_TEST_MIGRATE=1` — skip the automatic migration step in global setup
  (for callers that provision the schema themselves, or when running only
  non-DB unit tests without any Postgres available).

Tearing down:
```bash
docker compose -f docker-compose.test.yml down -v
```

### Manual migration (only if you are NOT using the test compose)

If you point `DATABASE_URL` at your own Postgres instead of the test compose,
the automatic migration still runs against whatever `DATABASE_URL` resolves to.
To migrate manually against an arbitrary database:

```bash
node packages/shared/dist/bin/migrate.js infra/migrations
# Preferred tracked command:
#   npm run migrate
# One-time only for older local DBs initialized by raw SQL before
# schema_migrations was populated:
#   npm run migrate:baseline
```

# Just the unit layer
npm run test:unit
```

Required environment for the E2E layer:

```bash
DATABASE_URL=postgresql://mail:mailpass@localhost:5432/mail_platform
REDIS_HOST=localhost
REDIS_PORT=6379
NODE_ENV=test
JWT_SECRET=<32+ chars>
API_KEY_PEPPER=<32+ chars>
ENCRYPTION_KEY=<64 hex chars>
VERP_SECRET=<16+ chars>
```

## Notes on the test harness

- `packages/tests/e2e/harness.ts` assembles the API exactly like
  `packages/api/src/server.ts` (minus the network `listen`, CORS, and global
  rate-limit plumbing) and starts the real send worker.
- All database access in tests goes through `@platform/shared`'s `testkit`
  helpers (`seedCustomer`, `seedVerifiedDomain`, `waitForStatus`, …). These run
  inside the shared package's compiled module realm so every Kysely query object
  shares one realm — avoiding the cjs/esm dual-package hazard that otherwise
  breaks Kysely's private-field checks under a bundler.
- E2E specs run **serially** (`fileParallelism: false`) because they share one
  live Postgres/Redis and assert on per-customer counters.
