# Valasys Mail website — Next.js

Local implementation of `C:/Users/prajwal/Downloads/Valasys Mail Landing Redesign.zip`. The highest root-level version, **Valasys Mail Landing v13**, is the canonical landing design. Included root Sign In, Create Account and Talk to Sales pages are also converted. Older nested exports and unrelated customer/admin designs are not substituted for v13.

## Run

```powershell
npm install
npm run dev:landing
```

Website: http://127.0.0.1:3001. Existing API/customer/admin services keep their ports. Production build: `npm run build:landing`; serve it with `npm run start:landing`.

Docker: `docker compose --profile website up -d --build website` serves the standalone Next.js server at http://127.0.0.1:8082. It is a non-root, capability-dropped application container with a health check. Apply migration 104 and deploy the API/customer callback first. This local profile uses `http://api:3000` internally; public origins are deployment-specific build arguments, not verified by local tests.

The Next.js App Router prerenders the page and hydrates compiled React interactions. Original HTML/CSS/logic is preserved under `design-reference/`; `scripts/compile-design.mjs` generates ordinary React components and a source-hash inventory at build time. No iframe, browser HTML parser, eval, Babel CDN, or DC runtime is shipped. Original screenshots are local assets. Original Instrument Sans, JetBrains Mono, Inter and Inter Tight fonts are self-hosted.

## Scope and honest behavior

The supplied pricing, testimonials, certifications, uptime/volume/inbox numbers, changelog entries, AI conversation and pipeline are **design/demo content, not independently verified production claims**. Publication requires business/legal approval of those claims and replacement/approval of placeholder testimonials. This task does not activate AI.

Tabs, screenshot switching, FAQ accordion, monthly/annual pricing, volume slider, password visibility/strength and navigation use the supplied design interactions. Anonymous test sending and domain checks do not fabricate successful results: actions explain that real sending/DNS verification happens in the existing authenticated customer workspace. Social/SSO providers remain unconfigured. Placeholder document/legal links disclose their unavailable destination.

## Backend integration and onboarding

Per the requested integration, Sign In and Create Account submit to the existing account API via the Next.js same-origin proxy. Passwords are sent only for that request; the landing site does not persist them. Busy guards prevent duplicate submissions and errors preserve form fields. `API_ORIGIN` configures the proxy (default `http://127.0.0.1:3000`); `NEXT_PUBLIC_CUSTOMER_UI_URL` configures the workspace origin (default `http://localhost:8080`). These origins must be configured at build time for standalone deployment; no secrets belong in public variables.

Migration 104 adds a hashed, 60-second, single-use workspace handoff. Only the opaque temporary code travels in the URL fragment; never a session token/password. The workspace immediately removes the fragment, shows the account email for explicit confirmation (avoiding silent account switching), then atomically redeems/rotates the original session. Concurrent redemption, replay, expiration, source-session revocation and disabled users fail closed. MFA satisfaction is preserved, never elevated. New accounts enter `/onboarding` in the existing workspace at the workspace-name step; they do not register a second time. Password recovery uses the existing workspace.

The sales form persists consent-confirmed requests through `/v1/landing/sales-requests`. A per-form UUID provides idempotent replay/conflict protection; requests are rate-limited and validated. Only the existing support-or-higher admin plane can list them at `/admin/landing/sales-requests`. A success confirmation means a stored request, not an external email/CRM delivery or a booked call. Sales notification/CRM routing, retention policy and operational ownership need approval before public launch. No external email is sent by sales intake.

Apply migration 104 before deploying the updated API/customer UI. Customer design references remain unchanged; the only added customer routes are the secure callback and authenticated onboarding entry.

## Design verification

Start the original reference only for local QA:

```powershell
node packages/landing-page/scripts/reference-server.mjs
```

It listens on loopback port 3002 and serves only the selected original files/assets. It is not a production route. Browser comparison uses fixed timers and identical viewports, compares full-page screenshots, exercises state changes and records runtime errors. Source mobile limitations are retained rather than introducing an unapproved responsive redesign.

Do not expose the reference runtime publicly. Real hosting/domain/TLS, approved sales destination, verified marketing copy and final visual sign-off remain release gates.
