# Local end-to-end validation report — 2026-07-29 to 2026-07-30

## Decision

The repository is suitable for continued development and provider/staging
qualification. It is **not approved for production** by this report.

All locally deterministic functional gates passed. The real Paid live-key load
gate accepted every request but missed the latency SLO, and several controls can
only be proven using target infrastructure, contracted providers, and
independent assessors.

## Exact automated result

| Gate | Result |
| --- | --- |
| Test files | 176/176 passed |
| Tests | 1,236/1,236 passed; 0 skipped |
| Statements | 75.43% (10,050/13,323); floor 75% |
| Branches | 64.39% (5,684/8,827); floor 64% |
| Functions | 77.72% (1,731/2,227); floor 77% |
| Lines | 79.42% (9,224/11,614); floor 79% |
| Workspace build | Passed |
| Admin build | Passed |
| Admin browser | 16 passed across Chromium, Firefox, and WebKit; 2 intentional duplicate-mutation skips |
| Documentation strict build | Passed |
| Production dependency audit | 0 high/critical production findings |
| Production-pruned image dependency audit | 0 findings during image builds |

The final authoritative run used the real development PostgreSQL
(`localhost:5432`), Redis (`localhost:6379`), and Mailpit SMTP/API
(`localhost:1025`/`localhost:8025`) with a unique BullMQ prefix and the separate
test containers stopped. It completed in 1,137.28 seconds. The equally complete
V8 coverage run passed all 1,236 tests in 1,232.40 seconds.

Coverage uses the worker-aware Vitest V8 provider against mapped product code
from shared, API, worker, tracker, SMTP gateway, and SDK packages. HTML, LCOV,
and JSON artifacts are written to `coverage/product` and uploaded by CI.

The full development dependency graph has 25 known findings (19 high and 6
moderate) in the Docusaurus build toolchain. They are not present in the pruned
runtime graph, but dependency maintenance remains required.

## Real local topology

The current source was built into development images and run with PostgreSQL,
Redis, Mailpit, API, worker, tracker, SMTP gateway, inbound/outbound Haraka,
Prometheus, Grafana, Alertmanager, Jaeger, and ClickHouse.

| Surface | Evidence |
| --- | --- |
| API | `/health` and `/ready` passed PostgreSQL, Redis, and queue checks |
| Tracker | Health and real signed unsubscribe requests passed |
| Worker metrics | Listener active on port 9100; protected metrics correctly require credentials |
| SMTP metrics | Listener/health active on port 9102 |
| Prometheus | Four configured targets healthy; four rule groups and 20 rules loaded |
| Grafana | Three dashboards provisioned |
| Alertmanager | Synthetic `LocalReleaseGate` alert accepted and resolved |
| Jaeger | `mail-api`, `mail-worker`, and `mail-tracker` all emitted real traces |
| ClickHouse | Authenticated insert, daily-rollup read, and message-level delete passed |
| Mailpit | Real worker SMTP messages and generated artifacts captured |

The API used host port 3003, Prometheus 9091, and Grafana 3004 for the final
campaign because unrelated local processes owned 3000, 9090, and 3002. Compose
defaults remain 3000, 9090, and 3002 and are overridable. Final live probes
reported four of four project Prometheus targets up, authenticated worker
metrics returning Prometheus text, project Grafana healthy, and Jaeger listing
`mail-api`, `mail-worker`, and `mail-tracker`.

## Customer and persona journeys

The additive real-development runner passed Free, Paid Pro, and Enterprise
journeys against the non-test database and services.

Run ID: `1785277734870-bsk5r`

| Tier | Customer ID | Result |
| --- | --- | --- |
| Free | `f00c07e7-006e-4f83-87a0-5d536c6bd0eb` | Passed |
| Paid Pro | `87f71d5e-09c8-42ac-8d38-3ad3d1c3a8bd` | Passed |
| Enterprise | `ac794906-6c7a-4728-8221-d6f1b9617d01` | Passed |

The journeys covered registration, verification, sessions, scoped live keys,
profile/domain state, template CRUD, suppressions and consent, processing
records, support, idempotent API → queue → worker → Mailpit delivery, usage and
Free quota behavior. Enterprise additionally covered RBAC, SSO, SCIM,
subaccounts, tenant isolation, and audit verification.

Persona replay run `1785278032254-fqmi7` produced six accepted messages and the
verification runner found the messages in Mailpit and admin-visible state.

## Generated artifacts and unsubscribe regression

The worker-generated message test uses the exact click and unsubscribe URLs
captured from real Mailpit SMTP output. It verifies redirect behavior,
RFC 8058 one-click POST suppression, and blocking of the next send.

The exact URL from the real development message was also sent through the live
tracker over HTTP:

- URL length: 119 characters;
- GET: 200;
- POST: 200;
- resulting development suppression rows: 1.

This prevents a handcrafted short token from hiding router-length, encoding, or
worker serialization defects.

## Regulated-workload and compliance-supporting journeys

Run `1785277756964-p9yci` passed:

- ordinary HIPAA content denied while regulated mode was unavailable;
- encrypted secure-portal delivery and HIPAA breach-assessment workflow;
- FERPA amendment and disclosure-accounting workflows;
- SEC/FINRA archive provider absence failing closed with zero accepted records.

SOC2-06 local evidence automation persisted and reviewed eight control records.
HIPAA access review and the GDPR live persona also passed. The local evidence
collector correctly reported missing operating evidence for `CANSPAM-05`,
`BASE-06`, and `BASE-10`; it did not turn missing runs into false zero-count
successes.

These are technical controls and workflow evidence, not certifications:

- PAN remains prohibited in all modes.
- HIPAA, FERPA, and SEC/FINRA modes remain individually disabled by default and
  evidence-gated for Enterprise.
- No mode may be enabled merely because another mode passed.

## Browser and administration

Sixteen real Playwright journeys passed across Chromium, Firefox, and WebKit:

- admin login;
- HttpOnly session restoration;
- navigation across all 13 console routes;
- automated WCAG 2 A/AA scans across every route;
- support, operator, admin, and superadmin navigation matrices;
- direct-route denial for insufficient roles;
- a real superadmin create, role-change, and disable lifecycle;
- no authenticated API 5xx responses;
- no authenticated console errors;
- logout.

The real superadmin create/change/disable mutation passed once in Chromium.
Its Firefox and WebKit duplicates are intentionally skipped to avoid repeating
a destructive shared-database operation; all non-destructive route,
accessibility, session, and role gates run in all three engines. The gate uses
unique per-engine identities and one worker so real login-abuse controls remain
enabled. Local HTTP explicitly uses `ADMIN_COOKIE_SECURE=false`; production
Compose and the readiness checker enforce `ADMIN_COOKIE_SECURE=true`.

Backend role, JIT/elevation, MFA, access-review, audit, fleet, support, abuse,
KYC, billing, deliverability, IP-pool, retention, and DLQ behaviors remain
covered by the API/service suite. The browser expansion found and corrected
role-inappropriate navigation, muted-text contrast, unnamed dialogs,
keyboard-inaccessible scrollable tables, unlabeled ticket controls, and a
concurrent support read-marker unique-index race that returned HTTP 500.

## Resilience and deployment validation

| Gate | Result |
| --- | --- |
| PostgreSQL backup/restore | Passed: 110 tables, 96 migration records, counts matched |
| Restore privacy replay | Passed: tombstone/pseudonym checks, no prohibited resurrection |
| Redis failover | Passed: replica promoted, marker and three queued jobs survived, writes resumed |
| Helm lint/render | Passed default and production-like values; 27 manifests |
| Compose config | Passed with monitoring and analytics profiles |
| ClickHouse listener/auth | Passed using explicit IPv4 listener and credentials |

Local PITR could not be executed because the repository's PITR path requires
CloudNativePG and an object store with non-placeholder credentials. Hetzner
multi-node RPO/RTO, backup custody, and failover must be proven on the target
cluster.

## Load result

The valid local load run used a newly created Paid tenant, a real `mp_live_`
key, a verified local domain, and explicit 10,000/minute API/send ceilings so
the performance test measured the accept path rather than the default
300/minute protection.

| Metric | Result | SLO |
| --- | ---: | ---: |
| Accepted | 286/286, 163/163, 152/152, and 180/180 (100%) | >99% |
| HTTP failures | 0% in all optimized sampled repeats | <1% |
| p95 | 1.95–3.38s | <250ms |
| p99 | 2.46–4.14s | <500ms |

The correctness/error-rate gates passed; both latency gates failed. Ten-percent
trace sampling improved one run relative to always-on tracing, while suppressing
info logs did not remove the bottleneck. The optimized path reduced a sampled
request from 50–51 spans to 46 and reduced four separate insert statements to
one atomic data-modifying CTE. It also collapsed billing/account/hold checks,
quota baselines, and recipient screening into fewer queries and dispatched
newly committed outbox rows directly with durable fallback. The remaining local
latency is dominated by PostgreSQL/WAL and Docker scheduling under concurrent
load on this workstation. Production approval remains blocked on capacity
tuning and repeatable target-host load, soak, queue-storm, and tracker-storm
campaigns.

## Fixes made during this campaign

- resolved delivery transport when the worker starts, allowing the real
  generated-link test to use the intended Mailpit transport;
- added exact generated click/unsubscribe artifact coverage;
- added API and scheduler inventory parity guards;
- added Free/Pro/Enterprise quota, retention, MFA/passkey, batch, PAN, and
  regulated-mode boundary coverage;
- added authenticated ClickHouse requests and ClickHouse DateTime64
  serialization;
- added ClickHouse IPv4 listener configuration and health check;
- corrected Prometheus secret mounting so every scrape target authenticates;
- corrected duplicate Helm pod-template labels;
- added live webhook-worker/receiver and admin deliverability tests;
- corrected API/worker tracing startup order with early bootstrap entrypoints;
- added parent-based 10% trace sampling controls to avoid always-on
  high-cardinality database/Redis span export during normal operation;
- exposed documented rate-limit overrides through development Compose;
- replaced incomplete coordinator-only coverage with worker-aware product
  coverage and CI regression floors.
- collapsed send admission billing/account/hold evaluation into one recursive
  query and made the quota database baseline lazy on Redis cache misses;
- combined recipient suppression/privacy/domain screening into one RLS query,
  cached warmup and empty new-tenant baselines, and reduced common-path database
  round trips;
- made common commercial message/event/outbox persistence one atomic
  data-modifying CTE, with deterministic direct BullMQ dispatch and durable
  outbox re-drain on failure;
- preserved scheduled-send cancellation by leaving scheduled outbox rows
  pending until the scheduler dispatches them;
- corrected Vitest 4 tracker workspace resolution and made the exact
  worker-generated link test default to real development Mailpit ports;
- changed the API Docker dependency layer to use all workspace manifests and a
  BuildKit npm cache, so source-only rebuilds reuse dependency installation.
- added 16 passing Chromium/Firefox/WebKit journeys for four admin roles,
  direct denials, WCAG 2 A/AA, and a real create/change/disable mutation;
- made local HTTP cookie behavior explicit and added a production readiness
  gate that requires secure admin cookies;
- corrected role-filtered navigation, accessible modal naming, WCAG contrast,
  keyboard-focusable scroll tables, and labeled support controls;
- replaced support read-marker update-then-insert with an atomic partial-index
  upsert and proved it under 12 concurrent requests.

## Remaining production blockers

### Target-host or staging evidence

1. Repeat the send-accept gate on the sized target host and meet the approved
   p95/p99 SLO; the local Windows Docker result remains a failed qualification.
2. Run production-duration soak, queue-storm, and tracker-storm campaigns on
   the staging topology.

### Target infrastructure or provider evidence

1. Real receiving-MX DKIM and SMTP STARTTLS/certificate validation.
2. Real inbound DSN/ARF round trip.
3. SES sandbox delivery and provider throttling.
4. Stripe, PayPal, and Cashfree sandbox lifecycles.
5. Vault or cloud KMS with production IAM and rotation.
6. Independently controlled immutable audit/object storage.
7. Real ClamAV daemon operation.
8. ClickHouse replica loss, backup, and restore.
9. Hetzner HA, PostgreSQL PITR, RPO/RTO, and multi-node failover.
10. Production paging receiver delivery and trace retention.
11. A qualifying SEC/FINRA specialist archive and retained receipts.
12. HIPAA/FERPA contracts, policies, training, exercises, and independent
    framework-specific assessments.
13. External penetration test, remediation, and retest.

Until the applicable blockers are closed, regulated modes must remain disabled
and the deployment must not claim certification or accept regulated workloads.
