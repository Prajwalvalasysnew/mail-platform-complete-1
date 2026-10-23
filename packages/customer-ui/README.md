# Valasys Mail customer UI

React customer application being migrated directly from the latest design suite in `Setup clarification needed (2).zip`.

The four source designs in `design-reference/` are the visual specification and remain untouched. `scripts/compile-design.mjs` converts their templates and interaction controllers into ordinary React modules under `src/faithful/generated/` at build time. The browser does not load `support.js`, parse design templates, download React/Babel from a CDN, or evaluate design script strings. Fonts and the patched GrapesJS runtime are bundled locally, retaining the reference editor stylesheet for appearance.

This migration is in progress. Docker port 8080 now serves the compiled React application through Nginx. The untouched ZIP comparison preview is isolated on loopback port 8081 under the `customer-design-reference` Compose profile. Running the React container is not approval for a public production launch; see the remaining blockers in RELIABILITY.md.

## Commands

- `npm run dev --workspace=@platform/customer-ui`
- `npm run build --workspace=@platform/customer-ui`
- `npm run design:compile --workspace=@platform/customer-ui`
- `npm run test:design --workspace=@platform/customer-ui`
- `npm run test:interactions --workspace=@platform/customer-ui`

The Vite development server runs on strict port 5173 and proxies only `/api` or `/api/*` to `CUSTOMER_API_ORIGIN` (default `http://127.0.0.1:3000`) as `/v1/*`. Routes such as `/api-keys` must remain frontend documents, not API requests. The explicit loopback address avoids ambiguity with Windows/WSL IPv6 forwarding.

The customer `/login` page matches the landing website's Sign In design, with scoped styles and self-hosted Inter fonts. It retains the customer session API, MFA, password recovery and `/register` destination. Google and SSO buttons explain that those providers are not configured. `VITE_LANDING_URL` sets the logo and footer website destination (local default: `http://localhost:3001`). Other customer authentication pages keep their existing layout.

The application entry point uses Redux Toolkit, RTK Query, React Router, lazy page imports and a render error boundary. `/login` and `/register` use human-session APIs. Production adapters connect session restoration, registration, password recovery, email verification, consent-aware contacts/CSV import, live summaries/messages, templates and editor versions, API keys/webhooks, and supported workspace/domain/team/session/billing settings. Unsupported controls are not counted as implemented features. Remaining production work is tracked in [MIGRATION.md](MIGRATION.md); current acceptance evidence and limits are in [RELIABILITY.md](RELIABILITY.md).

## Visual comparisons

Development-only routes retain the reference data and interactions for like-for-like screenshot comparisons:

- `/__design/customer` (onboarding), or `/__design/customer?view=home`
- `/__design/email`
- `/__design/workflow`
- `/__design/agent`

These routes are excluded from production builds. The source inventory records the reference SHA-256 hashes, element counts, conditions, collections and bindings in `src/faithful/generated/inventory.json`.

`check-design.mjs` compares the original export at `DESIGN_REFERENCE_ORIGIN` (default `http://localhost:8081`) with the React dev server at port 5173. Start the reference with `docker compose --profile customer-design-reference up -d customer-design-reference`. It fixes the clock and viewport, waits for fonts, disables animation, saves reference/React/diff images and checks browser errors. It fails above `DESIGN_MAX_DIFFERENCE_PERCENT` (default 0.05%). Use `--width=390` for mobile or `--only=home,email` for specific pages. This threshold is a regression check, not a claim of zero pixel differences or exhaustive interaction coverage.

If using an existing Chromium installation, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable. Authenticated interaction checks use `CUSTOMER_UI_TEST_EMAIL` and `CUSTOMER_UI_TEST_PASSWORD` from the environment; no credentials are stored in source.

Additional checks are `scripts/check-template-persistence.mjs`, `scripts/check-customer-settings.mjs`, `scripts/check-live-data.mjs` and `scripts/check-message-model.mjs`. The browser scripts accept `CUSTOMER_UI_ORIGIN` (default `http://127.0.0.1:5173`). Template isolation/RLS checks run inside an API container using `scripts/check-template-isolation.cjs`; they create and remove their own temporary records and database role.

`scripts/check-new-customer.mjs` exercises real registration, onboarding DNS, contacts, CSV, isolation, account emails, password reset, MFA, API outage recovery, logout and mobile sign-in. It requires the local Docker API/database/Mailpit stack and creates/removes its own UUID-named test accounts. It never uses or changes a real customer's credentials. `scripts/check-contact-csv.mjs` tests CSV parsing; `scripts/check-contact-isolation.cjs` runs in the API container to check contacts authorization, transactions, suppression enforcement, concurrency and non-bypass RLS.

Local verification/reset/invitation messages are captured at `http://localhost:8025`. Compose defaults use Mailpit, not external recipient delivery. Production requires an explicitly configured public frontend URL, allowed origins and real mail transport.

Local account links default to `http://localhost:8080`. Run browser checks against the packaged app with `CUSTOMER_UI_ORIGIN=http://127.0.0.1:8080`. `check-new-customer.mjs` now also checks lists/membership, supported segments, invitations, workflow draft/publish/pause, and domain/DMARC reads. `check-workflow-codec.mjs` checks explicit mapping and unsupported-option rejection. `check-customer-integrations.cjs` runs only inside the local Mailpit API container and verifies invitation concurrency, audience isolation/RLS, real workflow worker completion and captured SMTP delivery. It creates/removes isolated dummy tenants and never sends to an Internet recipient. An interrupted run can be inspected with `cleanup-integration-fixtures.cjs`; deletion requires its explicit `--apply` flag and is restricted to the integration test's exact fixture naming convention.

Campaigns support saved/revision-protected drafts, real audiences/templates/verified senders, explicit confirmation and one-time immediate or scheduled launch for at most 200 consent-confirmed subscribers through existing send guards. Subject-line A/B tests support 2–100 subscribers with a frozen random 50/50 split, the original variant fields and actual variant message counts; no automatic winner/content test is claimed. Browser-local scheduled times are stored as UTC. Pending future messages can be cancelled; partial cancellation is reported. Uncertain launches can be reconciled from recorded results or nonce-bound committed messages without resending; no-evidence cases remain blocked. Recurring, optimization and large-audience continuation remain incomplete. Reports use actual message states.

Workflows additionally support explicit API-context conditions/filters, 30-day re-entry and paginated run/version history with explicit run cancellation. These context fields are not automatic commerce/CRM integrations. AI is deferred. See [DEPLOYMENT.md](DEPLOYMENT.md) for the optional non-root/read-only Helm frontend, configurable upstream/DNS, read-only production preflight, and remaining real hosting/TLS/delivery gates. Local Mailpit and chart rendering do not certify public production delivery.

The live shell loads section data on demand, refreshes the active section on visible-tab return (10-second throttle) or reconnection, and offers in-page read recovery. Transient GET network/502/503/504 failures get one retry; writes, rate-limit/permission errors and timeouts are never automatically replayed. Offline writes preserve form values. An ambiguous write response instructs the user to check records before submitting again. Pending reads are aborted when the session changes.

## AI newsletter design

The AI email builder supports a full `newsletter` composition: brand header, tinted hero containing its supporting copy and primary button, consecutive titled `feature` blocks rendered as a two-column grid, a `cta` block with title/copy/button, and a dark branded footer. Brand name, tagline, accent, heading/background/footer colours and an approved website link are optional design fields. Existing showcase/editorial/minimal emails and targeted edits remain supported. Custom reference structures can use the sanitized `write_email` tool instead of being flattened into the structured layout.

For example: ?Create a B2B newsletter for Valasys Media with a blue hero, four service cards in two columns, a second contact CTA, and a navy footer. Link the buttons to https://valasys.com/.? Supply actual service descriptions and brand copy; the AI should not invent claims.

`packages/tests/fixtures/valasys-newsletter.html` is the supplied reference; its JSON fixture exercises the production compose function. Run the focused `ai-newsletter`, `ai-writing`, `ai-email-document` and `ai-campaign-plan` tests after building shared. `scripts/check-ai-newsletter-live.cjs` can run inside the local development API container with `AI_NEWSLETTER_LOCAL_QA=true`; it uses the actual configured worker, checks all sections and template save/reload, writes a preview under `/tmp`, and removes its own temporary tenant. It never sends email. Email-client inbox rendering still needs normal campaign testing; browser checks verify layout and editor persistence.
