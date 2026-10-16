# Customer UI reliability — 2026-10-16

Status: substantial local integration completed; **not fully production-ready**. Bounded immediate/scheduled campaigns, evidence-only launch recovery and additional workflow controls are integrated. Large-audience fan-out remains incomplete. Public deployment and Internet delivery are unverified. AI is explicitly deferred at the user's request and was not worked on in this pass. Tests use isolated synthetic accounts, `.test` recipients and local Mailpit, not real external recipients.

## Local deployment

- `http://localhost:8080`: compiled React customer application through Nginx and same-origin `/api/` forwarding. No longer the ZIP preview.
- `http://localhost:5173`: React development server.
- `http://localhost:8081`: untouched ZIP comparison preview, loopback-only Compose profile `customer-design-reference`.
- `http://localhost:8025`: local Mailpit captures.

The multi-stage Docker build bundles fonts/editor assets, disables production source maps by default, prevents HTML caching, caches hashed assets and returns 404 for missing assets. CSP permits same-origin scripts without `unsafe-eval` or inline scripts. The actual packaged editor passed persistence/history tests under this policy. `/api-keys` correctly returns a React HTML document. API PostgreSQL/Redis/queue health checks passed. Local account email links default to port 8080.

## Implemented scope

### Core accounts, contacts and recovery

Real registration, login, MFA, verification, password recovery, session restoration/revocation and logout; no hardcoded admin credentials. Sign-in has labelled, responsive fields and actionable errors. Authentication 401 clears the session; transient identity failures retain it and offer retry. Account changes cancel pending reads and clear cached data.

Contacts use tenant-scoped PostgreSQL records and truthful whole-workspace counters, not reference fixtures/NaN. Subscribed creation/import requires consent confirmation. Unsubscribe creates real suppression; deleting contacts retains opt-outs. CSV import is atomic, limited to 200 contacts per request. Duplicate/mixed-tenant writes are rejected. Onboarding saves the workspace name and exposes actual DNS records, never example credentials.

Admin-pattern hardening includes active-section-only loading, one bounded transient GET retry, manual recovery, reconnect/visible-tab refresh, preserved rows/forms, duplicate-submit guards and readonly controls. Writes, timeouts, rate limits and permission failures are never automatically replayed. Ambiguous write failures explain the uncertain outcome.

### Lists and supported segments

Migration 100 adds collections and tenant-bound membership with composite foreign keys and forced, fail-closed RLS. Real creation/counts/deletion/reload, selected-contact list assignment and persisted membership chips are connected. Membership add/remove APIs validate whole batches atomically. Deleting a collection preserves contacts/consent.

Segments support Created, Opened any email and Clicked any email with supported in-last/not-in-last windows. Counts use real contacts/events/messages. Audience cards can open a real campaign draft for the selected collection. Unsupported rules are not simulated. Collection responses and membership batches are bounded to 200; this is not large-audience scalability certification.

### Invitation acceptance

Actual invitation emails support existing accounts and new-account creation. Acceptance is an explicit action, not a GET side effect. Revoked/expired/reused tokens return errors. Transactional invite locking and email serialization prevent concurrent reuse/account creation. Existing membership roles are preserved, including an owner receiving an analyst invitation. MFA remains enforced after identity switching. Default expiry is 72 hours.

### Bounded one-off campaigns

Migrations 101/102 add tenant-scoped, forced-RLS campaigns and durable send times. The original layout uses real draft creation/save/reload, optimistic revisions, actual lists/segments/templates and tenant-owned verified sender choices. Reference sender addresses are replaced only on live routes; the source design remains unchanged. Unsaved edits get a browser-leave warning; edits during a save are retained. Drafts can be cancelled. Future scheduled messages can be cancelled only while the existing outbox still permits it; dispatched mail cannot be recalled. Partial cancellation results are explicitly reported, not converted to blanket success.

Launch locks the campaign, validates the revision, snapshots at most 200 consent-confirmed subscribers plus rendered template content, and forwards through the existing authenticated send route. Account/domain verification, suppression, quota, compliance/content checks, durable outbox and SMTP workers remain authoritative. The confirmation includes the advertisement-identification attestation. Pending/unsubscribed contacts are not enrolled. Audiences above the bound are rejected without sending a partial subset. Templates requiring personalization variables are rejected rather than silently rendering blank values.

Only one launch can claim a campaign, including concurrent requests. Repeated requests do not resend it. Scheduled launch passes a frozen UTC `send_at` to the existing durable outbox; the UI converts the entered browser-local time and explicitly labels that time zone. Launch validates a window of five minutes to 90 days. The browser can be closed after acceptance; it is not the scheduler.

An interrupted launch can be reconciled after 30 seconds using its matching recorded idempotency result, or nonce-bound committed messages if that result is absent. A private launch nonce prevents campaign-ID-only message attribution from being treated as recovery proof. Reconciliation never calls send or replays an ambiguous request. No-evidence/uncertain cases stay blocked; operator-assisted restart/retry and large-audience continuation remain unfinished. Failed campaigns remain frozen pending inspection.

Campaign reports show actual stored message/delivery/open/click states, not reference trends, link/client breakdowns, revenue or fabricated delivery percentages. Queued/accepted does not mean inbox delivery. Recurring campaigns, optimization, report exports and bulk actions remain disabled/unimplemented.

### Bounded subject-line A/B campaigns

Migration 103 adds the immutable campaign type and saved second subject. The existing design's A/B creation/variant controls now save and reload real drafts. This supports one saved template with two different subjects and 2–100 consent-confirmed subscribers, not content variants, automatic winners or large-audience sending. Live explanatory text explicitly replaces the reference's unimplemented 10%/four-hour-winner promise; reference source files remain untouched.

Recipients are cryptographically shuffled and balanced between A/B once; the complete assignment and nonce are persisted before dispatch through the existing authenticated atomic batch-send route. Odd audiences put one extra recipient in A. Account/domain/consent/suppression/quota/content safeguards remain authoritative. Accepted/delivered counts may differ after suppression or rejection. An explicit request-size budget rejects oversized template/audience combinations before claiming or sending.

Concurrent/replayed launches cannot redraw or resend the test. The result stores accepted message IDs for cancellation of pending future messages, exposes partial outcomes, and marks an all-rejected/all-suppressed test failed instead of claiming it was queued. Nonce-bound committed-message recovery never sends again; when the original response was lost, unknown per-recipient rejection/suppression outcomes are labelled unknown rather than invented. Variant report counts come from actual message rows; no winner or statistical significance is claimed.

### Supported workflows

Production drafts are server-owned, not reference LocalStorage. Sequential autosave and optimistic revisions prevent stale overwrites. Publication creates immutable versions; pause, reload and server dry run are connected. Dry runs send no mail/webhooks. API and opened/clicked/delivered event triggers are supported; existing audiences are not automatically enrolled.

Supported steps: saved-template email, duration/open/click waits, A/B splits, signed POST webhooks and explicit API-context conditions/filters. The new context conditions are `context.onboarding_complete === true` and `context.score >= 50`; labels identify the actual supplied context, not a claimed commerce/CRM integration. True/false branches and filter exits map to engine conditions. Re-entry supports once/every/30-day cooldown. A paginated Runs & versions view reads real immutable publication metadata and run states; explicit cancellation stops future workflow steps, not already queued mail.

Template subject/preview are authoritative. Unsupported overrides, audience filters, quiet-hour/cross-workflow caps and business triggers are rejected, not silently ignored. Unsupported nodes can remain in raw drafts but cannot publish. Draft graph sizes/IDs/references and execution definitions are validated. Version restoration into an editable visual graph is not implemented.

A real zero-duration delay exposed an enqueue-before-commit race. Parked run state now commits before its wake job is queued; sweep recovery remains. A repeated real API trigger completed through the Docker worker. Existing 23 workflow definition/simulation unit tests passed.

### Domain/DMARC monitoring

Deliverability reads actual domains, authentication state, DMARC summaries/sources and reporting addresses. DNS recheck uses the existing service; overview/authentication/source tabs filter real content. No fabricated score, trend, inbox-placement result or 100% success appears without evidence. Report upload UI and placement testing are not implemented.

### Existing integrations

Template/project save/reload, immutable history/restore and stale-write protection; live Home/Analytics summaries and message/detail/event/activity data; API keys/webhooks; supported workspace/profile/domain/team/session/billing settings. Unsupported controls do not simulate successful saves. Activity CSV exports mask values and guard spreadsheet formulas.

## Acceptance evidence

`scripts/check-new-customer.mjs` passed **23 scenario groups on Docker port 8080 with zero recorded browser errors**:

- Fresh-account onboarding/empty state, contact consent/import and tenant isolation.
- Active-page reads, fault recovery, offline drafts, double-submit protection and API-key create/revoke.
- Lists/membership chips after reload, dynamic segments and audience isolation.
- Campaign creation, template/sender/subject edits, scheduled draft/time-zone persistence, reload and tenant isolation.
- Original A/B creation/variant controls, persisted test type/second subject, reload and removal of the unimplemented winner-send promise.
- Actual invitation emails, existing/new user acceptance, analyst readonly UI/backend authorization and single-use tokens.
- Workflow autosave/reload, stale-write rejection, dry run, publish/pause, real run/version history, run cancellation, context-branch draft persistence and live DMARC reads.
- Captured verification/reset messages, session revocation, MFA, guarded incomplete pages, logout and mobile sign-in.

`check-customer-integrations.cjs` passed invitation concurrency/role preservation, atomic audience membership, non-bypass database-role RLS, immutable publish, stale revisions and **actual worker workflow completion**. Its dummy message traversed the real outbox → worker → SMTP → Mailpit path with accepted/delivered backend status. Only the exact synthetic tenant/domain was fixture-verified; production guards were not weakened. This proves local transport, not real DNS or Internet delivery.

Campaign integration checks also passed forced RLS, stale revisions, cross-tenant isolation, two concurrent launches producing exactly one stored/captured campaign message, pending-contact exclusion, rejection above 200 subscribers without a partial send, draft cancellation and cancelled/queued launch protection. A campaign reference capture passed at 0.01% difference with no browser runtime errors. These are bounded local checks, not bulk production-load certification.

The non-AI follow-up passed actual future-outbox/no-early-drain checks, future campaign cancellation/replay, due scheduled SMTP delivery, acknowledgment recovery from the recorded result and then from nonce-bound messages, unresolved/no-evidence refusal, cross-tenant rejection and invalid-schedule rejection. The due-send test advances only its own UUID fixture's stored outbox/message timestamps; it does not change the system clock or claim a five-minute wall-clock soak. Real workflow runs exercised both branch outcomes, filter exit and 30-day cooldown rejection. All synthetic fixtures were removed.

Twenty-eight unit tests passed (workflow engine/definition, campaign-state regressions and release-preflight checks), alongside the workflow codec assertions. Sampled campaign/workflow reference captures passed at 0.010%/0.009% with no runtime errors. These are regression samples, not exhaustive live visual approval.

The subject-test follow-up passed 12 isolated unit tests using `npm run test --workspace=@platform/tests -- --config vitest.customer-unit.config.ts` (no database/queue setup). The first default test invocation could not reach the separate test database/Redis; that was not counted as a passing full repository suite. TypeScript, Docker API/customer builds and migration 103 passed. The local backend fixture suite exercised random balanced assignments, concurrent launch protection, variant counts, nonce-only recovery without resend, both subjects traversing real outbox/worker/SMTP into Mailpit, partial suppression, accepted-message cancellation and truthful all-suppressed failure. The 23-group browser suite passed after deploying the updated Docker UI; exact synthetic tenants were cleaned. These are bounded dummy-recipient checks, not public delivery or load acceptance.

The read-only release preflight now also rejects literal IPs (including URL-normalized integer/hex and IPv6 forms), single-label/internal hosts and reserved example origins even when HTTPS is selected. It does not perform DNS/ownership/TLS checks or authorize deployment.

Deployment preparation: the customer image now accepts an upstream/port and derives container DNS resolvers instead of assuming Docker's resolver. The optional Helm UI deployment/service/TLS ingress and network policies passed lint and rendering with the component enabled. A separate UID/GID 101 container with read-only root filesystem and dropped capabilities passed Nginx validation, UI health and API proxy checks, including after API recreation. A PID-path mismatch found by that test was fixed. CI source now includes customer build/codec and image-scan coverage; remote CI and a real cluster were not executed. The read-only release preflight rejects the local dummy config as expected. See DEPLOYMENT.md for the public release gates.

Expanded template-backed campaign checks exposed frozen Redux-response mutation and stale-read hazards that the initial empty-draft test missed. Campaign state now copies query responses, uses immutable insertion, invalidates old reads on mutations and waits for initial loading before offering creation. The expanded browser scenario saves a real template selection, subject and sender name and verifies server persistence. Three focused adapter regression tests passed for frozen responses, stale refresh completion and edits during an in-flight save. Those unit tests mock transport; the separate browser/backend tests exercise real services.

A worker restart during resource-heavy builds exposed an unhandled PostgreSQL connection error (`25P03`, idle-in-transaction timeout). A separate test process reproduced the crash without killing any application/database connection. Shared primary/replica pools now observe idle and checked-out connection errors; failed query promises still reject and no transactions are automatically replayed. The patched worker image passed `check-db-disconnect.cjs`: both timeout cases leave the process alive and fresh queries recover. The timeout protection itself remains enabled. This fixes the unhandled-error crash, not a claim that all long transactions or infrastructure interruptions have been eliminated.

Cleanup now removes its own event/outbox/message records before synthetic tenants and closes clients even on cleanup failure. Interrupted fixtures were inspected by exact test name/email convention and removed; real customer data was not reset. Mailpit may retain local test captures. The fixture recovery script defaults to inspection; deletion requires `--apply`.

The packaged Docker editor passed save/reload/project/history/conflict tests under strict CSP. Production builds/TypeScript passed. Codec checks cover valid mappings and unsupported-policy/override rejection. Earlier contact/template isolation checks cover permissions, concurrency, document limits, suppression retention and forced RLS. Mocked analytics/message contract checks are separate from delivery evidence.

Historical full visual runs passed 19 desktop and five mobile reference captures below 0.05%. Five sampled captures in this integration pass also passed without runtime errors. These compare reference states, not all live dialogs, and are not zero-pixel or feature-completeness certification. Original design sources are unchanged. The reference editor's narrow-screen limitations remain; mobile visual parity is not proof of usable mobile editing.

Production UI dependencies reported zero known audit findings; build-tool dependencies still reported two high advisories involving `nanoid` and `source-map-js`. Those Node build dependencies are not runtime-installed in static Nginx. This is not a repository-wide clean audit. Known build warnings include large generated/editor chunks and a reference vendor CSS selector.

## Remaining release blockers

1. **Advanced campaigns:** resumable large-audience fan-out, operator recovery for no-evidence claims, automatic A/B winners/content variants, recurring sends, richer reporting/exports and scalability acceptance. Bounded subject-line A/B tests, immediate/scheduled sends, pending-message cancellation and evidence-only reconciliation are implemented; dispatched mail cannot be recalled.
2. **AI (deferred by user):** unchanged and outside this pass; not counted as completed or currently being worked on.
3. **Audience breadth:** collection/member editing UI, broader rules, pagination/large-data performance, reviewed resubscription, export and larger import jobs.
4. **Workflow breadth:** remaining graph vocabulary/business triggers/policies, visual version restore and fuller supported-state coverage. Context conditions, timed re-entry and run/version monitoring/cancellation are implemented.
5. **Delivery/editor:** image/asset storage, report ingestion UI, genuine sender DNS/ownership and external transport tests, separately configured inbox-placement tests.
6. **Identity/settings:** workspace switching, expanded role/expiry coverage and unsupported policy/legal/notification settings.
7. **Production operations:** chosen public hosting/domain, TLS, origins, secrets/providers/transport, deployment migrations, backup/restore, monitoring, realistic load and production acceptance. Dummy settings cannot verify these.
8. **Final review:** live-dialog/responsive visual sign-off and unresolved build-tool advisories.

This is a working local integration and hardening pass, not blanket production approval. No real external delivery or public deployment was activated.
