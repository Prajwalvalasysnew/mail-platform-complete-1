# Handoff: Mail Platform — Customer Console, Admin/Ops Console & Support Agent Workspace

## Overview
This package turns the **Mail Platform wireframes** into a real **React + TypeScript + Redux Toolkit** front-end, wired to the existing backend in the repo `Prajwalvalasysnew/mail-platform-step30-body-offload`.

The platform is a self-hosted, multi-tenant **transactional email service** (a SendGrid-style product). The backend is an API-only Fastify/Kysely/Postgres service with **no UI shipped**. These wireframes design that missing UI, end to end, across three surfaces:

- **Customer console** — the self-serve product (overview, email activity, domains, templates, suppressions, webhooks, analytics, API keys, team, billing/payments, support).
- **Admin / Ops console** — internal fleet management (tenants, deliverability/IP pools, abuse, KYC, audit, billing & metering, payment gateways, settings, **support inbox**).
- **Support agent workspace** — where a support employee chats with customers and resolves tickets (internal notes, assignment, SLA, AI triage / suggested replies).

> **The task is to recreate these designs as a production React/TS/Redux app against the real API — not to ship the HTML.** The HTML files in this bundle are **design references** (interactive prototypes showing intended layout, content, and behavior). Recreate them in a fresh React app using a real component library and the patterns described here.

---

## About the design files
The bundled `*.dc.html` files are **design-reference prototypes**, authored in a component runtime used for design work. They are the source of visual truth for layout, spacing, copy, table columns, states, and flows. They are **not** production code to copy — there is no build/runtime here you should reuse. Read them (and the screenshots, if included) to see exactly what each screen looks like, then build the equivalent in React.

Files included (see `/design_files/`):
- `Mail Wireframes.dc.html` — the full canvas: **46 frames** in four sections (A Customer · B Admin/Agent · C Key flows & states · D Responsive/mobile).
- `WireSidebar.dc.html` — the reusable left-nav shell (customer + admin variants).
- `WireTopbar.dc.html` — the reusable top bar (title, breadcrumb, search, env badge, avatar).

## Fidelity
**Low-to-mid fidelity (wireframe).** Grayscale **by intent** — structure, IA, content, table columns, and flows are final; color, brand, and final visual styling are deliberately not. Use these for **layout, component inventory, behavior, and API mapping**. Apply your chosen design system / component library (e.g. MUI, Mantine, Chakra, shadcn/ui, Ant Design) for the actual styling. Do **not** reproduce the gray "blueprint" look in production — promote it to a real visual design using the tokens your component library provides.

The one thing to preserve precisely is **information architecture and content**: navigation grouping, table columns, the status vocabulary, empty/error states, and the three-pane support workspace.

---

## Tech stack (target)
- **React 18 + TypeScript** (Vite).
- **Redux Toolkit** + **RTK Query** for all server state (the API is REST/JSON — RTK Query is the right fit and removes most hand-written thunks/reducers). Use plain RTK slices only for local UI state (filters, modals, composer drafts, selected ticket).
- **React Router v6** for routing.
- A component library of your choice for primitives + a charting lib (Recharts/visx) for analytics.

> If the team already has a front-end app or design system, use **that** instead — these notes describe structure, not a mandated library.

---

## The backend, in one screen
- **Framework:** Fastify + Kysely + Postgres + BullMQ (Redis) for the send queue. Monorepo under `packages/api/src/routes/*.ts`.
- **Base URL:** the scoped data API is mounted under a version prefix — confirm in `packages/api/src/server.ts` (referred to here as `/v1`). Account/auth/team routes are mounted at the root (`/auth/*`, `/team/*`, `/account/*`).
- **Two auth models — this is the single most important integration fact:**

  | Token | How you get it | Sent as | Guards | Used by |
  |---|---|---|---|---|
  | **User session token** | `POST /auth/register` or `POST /auth/login` → `{ token, expires_at }` | `Authorization: Bearer <session>` | `requireFullUser`, `requireCapability(...)` | Dashboard auth, `/auth/me`, **`/team/*`**, **`/account/api-keys`** |
  | **API key** (`mp_live_…`, `mp_test_…`) | created via `/account/api-keys` | `Authorization: Bearer <api_key>` | `requireScope('send' \| 'messages' \| 'suppressions' \| …)` | **All `/v1` data routes**: `/send`, `/messages`, `/analytics`, `/suppressions`, `/domains`, `/templates`, `/webhooks`, `/usage` |

  See `INTEGRATION_NOTES.md` → **"Bridging session auth and scoped data routes"** for the key decision the dev must make (the dashboard logs in with a session token, but the data routes want an API key). Recommended approach is documented there.

- **Auth context** carries `customer_id`, `tier`, `scopes`, `test_mode`, `email_verified` (see `packages/api/src/plugins/auth.ts`).
- **Errors** are consistent JSON: `{ error: "<code>", message?: "...", details?: {...} }` with appropriate HTTP status. Build one error interceptor (see `REDUX_ARCHITECTURE.md`).

---

## Screens / views
Full per-screen detail (layout, components, columns, copy, states) lives in the wireframes themselves; the **screen → endpoint → payload** mapping is in **`API_MAP.md`**. Summary inventory:

### A · Customer console
| # | Screen | Primary endpoint(s) |
|---|---|---|
| A1 | Onboarding / first send | `POST /auth/register`, `POST /v1/domains`, `POST /v1/send` |
| A2 | Overview dashboard | `GET /v1/usage`, `GET /v1/analytics/summary`, `GET /v1/analytics/timeseries`, `GET /v1/messages` |
| A3 | Email activity (list) | `GET /v1/messages` (cursor paginated) |
| A4 | Message detail + timeline | `GET /v1/messages/:id` |
| A5 | Domains | `GET /v1/domains` |
| A6 | Domain DNS verification | `POST /v1/domains/:id/verify` |
| A7 | Templates (list) | `GET /v1/templates` |
| A8 | Template editor | `GET/PATCH /v1/templates/:id` |
| A9 | Suppressions | `GET/POST/DELETE /v1/suppressions`, `…/import`, `…/export` |
| A10 | Unsubscribe groups | `GET/POST/PATCH/DELETE /v1/unsubscribe-groups` |
| A11 | Webhooks | `GET/POST /v1/webhooks` |
| A12 | Webhook delivery log | `GET /v1/webhooks/:id/deliveries` |
| A13 | Analytics | `GET /v1/analytics/{summary,timeseries,breakdown}` |
| A14 | API keys | `GET/POST/DELETE /account/api-keys`, `…/:id/rotate` |
| A15 | Billing & usage | `GET /v1/usage`, `GET /v1/billing` |
| A16 | Support tickets (list) | `GET /v1/support/tickets` |
| A17 | Checkout · choose gateway | `GET /v1/billing` |
| A18 | Pay with Stripe | gateway (Stripe Elements) + `POST /v1/billing/...` |
| A19 | Pay with PayPal | gateway (PayPal Orders) |
| A20 | Pay with Cashfree | gateway (Cashfree, INR) |

### B · Admin / Ops console & Support agent
| # | Screen | Primary endpoint(s) |
|---|---|---|
| B1 | Fleet overview | `GET /admin/*` (metrics, queue depth, alerts) |
| B2 | Tenants | `GET /admin/customers` |
| B3 | Deliverability & IP pools | `GET /admin/*` (pools, reputation, warmup) |
| B4 | Abuse & moderation queue | `GET /admin/review-queue` / abuse |
| B5 | KYC / verification | `GET/POST /admin/kyc...` |
| B6 | Audit log | `GET /admin/audit` (and `GET /v1/audit`) |
| B7 | Billing & metering | `GET /admin/billing...` |
| B8 | Platform settings | `GET/PATCH /admin/settings...` |
| B9 | Payment gateways | `GET/PATCH /admin/payment-gateways...` |
| B10 | **Support inbox** (agent queue) | `GET /admin/support-tickets` |
| B11 | **Support agent workspace** (chat & resolve) | `GET /admin/support-tickets/:id` (`includeInternal`), `POST …/messages` (`internal`), `PATCH …` (status/assignee) |

### C · Key flows & states
C1 Desktop compose (`POST /v1/send`) · C2 Team & roles (`/team/*`) · C3 Customer ticket chat (`GET /v1/support/tickets/:id`) · C4 Empty/first-run states · C5 Error/failure states (payment declined, DNS failed, send blocked → real error codes `card_declined`, `domain_not_verified`, `suppressed`).

### D · Responsive (mobile, 375px)
D1 Overview · D2 Activity · D3 Message detail · D4 Compose · D5 Onboarding · D6 Domains/DNS · D7 Suppressions · D8 Analytics · D9 Billing · D10 Menu/More. Sidebar collapses to a 4-item bottom tab bar (Overview · Activity · Send · More).

> **Admin routes:** the exact `/admin/*` paths/payloads are large (`packages/api/src/routes/admin.ts`, ~46 KB). `API_MAP.md` lists the confirmed customer/session endpoints precisely and flags admin endpoints to confirm against that file while building.

---

## Interactions & behavior (cross-cutting)
- **Pagination:** `/v1/messages` and `/v1/messages/scheduled` use **opaque cursor** pagination (`next_cursor`, pass back as `?cursor=`). `/v1/suppressions` uses **limit/offset**. Build both patterns into RTK Query (see architecture doc).
- **Status vocabulary** (drive all badges from one map): message — `queued`, `held`, `delivered`, `soft_bounce`, `hard_bounce`, `complaint`, `opened`, `clicked`, `failed`; domain — verified / pending; key — active / revoked / expired; ticket — open / pending / resolved / closed.
- **Idempotency:** `POST /v1/send` accepts an `Idempotency-Key` header — generate a UUID per compose-send so retries don't double-send. Handle `409 idempotency_in_progress` (retry) and `422 idempotency_key_reused`.
- **Send guardrails as UI states (C5):** `403 domain_not_verified`, `403 email_not_verified`, `429 quota_exceeded` (+ `daily`/`monthly` usage in body), `429 queue_backpressure`, `422 content_rejected` (+ `reasons[]`), suppressed recipients returned in `suppressed[]`. Each maps to a specific inline error in the design.
- **Support internal notes:** in the agent workspace, replies post to the customer; **internal notes** (`internal: true`) are agent-only and must be visually distinct (cream/dashed in the wireframe) and never rendered in the customer ticket view (C3).
- **Loading/empty/error:** every list needs skeleton, empty (see C4), and error states. Empty states have a clear primary CTA.
- **Responsive:** ≥1024px = sidebar + topbar; <768px = bottom tab bar + stacked cards + slide-over filters (section D).

---

## State management
See **`REDUX_ARCHITECTURE.md`** for the full store shape. In short:
- **RTK Query API slices** per domain (`messagesApi`, `analyticsApi`, `domainsApi`, `suppressionsApi`, `templatesApi`, `webhooksApi`, `keysApi`, `usageApi`, `billingApi`, `supportApi`, `teamApi`, `adminApi`) handle all fetching, caching, and invalidation.
- **`authSlice`** holds the session token, current user, `current_customer_id`, role/capabilities, and `email_verified` (from `GET /auth/me`).
- **UI slices** for ephemeral state: `composerSlice` (draft, recipients, idempotency key), `filtersSlice` (per-list filters/cursors), `supportSlice` (selected ticket, reply-vs-note mode), `uiSlice` (modals, toasts).

## Design tokens
Wireframes are intentionally grayscale; do not lift these as final brand colors. Structural tokens to carry over:
- **Radii:** cards 10–12px, controls 7–8px, pills 999px.
- **Type scale (approx):** page title 16–23px/600–700; section 13.5px/600; body 12.5–13px; meta/mono 11–12px. Monospace for IDs, emails, timestamps, code.
- **Spacing:** 24–26px page padding; 14px card gaps; 12–18px card padding; 8px control gaps.
- **Tables:** ~11px uppercase mono headers (letter-spacing ~.07em) on a faint header fill; 13–15px rows with 1px row dividers; status as a small pill in its own column.
- Replace grayscale with your design system's palette; reserve one accent for primary actions and a clear semantic set (success/warn/danger) for the status vocabulary.

## Assets
No raster assets — the wireframes use placeholder blocks for logos/avatars/previews. Provide real brand assets in implementation. Payment screens (A18–A20) should use each provider's official SDK/Elements rather than custom card forms where possible.

## Files
- `/design_files/Mail Wireframes.dc.html` — all 46 frames (visual source of truth).
- `/design_files/WireSidebar.dc.html`, `/design_files/WireTopbar.dc.html` — shared shell.
- `API_MAP.md` — screen → endpoint → request/response, grounded in the route source.
- `REDUX_ARCHITECTURE.md` — store, RTK Query slices, error handling, auth flow.
- `types.ts` — TypeScript interfaces derived from the backend routes.
- `INTEGRATION_NOTES.md` — auth bridging, env config, pagination, gotchas.
- `PROJECT_STRUCTURE.md` — folder layout, routing, component breakdown.
- `CLAUDE_CODE_PROMPT.md` — paste-ready kickoff prompt for Claude Code.

---

## How to use this with Claude Code
1. Open the target repo (or an empty folder) in Claude Code.
2. Paste the contents of **`CLAUDE_CODE_PROMPT.md`** as your first message and attach this handoff folder.
3. Build domain by domain in the order in `PROJECT_STRUCTURE.md` (auth shell → overview → messages → … → support). Verify each against the matching wireframe frame and the endpoint in `API_MAP.md`.
