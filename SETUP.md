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

## Website landing page (Next.js, supplied v13 design)

The website is a separate workspace in `packages/landing-page`. It preserves the supplied landing/auth/sales designs; customer onboarding remains in the existing customer workspace.

```powershell
# Local development, separate from API :3000 and customer UI :8080
npm run dev:landing
# http://127.0.0.1:3001

# Docker website (loopback-only :8082); apply migration 104 first
docker compose build api migrate customer-ui
docker compose run --rm --no-deps migrate
docker compose up -d --no-deps api customer-ui
docker compose --profile website up -d --build website
```

The Docker website calls the API internally and hands sign-in/new-account sessions to `http://localhost:8080` using a single-use, 60-second code. The workspace confirms the account before accepting it and preserves MFA. No session bearer/password goes in a URL. Sales requests are stored and visible through the support-protected admin API; notifications/CRM routing are not activated. See `packages/landing-page/README.md` for configuration and release limitations. The original design's metrics/testimonials/certification claims still need business approval before public use.

## Audit notes

- **RLS rollout (important):** the cross-tenant Row-Level Security mechanism is in
  place (`withTenant()` + `rlsIsEnforced()`), but for it to actually enforce, run
  the API under a dedicated **non-BYPASSRLS** Postgres role. See the RLS section in
  `PRODUCTION_READINESS_ROADMAP.md`.
- `.env` was intentionally excluded (it held secrets). Start from `.env.example`.
- The remaining distance to "SendGrid-grade" is operational/deliverability work
  (HA infra, IP warmup, FBL enrollment, load validation, pen test) — detailed as
  Phases 2–4 in the roadmap.
