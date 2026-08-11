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
- **Session handling.** Login sets a `__Host-`-prefixed, HttpOnly,
  SameSite=Strict cookie server-side, so the session token never touches JS or
  storage, and returns a per-session CSRF secret held in memory and attached
  to every mutation as `x-csrf-token`. On page reload the console calls
  `GET /admin/auth/bootstrap`, which restores identity from the cookie,
  rotates a fresh CSRF secret, and returns the server-derived capability map.
  Cookie-authenticated requests are additionally checked server-side for
  Origin and `Sec-Fetch-Site` (fetch-metadata) correctness; bearer tokens
  remain supported for ops tooling. For non-TLS local setups where the
  `__Host-` prefix can't apply, start the API with `ADMIN_COOKIE_SECURE=false`
  (the local Compose stack sets this explicitly). Production Compose forces
  `ADMIN_COOKIE_SECURE=true`.
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
| `/` | Fleet overview | `GET /overview`, `GET /overview/timeseries`, `GET /overview/top-tenants`, `GET /review-queue/stats`, `GET /deliverability/pool-health`, `GET /support-tickets/sla-breaches`, `GET /dlq` | support (dlq widget: operator) |
| `/tenants` | Tenants + drawer | `GET /customers`, `GET /customers/:id`, `POST /customers/:id/support-notes`, `PATCH /customers/:id`, `POST /customers/suspend·reinstate` | support / operator / admin |
| `/deliverability` | Deliverability | `GET /deliverability/pool-health`, `GET /reputation/pools`, `POST /deliverability/blocklist-scan` | support (scan: operator) |
| `/pools` | IP pools | `GET /reputation/pools`, `POST /deliverability/blocklist-scan` | support |
| `/support` | Support inbox (3-pane) | `GET/PATCH /support-tickets*`, `POST …/messages·read·triage·suggest-reply`, `GET /support/canned-responses`, `GET /support-tickets/sla-breaches` | support |
| `/abuse` | Abuse queue | `GET /review-queue(+/stats)`, `POST /review-queue/:id/approve·reject`, `POST /review-queue/bulk` | support (actions: operator) |
| `/kyc` | KYC / verification | `GET /kyc`, `POST /kyc/:id/approve·request-info·reject` | support (decisions: operator) |
| `/audit` | Audit log | `GET /admin/audit` (cursor-paginated + client CSV export) | admin |
| `/billing` | Billing & metering | `GET /billing-events(+/:id)`, `POST /billing-events/:id/replay`, `POST /billing/reconcile` | operator (replay: admin) |
| `/payments` | Payment gateways | `GET /payment-gateways`, `PUT /payment-gateways/:key` | operator (configure: admin) |
| `/settings` | Settings | `GET/PUT /settings`, `POST /retention/run` | operator (write: admin) |
| `/team` | Admin team + elevations | `GET/POST/PATCH /admins*`, `GET/POST/DELETE /elevations*`, `POST /elevations/break-glass` | operator (manage: superadmin) |
| `/dlq` | Dead-letter queue | `GET /dlq(+/:id)`, `POST /dlq/:id/replay`, `DELETE /dlq/:id`, `POST /dlq/purge` | operator |

## Backend gaps from the end-to-end check — now closed

The seven gaps found while mapping the confirmed design against
`packages/api/src/routes/admin.ts` have all been implemented
(migration `067_admin_console_gaps.sql`):

1. **KYC decisions** — `/admin/kyc` queue + `POST /admin/kyc/:id/approve`,
   `…/request-info`, `…/reject`. Decisions stamp reviewer/timestamp/note on
   the customer (`kyc_status`) and are audit-logged; approve can raise
   `kyc_level`. The screen's action buttons are live (operator role).
2. **Payment gateway config** — `GET /admin/payment-gateways` reports
   credential *presence* from the environment (never values), the persisted
   enable/mode toggle, and billing-event activity; `PUT
   /admin/payment-gateways/:key` (admin) saves the toggle. The Configure modal
   is wired to both.
3. **Platform settings CRUD** — `GET/PUT /admin/settings` backed by the
   `platform_settings` JSONB store with typed, zod-validated groups (quotas,
   bounce thresholds, warmup, security). All four panels are editable (admin).
4. **Fleet time series** — `GET /admin/overview/timeseries?days=7` (UTC daily
   buckets, zero-filled) drives the 7-day volume chart on the fleet screen.
5. **Top tenants by volume** — `GET /admin/overview/top-tenants?hours=24`
   joins per-tenant message aggregates to the customer record; rendered as the
   fleet screen's top-senders table.
6. **Cookie sessions, CSRF, capability bootstrap** — login sets the `__Host-`
   cookie and returns a CSRF secret; cookie-authed requests enforce Origin +
   fetch metadata + `x-csrf-token` on mutations; sessions are audience-bound
   (`admin_sessions.audience`); `GET /admin/auth/bootstrap` restores identity,
   rotates CSRF, and returns the capability map.
7. **Audit pagination** — `GET /admin/audit` is cursor-paginated
   (`cursor=<last id>` + `next_cursor`, optional `action` filter) with a
   partial index for the admin-plane scan; the screen loads pages on demand.

## Not in scope yet (per delivery order)

SSE live patching, WebAuthn step-up, OIDC SSO login UI (backend route exists —
`POST /admin/auth/oidc-login`), virtualized million-row lists (no admin
endpoint currently returns unbounded lists), Playwright E2E suite against the
real stack, and the CSP/Trusted-Types deployment manifest (a deployment
concern for the static host + gateway, not the SPA bundle).
