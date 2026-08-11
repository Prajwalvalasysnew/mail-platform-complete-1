# Persona end-to-end feature matrix

This document records the behavior the product implements today. Persona tests
must validate this contract; they must not invent Free/Paid/Enterprise paywalls
that are not enforced in the application.

## Access model

- Plan tier currently changes quota, billing state, and send-lane priority.
- API functionality is authorized primarily by API-key scope.
- Dashboard functionality is authorized primarily by membership capability.
- Account status, email verification, physical address, and verified sender
  domain are independent delivery gates.
- A future commercial-entitlements project may narrow this matrix. Such a
  change requires product approval and dedicated allow/deny tests.

## Tier differences implemented today

| Contract | Free | Paid Pro | Enterprise |
| --- | ---: | ---: | ---: |
| Daily quota | 100 | 50,000 | 1,000,000 |
| Monthly quota | 3,000 | 1,000,000 | 50,000,000 |
| Standard send priority | 10 | 5 | 1 |
| Requested critical lane | Downgraded | Eligible | Eligible |
| Event/activity retention default | 7 days | 90 days | 365 days |
| Message-body retention default | 7 days | 90 days | 90 days |
| HIPAA mode activation eligibility | Not eligible | Not eligible | Evidence-gated |
| FERPA mode activation eligibility | Not eligible | Not eligible | Evidence-gated |
| SEC/FINRA mode activation eligibility | Not eligible | Not eligible | Evidence-gated |
| Billing plan | `free` | `pro` | `enterprise` |

Retention values are plan defaults and remain bounded by the deployment's
physical retention ceilings. A tenant override can tighten the effective
window; it cannot make underlying infrastructure retain data beyond its
configured ceiling.

## Free, Pro, and Enterprise feature sheet

Legend:

- **Yes**: available today when the required API-key scope, human capability,
  account state, and setup prerequisites are satisfied.
- **Downgraded**: accepted, but assigned the plan's normal queue lane.
- **Evidence-gated**: Enterprise eligibility alone is insufficient; every
  framework-specific prerequisite must be independently approved and
  unexpired.
- **No tier gate**: the application does not currently enforce a plan paywall
  for this feature.

### Account, identity, and credentials

| Feature | Free | Pro | Enterprise | Additional gate |
| --- | ---: | ---: | ---: | --- |
| Registration and email verification | Yes | Yes | Yes | Public/session flow |
| Login, logout, and password reset | Yes | Yes | Yes | User session |
| Active-session and device management | Yes | Yes | Yes | Full user session |
| Organization switching | Yes | Yes | Yes | Organization membership |
| TOTP MFA | Yes | Yes | Yes | User session |
| WebAuthn/passkeys | Yes | Yes | Yes | User session |
| Secret, publishable, and test API keys | Yes | Yes | Yes | `apikeys:manage` |
| Scoped key creation, rotation, and revocation | Yes | Yes | Yes | `apikeys:manage` |
| Team invitations and role changes | Yes | Yes | Yes | `members:manage`; no tier gate |
| SSO policy and enforcement | Yes | Yes | Yes | `settings:manage`; no tier gate |
| SCIM tokens and SCIM 2.0 provisioning | Yes | Yes | Yes | `members:manage`; no tier gate |

### Sending channels and content

| Feature | Free | Pro | Enterprise | Additional gate |
| --- | ---: | ---: | ---: | --- |
| Native REST single send | Yes | Yes | Yes | `send`, verified sender/setup |
| REST batch send | Yes | Yes | Yes | `send`, maximum 100 entries |
| Authenticated SMTP submission | Yes | Yes | Yes | `smtp` + `send` |
| SendGrid v3-compatible submission | Yes | Yes | Yes | `send` |
| Typed SDK | Yes | Yes | Yes | Underlying scopes |
| Text and HTML content | Yes | Yes | Yes | `send` |
| Templates and variables | Yes | Yes | Yes | `templates` / `send` |
| Custom headers, reply-to, and tags | Yes | Yes | Yes | `send` |
| Attachments | Yes | Yes | Yes | `send`, validation limits |
| Scheduled sending | Yes | Yes | Yes | `send` |
| Scheduled-message cancellation | Yes | Yes | Yes | `messages`, before dispatch |
| Idempotency keys | Yes | Yes | Yes | Single-send endpoint |
| Normal queue priority | 10 | 5 | 1 | Enforced tier difference |
| Requested critical lane | Downgraded | Yes | Yes | Per-tenant minute cap |
| Daily message quota | 100 | 50,000 | 1,000,000 | May be tightened by operator |
| Monthly message quota | 3,000 | 1,000,000 | 50,000,000 | May be tightened by operator |

### Domains, deliverability, tracking, and consent

| Feature | Free | Pro | Enterprise | Additional gate |
| --- | ---: | ---: | ---: | --- |
| Sending-domain lifecycle | Yes | Yes | Yes | `domains`/`domains:manage` |
| Domain verification and DNS records | Yes | Yes | Yes | Public DNS/setup |
| SPF, DKIM, and DMARC state | Yes | Yes | Yes | DNS/setup |
| DKIM rotation | Yes | Yes | Yes | Verified domain |
| Domain scanner and blocklist checks | Yes | Yes | Yes | `domains` |
| DMARC ingestion, summary, and sources | Yes | Yes | Yes | `domains` |
| TLS-required tenant setting | Yes | Yes | Yes | `messages` |
| Open tracking | Yes | Yes | Yes | Per-message/privacy controls |
| Click tracking | Yes | Yes | Yes | Per-message/privacy controls |
| Bot, prefetch, and Apple MPP classification | Yes | Yes | Yes | Tracking events |
| One-click unsubscribe | Yes | Yes | Yes | Always enforced where applicable |
| Unsubscribe groups and members | Yes | Yes | Yes | `suppressions` |
| Suppression list and import/export | Yes | Yes | Yes | `suppressions` |
| Consent history and proof | Yes | Yes | Yes | `suppressions` |
| Bounce and complaint suppression | Yes | Yes | Yes | Delivery-event path |
| IP pools, reputation, and warmup controls | Yes | Yes | Yes | Operational configuration; no tier gate |

### Messages, analytics, integrations, and automation

| Feature | Free | Pro | Enterprise | Additional gate |
| --- | ---: | ---: | ---: | --- |
| Message list and detail | Yes | Yes | Yes | `messages`, retention window |
| Message activity and event timeline | Yes | Yes | Yes | `messages`, retention window |
| Usage, quota, and statistics | Yes | Yes | Yes | `messages` |
| Analytics summary and time series | Yes | Yes | Yes | `messages`, retention window |
| Tag/domain/template breakdown | Yes | Yes | Yes | `messages` |
| Default event/activity history | 7 days | 90 days | 365 days | Deployment ceiling applies |
| Default stored-body history | 7 days | 90 days | 90 days | Deployment ceiling applies |
| Customer webhooks | Yes | Yes | Yes | `webhooks`; no tier gate |
| Webhook signatures and secret rotation | Yes | Yes | Yes | `webhooks` |
| Webhook delivery history, retry, and replay | Yes | Yes | Yes | `webhooks` |
| Workflow creation and validation | Yes | Yes | Yes | `workflows`; no tier gate |
| Workflow versions, publish, and restore | Yes | Yes | Yes | `workflows` |
| Workflow triggers, runs, waits, and branches | Yes | Yes | Yes | `workflows` |
| Workflow simulation and statistics | Yes | Yes | Yes | `workflows` |
| Data-export jobs and downloads | Yes | Yes | Yes | `messages`, retention window |

### Privacy, governance, and support

| Feature | Free | Pro | Enterprise | Additional gate |
| --- | ---: | ---: | ---: | --- |
| Recipient access export | Yes | Yes | Yes | `messages` |
| Recipient erasure and tombstones | Yes | Yes | Yes | `messages`, hold interlock |
| Rectification, restriction, and objection | Yes | Yes | Yes | `messages` |
| Sale/share opt-out and GPC | Yes | Yes | Yes | `messages` |
| Sensitive-PI limitation | Yes | Yes | Yes | `messages` |
| Privacy cases and appeals | Yes | Yes | Yes | `messages` |
| Consent records | Yes | Yes | Yes | `suppressions` |
| Legal holds | Yes | Yes | Yes | `messages`; no tier gate |
| Regulatory retention locks | Yes | Yes | Yes | `messages`; no tier gate |
| Customer audit feed and chain verification | Yes | Yes | Yes | `logs:read` / `members:manage` |
| Support tickets, conversation, and CSAT | Yes | Yes | Yes | `logs:read` |
| Subaccounts | Yes | Yes | Yes | `subaccounts`; no tier gate |
| Child keys and on-behalf-of sending | Yes | Yes | Yes | `subaccounts` |
| Parent-to-child template push | Yes | Yes | Yes | `subaccounts` |

### Billing and regulated modes

| Feature | Free | Pro | Enterprise | Additional gate |
| --- | ---: | ---: | ---: | --- |
| Billing overview | Yes | Yes | Yes | `billing:manage` |
| Hosted checkout and billing portal | Yes | Yes | Yes | Configured provider |
| Invoice and credit-note views | Yes | Yes | Yes | `billing:manage` |
| Plan-change preview, confirmation, and cancellation | Yes | Yes | Yes | `billing:manage` |
| HIPAA mode | No | No | Evidence-gated | Enterprise + approved HIPAA evidence |
| FERPA mode | No | No | Evidence-gated | Enterprise + approved FERPA evidence |
| SEC/FINRA mode | No | No | Evidence-gated | Enterprise + approved archive evidence |
| PAN/cardholder data in messages or tickets | Prohibited | Prohibited | Prohibited | No mode permits PAN |

### Catalogue metadata that is not an enforced paywall

The plan catalogue also stores feature metadata such as `team_seats`,
`dedicated_pools`, `sso`, `scim`, and `analytics_days`. At present,
`hasEntitlement()` can read that metadata, but the customer feature routes do
not use it to deny Free or Pro callers. Therefore:

- the tables above describe the actual enforced behavior;
- catalogue metadata must not be advertised as an active plan restriction;
- introducing seat limits or Enterprise-only SSO/SCIM/dedicated pools requires
  explicit route enforcement and allow/deny tests for every plan.

## Test-coverage audit

Reviewed against the expanded automated suite and the real local-development
release campaign completed on 2026-07-30: 176/176 files and 1,236/1,236 tests
passed, with 75.43% statements, 64.39% branches, 77.72% functions, and 79.42%
lines.
The dated local validation report records the wider service-level evidence.

The complete micro-level release plan is maintained in the
[End-to-End Production Test Plan](END_TO_END_PRODUCTION_TEST_PLAN.md).

The feature sheet is **not yet a statement that every cell has an independent
test**. Coverage currently falls into three groups:

1. **Three-persona E2E**: the same journey runs for Free, Pro, and Enterprise.
2. **Specialized automated**: the feature has unit/integration or API/service
   E2E coverage, but is not repeated for every plan.
3. **Pre-production gap**: a material permutation or real integration still
   needs a test before production.

The root `npm run test:coverage` gate now collects statement, branch, function,
and line coverage across compiled shared/API/worker/tracker/SMTP/SDK product
code and publishes HTML, LCOV, and JSON summaries in CI. Coverage remains one
signal rather than proof that every feature permutation executed.

### Features covered by the three-persona E2E suites

These flows run through `describe.each(PERSONA_TIERS)` for Free, Pro, and
Enterprise:

| Feature area | Three-persona evidence |
| --- | --- |
| Registration, verification, login, sessions, password reset, logout, organization plan resolution | `common-account-lifecycle.e2e.test.ts` |
| TOTP enroll/confirm/challenge/disable | `common-account-lifecycle.e2e.test.ts` |
| WebAuthn/passkey registration, authentication, and removal | `webauthn.test.ts` |
| Scoped API-key creation, use, rotation, and revocation | `common-credentials-domains.e2e.test.ts` |
| Domain creation, account/API visibility, verification attempt, and deletion | `common-credentials-domains.e2e.test.ts` |
| Template create/update/render/send/delete | `common-content-delivery.e2e.test.ts` |
| Attachments and tracked-link rewriting | `common-content-delivery.e2e.test.ts` |
| Scheduled send, cancellation, idempotency replay/conflict, and quota refund | `common-content-delivery.e2e.test.ts` |
| REST batch success, partial suppression, PAN rejection, quota accounting, and body offload | `common-content-delivery.e2e.test.ts`, `send-body-offload.e2e.test.ts` |
| Message list/detail/activity, usage, quota, stats, summary, timeseries, and tag breakdown | `common-content-delivery.e2e.test.ts` |
| Authenticated SMTP, SendGrid compatibility, and typed SDK submission | `common-channel-parity.e2e.test.ts` |
| Suppressions, consent history, unsubscribe groups, and enforcement | `common-consent-integrations.e2e.test.ts` |
| Webhook CRUD, secret rotation, delivery-list access, and SSRF rejection | `common-consent-integrations.e2e.test.ts` |
| Workflow validate/create/publish/simulate/trigger/run/version/stats/archive | `common-automation-privacy-support.e2e.test.ts` |
| Recipient export, downloadable export, legal-hold interlock, erasure, and deletion ledger | `common-automation-privacy-support.e2e.test.ts` |
| Customer support conversation, resolution, and CSAT | `common-automation-privacy-support.e2e.test.ts` |
| Team invite/accept, SSO setting, SCIM create/PATCH, and audit integrity | `common-governance-admin-resilience.e2e.test.ts` |
| Subaccount creation, child key/send, parent-domain isolation, invalid delegation, and suspension | `common-governance-admin-resilience.e2e.test.ts` |
| Admin customer/fleet visibility and cross-tenant denial | `common-governance-admin-resilience.e2e.test.ts` |

### Features covered by specialized tests, not every persona

These features have tests, but the suite does not currently prove the same
behavior independently for all three plans:

| Feature | Existing coverage | Remaining persona permutation |
| --- | --- | --- |
| Custom header safety and reply-to restrictions | `canspam-sender-identity.e2e.test.ts` | Add benign header/reply-to preservation to each persona |
| DKIM rotation | `dkim-rotation.test.ts` | Add route/scheduler/Haraka signing journey per plan |
| Domain scanner and blocklists | `domain-scanner.test.ts`, `send-priority.e2e.test.ts` | Add scoped successful/denied persona calls |
| DMARC reporting | `dmarc-reports.test.ts`, `dmarc.e2e.test.ts` | Add summary/source visibility per persona |
| TLS-required policy | `transport-security*.e2e.test.ts` | Add explicit Free/Pro/Enterprise policy journeys |
| Tracker open/click and bot classification | `bot-detection*.test.ts`, send-pipeline tracking tests | Drive tracker endpoints for each persona |
| One-click unsubscribe | `canspam-optout-friction.e2e.test.ts` and monitor tests | Repeat signed unsubscribe from each persona's message |
| Bounce/complaint suppression | DSN, bounce-parser, suppression, and sender-health tests | Repeat delivery-event attribution per plan |
| Webhook retry and dual-secret grace behavior | `webhook-retry.test.ts`, `webhook-sendgrid-parity.e2e.test.ts` | Repeat through persona-owned webhooks |
| Advanced workflow branches, waits, A/B, bulk trigger, cancellation, goals | `workflows.e2e.test.ts` | Repeat representative advanced journey per plan |
| Rectification, restriction, objection | `privacy-rights.e2e.test.ts` | Repeat authorization and state change per plan |
| Sale/share opt-out and GPC | `sale-share-optout.e2e.test.ts` | Repeat per plan |
| Sensitive-PI limitation | `sensitive-pi-limit.e2e.test.ts` | Repeat per plan |
| Privacy cases and appeals | `privacy-cases.e2e.test.ts`, `privacy-appeals.e2e.test.ts` | Repeat representative lifecycle per plan |
| Consent proof/confirm/withdraw | `consent-records.e2e.test.ts` | Repeat per plan |
| Regulatory retention locks | `regulatory-retention.e2e.test.ts` | Repeat per plan |
| Parent on-behalf-of send, usage rollup, and template push | `subaccounts.e2e.test.ts`; Enterprise persona has positive on-behalf-of | Add positive paths to Free and Pro personas |
| Billing checkout, portal, invoices, credit notes, and plan cancellation | `billing-outbound.e2e.test.ts` with mock provider | Add explicit plan-by-plan persona assertions |
| HIPAA/FERPA/SEC-FINRA Enterprise gates | `regulated-workloads.e2e.test.ts` plus portal/rights/archive suites | Free and Pro denial plus Enterprise evidence gating are explicit; provider qualification remains external |
| PAN prohibition | `pci-card-data.e2e.test.ts` | Send denial is explicit for every tier; keep SMTP/support channel permutations in the specialized suites |

### Code-controlled release-gate status

The highest-risk locally implementable gaps found in the audit were converted
to deterministic tests in this campaign. The remaining rows are additional
persona depth, not evidence that the underlying specialized control is absent.

| Priority | Gate | Status and evidence |
| --- | --- | --- |
| P0 | Product-code coverage collection | Implemented: worker-aware Vitest V8 gate, 75/64/77/79 regression floors, HTML/LCOV/JSON artifacts, and CI upload |
| P0 | Critical-lane cap and Redis failure | Implemented in `send-priority.e2e.test.ts` |
| P0 | Pro and Enterprise exact quota boundaries | Implemented in `quota-idempotency.e2e.test.ts` |
| P0 | Pro/Enterprise retention defaults and ceilings | Implemented in `retention-windows.e2e.test.ts` |
| P0 | Real webhook worker/receiver | Implemented in `webhook-worker-live.e2e.test.ts` |
| P0 | IP-pool/admin deliverability | Implemented in `admin-deliverability.e2e.test.ts` |
| P0 | Free/Pro/Enterprise regulated/PAN denial | Implemented in `regulated-workloads.e2e.test.ts` and `pci-card-data.e2e.test.ts` |
| P0 | Exact worker-generated click/unsubscribe artifact | Implemented through real Mailpit SMTP in `generated-links.e2e.test.ts`; also replayed over the real dev tracker |
| P0 | API/harness route and scheduler inventory parity | Implemented in `route-registration-parity.test.ts`, `openapi-route-parity.test.ts`, and `scheduler-inventory.test.ts` |
| P1 | Tier-parameterized MFA/passkeys | Implemented in `common-account-lifecycle.e2e.test.ts` and `webauthn.test.ts` |
| P1 | Tier-parameterized batch core | Implemented for success, suppression, PAN denial, quota refund, and offload |
| P1 | Tier-parameterized advanced privacy depth | Remaining: repeat rectification, restriction, objection, GPC, SPI, appeal, and regulatory-lock permutations per plan |
| P1 | Tier-parameterized billing-read depth | Remaining: repeat overview/invoice/credit capability permutations per plan |
| P1 | Positive subaccount depth | Enterprise positive and cross-tier denials exist; additional plan-contract permutations remain |
| P1 | Customer-facing feature route parity by plan | Registration parity exists; extend to a generated allow/deny contract for every future feature-sheet row |

### Production integrations that local tests cannot certify

These require a staging environment, provider sandbox, or target
infrastructure. They remain production blockers even after the code-controlled
tests above are added.

| Priority | Required staging/production-like test | Current limitation |
| --- | --- | --- |
| P0 | Real Haraka outbound delivery with DKIM verification | Local/CI delivery uses log or Mailpit; DKIM plugin logic is not proven against a receiving MX |
| P0 | Real SMTP STARTTLS negotiation and certificate validation | SMTP E2E explicitly uses `ignoreTLS: true`; transport-policy database logic is tested separately |
| P0 | Real inbound DSN/ARF round trip | Parsers are tested with fixtures, not through a live inbound Haraka delivery |
| P0 | Real SES sandbox delivery and provider throttling | SES transport is configurable but no provider sandbox runs in CI |
| P0 | Real Stripe/PayPal/Cashfree sandbox lifecycle | Outbound billing uses an injected mock; webhook cryptography is tested locally |
| P0 | Real Vault/AWS KMS and immutable-object-store custody | Provider selection/config guards are tested; real IAM, key custody, Object Lock, and retention are external |
| P0 | Real SEC/FINRA specialist archive | Fail-closed adapter behavior is tested; no qualifying archive tenant/provider is configured |
| P0 | Real ClamAV daemon scanning | Signature and scanner failure-policy paths are tested; production daemon operation is not |
| P1 | ClickHouse replica/durability campaign | Authenticated single-node insert, rollup read, and delete pass locally; replica loss, backup, and restore require target infrastructure |
| P1 | Observability receiver/trace campaign | All four Prometheus targets, 20 rules, three Grafana dashboards, Alertmanager ingestion, and Jaeger traces from API/worker/tracker pass locally; production paging delivery and trace retention require target receivers |
| Complete locally | Admin-console browser depth | 16 real journeys pass across Chromium, Firefox, and WebKit: login, HttpOnly restore, all 13 routes with WCAG 2 A/AA scanning, support/operator/admin/superadmin navigation and direct denials, 5xx/console-error checks, and logout. Real admin create/change/disable passes once in Chromium; two duplicate destructive runs are intentionally skipped. API-level mutation/RBAC coverage also passes. |
| P1 | Load, soak, queue-storm, and tracker-storm tests | Optimized Paid live-key local runs accepted every request with 0% HTTP failure, but still failed latency SLO (p95 1.95–3.38s, p99 2.46–4.14s); target-host capacity qualification and larger campaigns remain |
| P1 | Hetzner HA, backup, PITR, and failover campaign | Manifests/local drills exist; target topology and RPO/RTO are not proven |
| P1 | External penetration test and remediation retest | Automated security tests and image scans do not replace independent assessment |

### Production decision

The local suite is broad enough to gate continued development, but the feature
sheet is **not by itself a production certification**. Production approval
remains blocked until:

1. every P0 code-controlled test above passes in CI;
2. every P0 staging/provider integration produces retained evidence;
3. a coverage baseline and reviewed exception process exist;
4. the exact release commit passes the complete suite, not only focused tests;
5. remaining P1 items have either passed or received an explicit, time-bounded
   risk acceptance from the production owner.

## Customer feature coverage

`All` means the feature is available to every tier when the required scope or
human capability is present.

| Feature surface | Authorization today | Tier today | Persona E2E batch |
| --- | --- | --- | --- |
| API-first signup and email verification | Public token | All (starts Free) | Free onboarding |
| Human registration, login, logout, password reset | User session | All | Common account lifecycle |
| Active sessions and organization switching | Full user session | All | Common account lifecycle / enterprise RBAC |
| MFA and passkeys | User session | All | Common security |
| API-key create, list, rotate, revoke | `apikeys:manage` | All | Common credentials |
| Profile, address, TLS-required setting | `messages` scope | All | Common sending setup |
| Dashboard domain lifecycle | `domains:manage` | All | Common domains |
| API domain lifecycle and scanner | `domains` scope | All | Common domains |
| DMARC ingestion, summary, and sources | `domains` scope | All | Common deliverability |
| Native REST send and batch send | `send` scope | All | Common delivery |
| Template lifecycle and template send | `templates` scope | All | Common content |
| Attachments and body offload | `send` scope | All | Common content |
| Scheduled send and cancellation | `send` + `messages` | All | Common delivery |
| Critical send lane | `send` scope | Paid/Enterprise eligible | Tier differences |
| SMTP gateway | `smtp` + `send` scopes | All | Channel parity |
| SendGrid compatibility API | `send` scope | All | Channel parity |
| SDK | Underlying API-key scopes | All | Channel parity |
| Message list, detail, and activity | `messages` scope | All | Common observability |
| Usage, quota, stats, analytics | `messages` scope | All | Common observability |
| Suppressions and consent history | `suppressions` scope | All | Common consent |
| Unsubscribe groups and members | `suppressions` scope | All | Common consent |
| Customer webhooks and retries | `webhooks` scope | All | Common integrations |
| Dashboard webhooks | `settings:manage` | All | Common integrations |
| Workflows, versions, runs, simulation | `workflows` scope | All | Common automation |
| Data exports | `messages` scope | All | Common privacy/export |
| Recipient export and deletion | `messages` scope | All | Common privacy/export |
| Legal holds | `messages` scope | All | Isolated compliance |
| Support tickets and CSAT | `logs:read` | All | Common support |
| Team invitations and role changes | `members:manage` | All | Enterprise governance |
| SSO enforcement | `settings:manage` | All | Enterprise governance |
| SCIM tokens and SCIM provisioning | `members:manage` / SCIM token | All | Enterprise governance |
| Subaccounts and on-behalf-of sending | `subaccounts` scope | All | Enterprise governance |
| Customer audit feed and integrity | `logs:read` / `members:manage` | All | Enterprise governance |
| Billing overview and invoices | `billing:manage` | All | Paid/enterprise billing |
| Plan changes and provider lifecycle | `billing:manage` | All | Tier differences / billing |

## Cross-cutting assertions

Every persona feature journey must assert the applicable layers:

1. HTTP response and stable error code.
2. Tenant-owned database state.
3. Queue and worker completion for asynchronous operations.
4. Message event history and usage accounting.
5. Mailpit recipient, sender, subject, and body for delivered email.
6. Scope, role, and cross-tenant denial paths.
7. Admin API/console visibility in the safe development replay.
8. Idempotency and absence of duplicate rows or double-counted usage.

## Execution environments

- Canonical suites use isolated Postgres/Redis and may exercise destructive or
  global behavior.
- Safe development replays use unique run-tagged tenants, development Mailpit,
  and the admin console. They never run global retention, partition deletion,
  DLQ purge, audit tampering, or broad cleanup.
