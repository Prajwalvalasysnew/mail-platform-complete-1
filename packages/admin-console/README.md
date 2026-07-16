# @platform/admin-console

Internal operator console for the mail platform — the **admin plane** UI,
implemented from the confirmed Admin Console design (`Admin Console.dc.html`
in the design handoff) and the frontend architecture contract.

React 18 · TypeScript · Vite · TanStack Router · TanStack Query · Zod.

## Run it

```bash
# 1. start the core API (needs Postgres + Redis; see repo SETUP.md)
npm run dev:api

# 2. create an admin user if you don't have one
npm run create-admin

# 3. start the console (defaults to proxying http://localhost:3000)
npm run dev:admin
# custom API origin:
ADMIN_API_ORIGIN=http://localhost:3000 npm run dev --workspace=@platform/admin-console
```

Open http://localhost:5174 and sign in with the admin credentials. TOTP MFA is
supported in the login flow (`mfa_required` → code step).

`npm run build:admin` type-checks and produces `dist/` (~113 KB gzip JS,
within the 150 KB budget from the architecture doc).

## Architecture decisions (per docs/frontend-architecture)

- **Same-origin gateway paths.** The browser only ever fetches relative
  `/api/*` paths with `credentials: 'same-origin'`. The Vite dev server
  rewrites `/api/*` → `<ADMIN_API_ORIGIN>/admin/*`, mirroring the production
  contract where `admin.<domain>/api/*` → core API `/admin/*` and never
  `/v1/*`. The console has no knowledge of the API origin.
- **Closed operation registry.** Every network call is a named, typed function
  in `src/api/operations.ts` with a fixed method + path. No endpoint is ever
  derived from URL params, hashes, or `postMessage` — the client-side-CSRF
  control from the architecture doc.
- **Identity boundary.** Query keys are prefixed
  `['admin', adminUserId, resource, filters]`; logout/expiry cancels in-flight
  requests, clears the entire query cache, and returns to login. A 401 from
  any call triggers the same purge.
- **Session handling (current backend reality).** The API authenticates admins
  with a bearer session token from `POST /admin/auth/login`. The token is held
  **in memory only** — never in local/session storage, per the storage policy.
  A page reload therefore requires sign-in again until the gateway/identity
  layer implements `__Host-` httpOnly cookie sessions (a release-blocking
  backend prerequisite already tracked in the architecture doc). The request
  layer (`src/lib/http.ts`) is written so the bearer header can be dropped
  with no other changes once cookies land.
- **Role-aware UI.** Roles are `support < operator < admin < superadmin`
  (mirroring `roleAtLeast` on the API). Navigation, actions, and routes render
  permission states client-side for usability; the API remains the enforcement
  point on every request.
- **Destructive actions** (DLQ purge, tenant suspend, retention run) use
  server-confirmed modals with typed confirmation (`PURGE` / `SUSPEND`).
  Sensitive operations are online-only and never optimistic.

## Screens → API map

| Route | Screen | Operations | Min role |
| --- | --- | --- | --- |
| `/` | Fleet overview | `GET /overview`, `GET /review-queue/stats`, `GET /deliverability/pool-health`, `GET /support-tickets/sla-breaches`, `GET /dlq` | support (dlq widget: operator) |
| `/tenants` | Tenants + drawer | `GET /customers`, `GET /customers/:id`, `POST /customers/:id/support-notes`, `PATCH /customers/:id`, `POST /customers/suspend·reinstate` | support / operator / admin |
| `/deliverability` | Deliverability | `GET /deliverability/pool-health`, `GET /reputation/pools`, `POST /deliverability/blocklist-scan` | support (scan: operator) |
| `/pools` | IP pools | `GET /reputation/pools`, `POST /deliverability/blocklist-scan` | support |
| `/support` | Support inbox (3-pane) | `GET/PATCH /support-tickets*`, `POST …/messages·read·triage·suggest-reply`, `GET /support/canned-responses`, `GET /support-tickets/sla-breaches` | support |
| `/abuse` | Abuse queue | `GET /review-queue(+/stats)`, `POST /review-queue/:id/approve·reject`, `POST /review-queue/bulk` | support (actions: operator) |
| `/kyc` | KYC / verification | `GET /customers` (kyc_level) — **read-only, see gaps** | support |
| `/audit` | Audit log | `GET /admin/audit` (+ client CSV export) | admin |
| `/billing` | Billing & metering | `GET /billing-events(+/:id)`, `POST /billing-events/:id/replay`, `POST /billing/reconcile` | operator (replay: admin) |
| `/payments` | Payment gateways | `GET /billing-events` (activity-derived status) — **see gaps** | operator |
| `/settings` | Settings | `POST /retention/run` — other panels read-only, **see gaps** | operator |
| `/team` | Admin team + elevations | `GET/POST/PATCH /admins*`, `GET/POST/DELETE /elevations*`, `POST /elevations/break-glass` | operator (manage: superadmin) |
| `/dlq` | Dead-letter queue | `GET /dlq(+/:id)`, `POST /dlq/:id/replay`, `DELETE /dlq/:id`, `POST /dlq/purge` | operator |

## Backend gaps found during the end-to-end check

Discovered while mapping the confirmed design against the real
`packages/api/src/routes/admin.ts`:

1. **KYC decisions** — the design has Approve / More info / Reject per tenant;
   the API only stores `kyc_level` on customers. Needs `/admin/kyc/*` decision
   endpoints (screen ships read-only with an explanatory banner).
2. **Payment gateway config** — the design has per-gateway Configure modals;
   credentials are env-managed with no `/admin/payment-gateways` API. Screen
   derives Active/Inactive from billing-event activity instead.
3. **Platform settings CRUD** — quotas / bounce thresholds / warmup / security
   panels in the design need a settings API; only the retention runner exists
   (`POST /admin/retention/run`), which is fully wired.
4. **Fleet time series** — the design's 7-day volume chart needs an admin
   timeseries endpoint; `/admin/overview` is 24h aggregates only, so the
   screen charts the 24h status breakdown.
5. **Top tenants by volume** — needs a per-tenant volume aggregate endpoint.
6. **Cookie sessions, CSRF, capability bootstrap** — the release-blocking
   backend prerequisites from docs/frontend-architecture apply to this console
   verbatim (bearer → `__Host-` cookie, CSRF token + Origin + Fetch Metadata
   enforcement, audience-bound sessions).
7. **Audit pagination** — `GET /admin/audit` is limit-only (max 500); cursor
   pagination is needed before this list can grow unbounded.

## Not in scope yet (per delivery order)

SSE live patching, WebAuthn step-up, OIDC SSO login UI (backend route exists —
`POST /admin/auth/oidc-login`), virtualized million-row lists (no admin
endpoint currently returns unbounded lists), Playwright E2E suite against the
real stack, and the CSP/Trusted-Types deployment manifest (a deployment
concern for the static host + gateway, not the SPA bundle).
