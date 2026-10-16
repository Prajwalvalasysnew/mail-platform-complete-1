# Exact design migration

## Scope and acceptance

Preserve the four original customer designs: Customer App, Email Builder, Workflow Builder and AI Agent. Match layout, spacing, typography, assets, borders, shadows, colors, responsive behavior and interaction states. Changes to data and behavior must use production services without introducing sample records or simulated successful operations.

The earlier custom-styled React UI remains in source during migration but is no longer the Vite entry point. Docker 8080 serves compiled React; the ZIP reference is isolated on loopback 8081. Public production release is still pending.

## Implemented foundation

- Build-time conversion into normal React render functions and interaction controllers. No DC runtime or browser-time Babel/eval.
- All 3,290 reference elements, 309 conditional states, 246 collections and 1,908 bindings included in the source conversion inventory. These counts measure conversion scope, not individually tested flows.
- Original SVG icons, styles and static hover/focus rules; locally bundled Geist/Geist Mono fonts. GrapesJS runtime upgraded to 0.23.8 (bundled Underscore 1.13.8); the original 0.21.13 stylesheet and license are retained for appearance. External icon-font injection is disabled.
- Redux Toolkit session/workspace slices, RTK Query requests/cache, React Router, lazy editor/page loading and error boundary.
- Real login, MFA, session restore and registration; initial messages, key and webhook API adapters.
- Real password recovery and email verification links, responsive sign-in, session retry after transient failures, account-change cache isolation and logout cleanup. Local Compose account emails now go to Mailpit rather than being log-only; links target the React frontend.
- Tenant-scoped contacts with truthful empty-state counters, consent-aware creation, bounded atomic CSV import, persistence, unsubscribe suppression and deletion that retains opt-outs. Migration 099 forces tenant RLS. No reference contact counts or NaN percentages appear on a new workspace.
- Onboarding workspace-name persistence and actual backend DNS records; no example API credentials or generated placeholder DNS values are exposed in the authenticated flow.
- AI live routes explicitly disclose missing integration. Bounded immediate one-off campaigns, lists, supported segments, automations/workflow drafts and domain/DMARC monitoring now use tenant-scoped backend adapters; their limited supported scope is documented in RELIABILITY.md. Reference prototypes remain separate development-only comparison routes.
- Tenant-scoped template/editor-project persistence, immutable version snapshots, restore-to-draft, concurrent-save conflict checks, size limits and test-send requests through the existing sending guards. Redux-owned project data is copied before the mutable editor loads it. Editor storage does not use globally shared LocalStorage keys.
- Live Home/Analytics summaries and event charts; real message details/events; saved-template directory. Actual delivery statuses are kept separate from reference pill colors. Unsupported benchmarks, placement scores and canned AI insights are not presented as measurements.
- Workspace name/postal-address persistence; live sending domains and DNS records; team directory, invitations and roles; own active sessions and revocation; live billing/quota/invoice reads. Unsupported policy/legal/notification controls no longer simulate successful saves or signed agreements.
- Message activity feed with server cursor loading and 15-second refresh, actual event labels/details, masking, and formula-safe CSV export of visible rows. Canned diagnoses, fabricated headers and simulated resend/retry/suppression actions are removed from this adapter. Delivery-rate cards are not inferred from a partial activity feed.
- Automated screenshot comparisons and interaction smoke checks. Reports/screenshots are generated in ignored `test-results/` directories.
- Admin-pattern reliability hardening: active-section data loading, bounded safe-read retries, offline/error recovery feedback, visible-tab/reconnect refresh, duplicate-write guards, identity-boundary query cancellation and correct direct routing to `/api-keys`. See the follow-up review in RELIABILITY.md for acceptance scope and remaining limits.

## Release work still required

1. Extend domain/DMARC monitoring with report ingestion UI and separately configured inbox-placement testing. Finish remaining Settings capabilities. Completed adapters do not imply whole-application coverage.
2. Expand bounded campaigns with resumable large-audience fan-out, automatic A/B winner/content tests, recurring operations and operator recovery for no-evidence interrupted claims. Fixed 50/50 subject-line tests for 2–100 subscribers, durable scheduling, pending-message cancellation, evidence-only reconciliation, revision-protected drafts, consent-aware snapshots, one-time launch and actual message statistics are implemented. Basic lists and Created/Open/Click segments are implemented; broader collection editing/rules, reviewed resubscription and exports remain. CSV import/bulk writes and regular campaigns are bounded to 200 contacts/subscribers.
3. Finish email image/asset upload storage, expand editor/state checks and exercise test sending with a genuinely verified domain. Save/load/history/conflict checks are implemented, but a queued-send response is not proof of delivery.
4. Expand workflows beyond saved-template email, duration/event waits, A/B splits, signed POST webhooks and explicit context conditions/filters. Draft persistence, stale-write checks, immutable publication, dry run, pause, 30-day re-entry and paginated run/version history/cancellation are implemented. Visual restoration of a published version and unsupported business triggers/policies/overrides remain incomplete. Workflow sending uses saved template subject/preview and a verified domain.
5. AI is deferred by user request. Its live routes remain guarded; reference canned responses are not production AI behavior.
6. Finish workspace switching, identity/role presentation, authorization states, session expiry and teardown; confirm that all unsupported operations are handled consistently.
7. Expand screenshot/state checks to dialogs, drawers, all settings tabs, editor panels and supported responsive sizes. Review remaining pixel differences before visual sign-off.
8. Configure real public hosting/TLS/origins/secrets/transport and run production acceptance. The React Docker cutover, strict no-eval CSP, local browser/editor checks, configurable container upstream/DNS, non-root/read-only test, Helm lint/render and dummy-release rejection checks passed. This prepares deployment but does not verify a real cluster, certificates or Internet delivery; see DEPLOYMENT.md.

## Validation rules

Current migration verification (2026-10-15): 19 desktop comparisons at 1440×900 and five mobile comparisons at 390×900 passed the 0.05% regression threshold without browser runtime errors. Largest measured difference was 0.028% on desktop and 0.023% on mobile. Campaign dialog, navigation/settings, AI panels, workflow step inspector, email device switching and real customer login/API-key navigation smoke checks passed. These checks verify the converted reference views; production adapter coverage is still incomplete.

Additional checks (2026-10-16): real template save/reload, second-tab conflicts, version restoration and history preservation passed after the editor-runtime upgrade. Database checks passed tenant isolation, forced RLS with a non-bypass role, simultaneous updates and document-size rejection. Settings browser checks passed profile save/reload, strict input rejection, test-domain creation and DNS records, and live team/security/billing views; temporary domain records were deleted. Mocked contract checks separately verify Home event metrics/shared chart axes, actual message status labels and real message-detail response mapping. These mocked contract checks are not delivery tests. Customer-UI production dependency audit reports zero known findings; this is not a repository-wide audit.

After disabling the patched editor's additional external icon-font injection, the repeated 19 desktop and five mobile comparisons passed: maximum differences 0.028% (desktop) and 0.023% (mobile), no browser runtime errors. Email was 0.005% on desktop and 0.003% on mobile. The four original source-design hashes are unchanged. These are historical visual results; the current React Docker deployment and integration results are documented in RELIABILITY.md.

- Compare identical viewport, time, data and state; retain original/React/diff screenshots.
- Check browser runtime errors as well as image differences.
- Test real persistence separately from reference interaction parity.
- Never count a successful build, a working design preview or a screenshot threshold as production completion.

The preceding dated visual runs are historical evidence, not the current deployment status. See [RELIABILITY.md](RELIABILITY.md) for current local Docker acceptance, feature limits and remaining public-release blockers. The application is not yet approved for public production launch.
