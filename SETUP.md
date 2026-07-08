# Mail Platform — Complete Project (audited & hardened)

This is the full project source with all audit fixes applied. `node_modules/` and
build output (`dist/`) are excluded to keep the archive small — restore them with
the steps below.

## What's included

- Full monorepo source: `packages/{shared,api,worker,tracker,sdk,docs}/src`
- All 33 SQL migrations: `infra/migrations/`
- Infra: Helm chart, k8s manifests, Prometheus config, docker-compose
- Complete test suite: `packages/tests/` (509 tests, all green at packaging time)
- Audit deliverables (read these first):
  - `FIX_SUMMARY.md` — one-page table of every bug/hardening fix
  - `AUDIT_REPORT.md` — detailed findings
  - `PRODUCTION_READINESS_ROADMAP.md` — gap analysis + path to production
  - `LOAD_TEST_FINDINGS.md` — throughput numbers + bottleneck analysis

## Setup

Prereqs: Node 20+, Postgres 16, Redis.

```bash
# 1. Install dependencies (restores node_modules)
npm install

# 2. Configure environment
cp .env.example .env        # then edit secrets (JWT_SECRET, ENCRYPTION_KEY, etc.)

# 3. Build all packages
npm run build

# 4. Apply database migrations
npm run migrate

# 5. Run the test suite (needs Postgres + Redis running; see .env.test)
cd packages/tests && npx vitest run
```

For local infra, `docker-compose.yml` brings up Postgres + Redis + the services.

## Notes from the audit

- **RLS rollout (important):** the cross-tenant Row-Level Security mechanism is in
  place (`withTenant()` + `rlsIsEnforced()`), but for it to actually enforce, run
  the API under a dedicated **non-BYPASSRLS** Postgres role. See the RLS section in
  `PRODUCTION_READINESS_ROADMAP.md`.
- `.env` was intentionally excluded (it held secrets). Start from `.env.example`.
- The remaining distance to "SendGrid-grade" is operational/deliverability work
  (HA infra, IP warmup, FBL enrollment, load validation, pen test) — detailed as
  Phases 2–4 in the roadmap.
