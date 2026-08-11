# End-to-End Production Test Plan

> Created: 2026-07-29
> Scope: every customer, operator, delivery, tracking, billing, privacy,
> compliance, observability, and infrastructure capability in this repository.
> Status: locally executable gates completed on 2026-07-30. Target-host,
> provider-sandbox, production-infrastructure, and independent-assessment gates
> remain release blockers; see the linked local validation report.

## 1. Objective

Prove that every advertised and internally operated platform feature works from
its real entry point to its final externally visible and persisted outcome,
including:

- success paths;
- validation and boundary paths;
- authentication and authorization;
- cross-tenant isolation;
- asynchronous queue and worker completion;
- retries, idempotency, and crash recovery;
- generated tokens, URLs, MIME, signatures, and provider payloads;
- failure handling and safe degradation;
- audit, metrics, logs, traces, and alerts;
- retention, erasure, backup, restore, and failover;
- Free, Pro, and Enterprise behavior;
- real production-like network, proxy, TLS, DNS, and provider behavior.

The goal is not a larger test count. The goal is traceable evidence that no
feature can be merged or released without a test at the correct layer.

## 2. Why the unsubscribe regression matters

The unsubscribe failure is the model for this plan:

- component logic could generate and decode a valid token;
- tests could pass with short or handcrafted parameters;
- the actual generated URL crossed a framework/router parameter limit;
- the defect appeared only when a real delivered link was opened;
- a correct E2E test needed the real message ID, generated token, complete URL,
  router, tracker, database write, and response behavior.

Every feature that generates an artifact must therefore test the artifact it
actually generated. Tests must not replace real output with a shorter fixture
unless a separate fixture test is explicitly intended.

### Mandatory generated-artifact rule

For every token, URL, header, signature, file, MIME part, receipt, export, or
provider request:

1. create it through the production code path;
2. capture it from the same place a user or downstream system receives it;
3. send it through the real next hop;
4. assert the final state and side effects;
5. repeat at expected, maximum, malformed, expired, replayed, and tampered
   boundaries;
6. prove the result is not an HTTP `414`, router error, unhandled `500`,
   duplicate operation, tenant leak, or silent no-op.

## 3. Current scope baseline

The repository currently contains:

- 176 automated test files;
- 1,236 tests in the 2026-07-30 real-development product-aware full run;
- 82 root unit/database-integration files;
- 89 API/service E2E files;
- 10 persona E2E files;
- 291 literal route registrations under `packages/api/src/routes`;
- additional API health/readiness/metrics/OpenAPI routes;
- eight tracker routes;
- dynamic workflow pause/resume actions;
- authenticated SMTP submission;
- inbound and outbound Haraka services;
- six worker responsibilities;
- 29 scheduled operational jobs;
- 96 PostgreSQL migrations through `097`.

Existing tests are inputs to this plan, not automatic proof of completion.
Fastify `inject` tests are service E2E; they do not replace real-socket,
reverse-proxy, TLS, browser, or provider E2E tests.

The local browser gate now has 16 passing journeys across Chromium, Firefox,
and WebKit. It covers all 13 admin routes, WCAG 2 A/AA scans, HttpOnly session
reload, four role matrices, direct denial, logout, and authenticated
5xx/console-error detection. The destructive superadmin create/change/disable
journey passes once in Chromium; duplicate mutation runs in Firefox and WebKit
are intentionally skipped.

## 4. Definition of end to end

A feature is E2E-complete only when its applicable chain is proven:

```text
Real entry point
  -> proxy/TLS/router
  -> authentication + authorization
  -> validation + policy gates
  -> database transaction/outbox
  -> Redis/BullMQ
  -> worker/scheduler
  -> SMTP/tracker/webhook/provider/object store
  -> final database/event/usage/audit state
  -> customer/admin read surface
  -> metrics/log/trace/alert evidence
```

For synchronous features, irrelevant queue/provider steps may be marked
not-applicable, but authentication, persistence, isolation, audit, and readback
must still be asserted.

## 5. Test environments

### E0: pull-request deterministic stack

Run on every pull request:

- PostgreSQL 16;
- Redis 7;
- built API, worker, tracker, SMTP gateway, SDK, and shared packages;
- real network listeners, not only Fastify injection, for selected smoke tests;
- Mailpit;
- local webhook receiver;
- test clock/failure controls;
- no external paid provider.

Purpose: fast deterministic feature and regression protection.

### E1: nightly full local stack

Run nightly and before release:

- production-built containers;
- Nginx/reverse-proxy routes;
- API, all workers, tracker, SMTP gateway, inbound/outbound Haraka;
- PostgreSQL and Redis;
- Mailpit;
- real ClickHouse container;
- real ClamAV container;
- Vault development server with production-like auth policy;
- S3-compatible object store with versioning and retention behavior where
  technically possible;
- Prometheus, Grafana, Alertmanager, Jaeger;
- browser automation for admin and secure portal;
- generated TLS certificates and STARTTLS.

Purpose: full local topology and generated-artifact tests.

### E2: provider sandbox

Run on release candidates and provider changes:

- Stripe test mode;
- PayPal sandbox;
- Cashfree sandbox;
- Amazon SES sandbox;
- controlled public DNS zone;
- test webhook endpoints with public TLS;
- AWS KMS test key or dedicated non-production account;
- production-style Vault;
- object storage with genuine Object Lock;
- test Postmaster/SNDS integration where provider access permits.

Purpose: prove contracts, signatures, permissions, retries, and provider
version behavior.

### E3: Hetzner staging

Run on the exact deployment candidate:

- Terraform-applied three-node topology;
- production Helm values with staging secrets;
- ingress certificates;
- CloudNativePG;
- production Redis topology;
- remote object storage;
- ClickHouse topology;
- network policies and service mTLS where enabled;
- full monitoring and alerts;
- realistic dataset and load;
- backup/PITR/failover.

Purpose: prove the deployable system, not only the source tree.

### E4: independent assessment

- external penetration test;
- remediation and retest;
- framework-specific assessment;
- operational access review;
- incident/breach tabletop;
- production-readiness approval.

## 6. Required test dimensions

Every scenario must declare applicable values from these dimensions.

| Dimension | Required values |
| --- | --- |
| Plan | Free, Pro, Enterprise |
| Key mode | test, live |
| Human role | owner, admin, developer, analyst, billing, unauthorized member |
| Admin role | support, operator, admin, superadmin, disabled/elevation-expired |
| Tenant relation | same tenant, unrelated tenant, parent, child, former member |
| Channel | REST, batch, SMTP, SendGrid compatibility, SDK, workflow |
| Content | text, HTML, template, Unicode, empty, maximum size, attachment, regulated |
| Time | current, scheduled, expired, clock boundary, retention boundary |
| Retry state | first attempt, duplicate, transient failure, permanent failure, exhausted |
| Concurrency | one request, duplicate concurrent request, quota race, worker race |
| Network | healthy, timeout, reset, DNS failure, TLS failure, partial outage |
| Data lifecycle | create, read, update, delete, archive, retain, restore, re-delete |

Not every Cartesian combination must be duplicated. Pairwise/risk-based
selection is allowed only when the omitted combinations are recorded and the
common implementation path is proven.

## 7. Assertions required in every feature E2E

Each test must assert all applicable layers:

1. HTTP/SMTP/browser response and stable error code.
2. Response headers, cookies, redirects, cache policy, and content type.
3. Database state under the correct tenant.
4. Absence of cross-tenant rows or secret leakage.
5. Queue job creation, priority, delay, completion, retry, or removal.
6. Worker outcome.
7. Final message, event, export, webhook, provider, or case state.
8. Usage/quota effect and refund behavior.
9. Delivered MIME or actual downstream request.
10. Audit action and actor attribution.
11. Required Prometheus metric.
12. Required structured log/trace with sensitive fields redacted.
13. Idempotent replay result and absence of duplicate side effects.
14. Cleanup, retention, and erasure behavior.

## 8. Test data rules

- Use unique run IDs.
- Create customers through public registration for primary journeys.
- Use APIs for feature setup whenever the API exists.
- Direct database seeding is allowed only for preconditions that cannot be
  created publicly, failure injection, or performance setup.
- Mark every direct database mutation in the test.
- Never use real PAN, PHI, education, or brokerage data.
- Use synthetic `.invalid`, `example.com`, or controlled staging domains.
- Capture secrets only in test memory; redact reports.
- Test Unicode local display names, international content, emoji, combining
  characters, and right-to-left text where accepted.
- Test minimum, normal, documented maximum, maximum plus one, malformed,
  truncated, duplicated, and expired inputs.

## 9. Traceability and automatic parity gates

### E2E-TRACE-001: route-to-test parity

Build the Fastify applications, call `printRoutes()`, normalize parameter names,
and require every registered route to map to:

- one authenticated/authorized success test;
- one unauthenticated test where applicable;
- one wrong-scope/role test;
- one cross-tenant test for tenant resources;
- validation/boundary tests for mutation routes.

Intentional exclusions must include a reason, owner, and expiry date.

### E2E-TRACE-002: feature-to-test parity

Every row in `PERSONA_FEATURE_MATRIX.md` must have:

- feature ID;
- enforcing source location;
- plan behavior;
- automated test ID;
- required environment;
- latest result;
- evidence artifact.

### E2E-TRACE-003: scheduler-to-test parity

Every scheduler job name must map to:

- due/not-due behavior;
- distributed lock behavior;
- successful effect;
- no-work result;
- partial/transient failure;
- retry/recovery;
- metrics/log/audit evidence.

### E2E-TRACE-004: migration-to-feature parity

Every migration must be exercised by:

- fresh install;
- upgrade from the previous supported release;
- repeated migration runner;
- checksum mismatch protection;
- application startup against the migrated schema;
- rollback/forward-fix runbook where destructive rollback is unsupported.

### E2E-TRACE-005: code coverage

Collect statement, branch, function, and line coverage for shared, API, worker,
tracker, SMTP gateway, and SDK packages. Initial thresholds must reflect the
measured baseline, then rise to the approved production target. Security,
authorization, billing, privacy, compliance, and deletion modules require
explicit higher branch thresholds and may not use blanket exclusions.

## 10. Account and identity scenarios

### Registration and verification

- `ACC-001`: register Free organization and verify email.
- `ACC-002`: registration normalizes email and prevents duplicates.
- `ACC-003`: concurrent duplicate registration remains atomic.
- `ACC-004`: invalid email, weak password, missing name, oversized values.
- `ACC-005`: verification email is actually delivered and link opens.
- `ACC-006`: generated verification token normal, maximum expected, malformed,
  truncated, expired, reused, and cross-user.
- `ACC-007`: resend invalidates or coexists according to policy without token
  confusion.
- `ACC-008`: unknown-account resend does not leak account existence.
- `ACC-009`: production send remains blocked until verification.
- Repeat required plan-independent flows for Free, Pro, and Enterprise.

### Login, password, sessions, and organizations

- correct and incorrect password;
- unknown user indistinguishability;
- per-account and per-IP rate limits;
- lockout, expiry, recovery, and audit;
- password-forgot email delivery;
- generated reset-link boundary/tamper/replay tests;
- reset revokes existing sessions;
- session list and current-device marker;
- revoke one and revoke others;
- concurrent revoke/use race;
- logout and token replay;
- organization switch allowed/denied;
- removed membership cannot switch or continue using old context;
- sole-owner account deletion refusal;
- non-sole-owner deletion and identifier anonymization;
- current-user export contains no hashes, tokens, or encrypted seeds.

### TOTP and WebAuthn

- Free, Pro, Enterprise TOTP enroll/confirm/challenge/disable;
- wrong, expired, skewed, and replayed TOTP;
- MFA partial session cannot call full-session endpoints;
- invitation flow cannot bypass MFA;
- passkey registration/authentication/removal for every plan;
- wrong origin, RP ID, challenge, signature, credential owner, and sign count;
- cloned-authenticator/sign-counter regression;
- deleting another user's credential returns safe not-found;
- password reset/MFA/passkey session interaction.

### API keys, scopes, and roles

- create/list/rotate/revoke for every plan;
- plaintext appears exactly once;
- secret/publishable/test key restrictions;
- every individual scope allow/deny;
- combined scopes;
- expired key;
- rotation overlap and post-overlap failure;
- concurrent rotation;
- revoked key cache invalidation;
- suspended tenant and child behavior;
- every customer role against every capability;
- invitation create/list/accept/cancel;
- role update/removal;
- last-owner protection;
- former member loses sessions and resource access.

### SSO, OIDC, and SCIM

- SSO setting read/update for every plan under the current no-tier-gate
  contract;
- password login blocked only for the enforced organization;
- another organization for the same user remains usable according to policy;
- OIDC issuer, audience, nonce, state, redirect, expiry, and signature;
- required MFA/authentication-context claim in production;
- unknown IdP and removed membership;
- SCIM token create/list/revoke and secret shown once;
- ServiceProviderConfig;
- user list/get/create/PATCH/PUT/delete;
- active/inactive/reactivation;
- duplicate email/external ID;
- pagination/filter behavior;
- wrong/revoked token;
- cross-tenant SCIM user ID;
- SCIM-created membership follows role and offboarding policy;
- all identity and provisioning mutations appear in audit.

## 11. Sending-channel scenarios

### Native REST single send

- Free, Pro, Enterprise live send.
- Test-key sandbox send.
- Text-only, HTML-only, and multipart.
- Unicode sender name, subject, and content.
- Multiple recipients and per-recipient message IDs.
- Reply-to and benign custom headers preserved.
- forbidden identity/routing headers rejected.
- CRLF/header injection rejected.
- tags and metadata preserved.
- template rendering and missing-variable error.
- tracking on/off combinations.
- unsubscribe group.
- scheduled time and timezone boundary.
- requested normal/critical priority.
- idempotency replay, body conflict, in-progress concurrency, and expiry.
- verified/unverified/missing sender domain.
- unverified account, suspended account, sender hold, inactive billing.
- suppression, restriction, group opt-out, sensitive-PI tracking limit.
- queue backpressure and `Retry-After`.
- payload/body/recipient/tag/header maximum plus one.

### Commercial identity and CAN-SPAM

- transactional versus commercial classification;
- ambiguous classification fail-safe behavior;
- verified sender identity;
- configured physical postal address required for commercial sends;
- footer appended after template rendering and tracking transformation;
- footer in both HTML and text;
- HTML-escaped physical address;
- template/variable cannot remove or replace the footer;
- working unsubscribe target in every commercial message;
- benign custom headers preserved;
- From, Reply-To override, Return-Path, List-Unsubscribe, and internal routing
  header spoofing rejected;
- same enforcement on single, batch, SMTP, SendGrid, and workflow sends;
- sender-health hold and synthetic unsubscribe monitor evidence.

### Batch send

For every plan:

- 1, normal, 100, and 101 entries;
- unique and duplicate recipients;
- mixed templates/content/from domains;
- partial suppressions;
- all suppressed;
- one invalid item and transaction atomicity;
- quota exactly sufficient and one unit short;
- regulated-content item among ordinary items;
- body offload;
- scheduled batch;
- failure before and after quota reservation;
- crash between database commit and Redis enqueue;
- no attachments/critical priority silently accepted where unsupported.

### SMTP gateway

- real TCP connection;
- AUTH success/failure/lockout;
- key missing `smtp` or `send`;
- MAIL FROM verified/unverified/cross-tenant;
- one/multiple RCPT TO;
- partial and all suppression;
- MIME text/HTML/multipart;
- attachments and renamed executable;
- malware;
- Unicode headers and folded headers;
- message-size maximum plus one;
- connection, command, recipient, and per-plan rate limits;
- idle timeout and abrupt disconnect;
- STARTTLS available/required;
- real certificate validation;
- no credential leakage in logs;
- submission enters the same message/event/quota pipeline.

### SendGrid compatibility

- canonical request;
- multiple personalizations;
- substitutions and metadata;
- tracking settings;
- attachments;
- suppression;
- native failure translated into SendGrid error shape;
- unsupported dynamic-template ID guidance;
- malformed compatibility payload;
- response codes/headers expected by migration clients.

### SDK

- every exposed SDK resource;
- default/custom base URL;
- timeout;
- retryable and non-retryable statuses;
- retry cap and idempotency interaction;
- structured error fields;
- webhook signature verification;
- Node supported-version matrix;
- package built and installed from the release artifact, not workspace source.

## 12. Quota, priority, outbox, and worker scenarios

### Plan limits

- Free 100/day and 3,000/month boundary.
- Pro 50,000/day and 1,000,000/month boundary.
- Enterprise 1,000,000/day and 50,000,000/month boundary.
- exact limit accepted; next unit rejected atomically.
- concurrent reservation cannot oversell.
- day/month rollover in configured timezone policy.
- child cap and parent rollup.
- cancel/refusal/failure refunds only when delivery is impossible.
- no double refund.

### Priority

- normal priorities 10/5/1 by plan;
- Free critical request downgraded with `tier_not_eligible`;
- Pro and Enterprise critical granted;
- exact per-minute cap and cap plus one;
- recipient-count accounting;
- Redis failure downgrades with `rate_capped`;
- next-minute recovery;
- queue ordering under mixed-plan load.

### Outbox and workers

- transaction creates message/outbox atomically;
- Redis unavailable during request;
- delayed drain after Redis recovery;
- crash before queue add;
- crash after queue add before outbox update;
- duplicate queue job;
- stale `enqueued` reclamation;
- stale `sending` recovery;
- transport transient/permanent failures;
- attempt count and backoff;
- terminal failure event;
- quota behavior;
- no stranded messages;
- DLQ insertion, replay, delete, purge, and duplicate replay.

## 13. Domain, DNS, and deliverability scenarios

### Domains, SPF, DKIM, and DMARC

- account and API domain CRUD parity;
- normalization, duplicate, public-domain validation, cross-tenant denial;
- controlled DNS zone with missing/incorrect/correct ownership, SPF, DKIM,
  DMARC;
- DNS timeout, SERVFAIL, NXDOMAIN, multiple TXT fragments, oversized records;
- encrypted private key at rest;
- real outbound DKIM signature verified by an independent verifier;
- selector rotation, overlap, scheduler retirement, and rollback;
- DMARC reporting address stability;
- gzip/XML report normal, duplicate, malformed, oversized, decompression bomb;
- aggregate summary/source correctness and tenant isolation;
- DMARC retention and legal hold.

### Scanner, reputation, pools, and warmup

- scanner public-domain validation and SSRF-safe behavior;
- optional blocklist skip;
- controlled listed/clean IP;
- DNSBL timeout/partial provider failure;
- pool health clean/watch/pause/recovery;
- exact bounce and complaint thresholds;
- low-volume protection;
- sender hold, reviewer release/uphold/escalate;
- blocklist scan admin role matrix;
- warmup stage progression, cap, pause, resume, and clock boundary;
- Google Postmaster/SNDS disabled, success, auth failure, rate limit, stale data;
- volume baseline and anomaly detection.

## 14. Tracking and unsubscribe scenarios

### Generated URL test matrix

For open, click, unsubscribe, verification, reset, invitation, export, secure
portal, and workflow trigger URLs:

- capture the URL from delivered email or API output;
- resolve through Nginx and the real service listener;
- typical production-generated token;
- longest valid generated token;
- configured maximum path/parameter size;
- maximum plus one;
- URL-encoded and Unicode-adjacent content;
- truncated, extra segment, invalid base64url, bad signature;
- expired;
- replayed;
- token belonging to another tenant/message;
- no router `414`, unhandled `500`, or database type error.

### Open and click

- generated pixel returns correct image/content/cache headers;
- generated click redirects to the exact target;
- invalid/unsafe target handling;
- one first timestamp and multiple raw events according to policy;
- bot, prefetch, Apple MPP, human, datacenter IP;
- click without open;
- user-agent/IP redaction and retention;
- sensitive-PI limit disables present and already-in-flight tracking;
- erased/tombstoned message cannot be tracked back into existence.

### Unsubscribe

- actual link extracted from delivered Free, Pro, and Enterprise messages;
- GET page requires no login;
- RFC 8058 POST requires no prior GET;
- global and group unsubscribe;
- immediate suppression enforcement;
- repeated POST idempotency;
- link remains usable for the required period;
- no fee, survey, email re-entry, or unnecessary fields;
- message ID/token at real and maximum generated lengths;
- malformed 180-character and much larger values return controlled `400/404`,
  never router `414` or database `500`;
- HTML and text footer links both work;
- customer template cannot remove footer;
- GPC interaction;
- synthetic monitor detects broken, slow, or inconsistent paths;
- unsubscribe event, consent ledger, audit, metrics, and webhook.

## 15. Message, usage, analytics, and export scenarios

- cursor pagination first/middle/last/malformed;
- stable ordering with equal timestamps;
- every filter individually and combined;
- maximum limit clamp;
- scheduled list ordering;
- message detail and attachment metadata without content;
- held-message safe reason;
- event status precedence under out-of-order delivery;
- duplicate event idempotency;
- usage daily/monthly/history;
- analytics 24h/7d/30d and retention clamping;
- hourly/daily series;
- tag/domain/template breakdown;
- PostgreSQL result versus real ClickHouse result;
- ClickHouse outage fallback;
- reconciliation watermark only after confirmed insert;
- duplicate event collapse;
- downloadable event and metadata exports;
- export pending/completed/failed/expired;
- export worker crash/recovery;
- cross-tenant artifact denial;
- maximum date range and retention clamp;
- content type, filename, streaming, and no message bodies.

## 16. Suppression, consent, and list-quality scenarios

- suppression add/list/remove/import/export;
- case normalization and duplicates;
- hard bounce, complaint, manual, unsubscribe sources;
- unsuppress and append-only history;
- CSV/import maximum, malformed, duplicate, mixed-validity behavior;
- list-quality invalid, role, disposable, spam-trap results;
- huge unique-domain list chunking;
- accept/review/reject threshold boundaries;
- unsubscribe-group CRUD and member CRUD;
- delete group referenced by messages;
- consent request/confirm/proof/withdraw;
- wrong/expired/replayed confirmation;
- suppression versus consent independence;
- cross-tenant recipient equality;
- all sending channels and workflows enforce current state.

## 17. Webhook scenarios

- CRUD through API and account surfaces;
- event validation;
- URL normalization;
- SSRF: loopback, private, link-local, IPv6, DNS rebinding, redirect chain;
- generated 32-byte secret;
- HMAC over exact raw payload;
- real local/public receiver verifies body, headers, timestamp, event ID;
- event filter;
- successful delivery record;
- timeout, reset, DNS failure, TLS failure;
- 408, 429, every 5xx retry;
- permanent 4xx no retry;
- exponential backoff and exhaustion;
- worker restart mid-attempt;
- duplicate job/idempotent receiver guidance;
- secret rotation, old-secret grace, second rotation, cleanup;
- test endpoint;
- replay one delivery;
- retry failures;
- source event removed by retention;
- cross-tenant replay denial;
- sensitive fields absent from logs/traces.

## 18. Workflow scenarios

- definition schema minimum/maximum;
- invalid graph, cycle, missing target, foreign template;
- create/read/update/archive;
- publish immutable version;
- pause/resume;
- restore version;
- signing secret and tampered trigger;
- API single/bulk trigger;
- idempotent trigger;
- re-entry rules;
- send, wait, event wait, conditional branch, A/B split, goal exit;
- engagement-event start;
- suppression/complaint/unsubscribe exit;
- scheduled continuation;
- cancellation;
- archive cancels active runs;
- worker restart while parked/running;
- overdue and stuck recovery;
- run/stat correctness;
- cache invalidation after update;
- erasure removes subject journey;
- retention deletes finished runs;
- all core journeys for every plan.

## 19. Billing scenarios

### Plan and access

- Free/Pro/Enterprise overview and quota values;
- provider-authenticated upgrade;
- downgrade at period end;
- cancellation to Free;
- trialing, active, past-due grace, expired grace, unpaid, incomplete, canceled;
- recovered billing restores sending;
- subaccount inherits parent billing;
- price catalogue live/test environment and inactive/unknown price;
- catalogue feature metadata is not accidentally enforced as an undocumented
  paywall.

### Checkout, portal, invoices, tax, credits

- real Stripe/PayPal/Cashfree sandbox checkout;
- customer created once;
- success/cancel/return URL validation;
- portal session;
- invoices and line items tenant isolation;
- tax/currency/rounding;
- credit note/refund;
- plan preview, confirm, cancel, expiry, reconciliation, SLA;
- duplicate/concurrent provider events;
- event transaction rollback and replay;
- dunning email stages and idempotency;
- metering drift and alert.

### Payment-data safety

- PAN/CVV in every accepted free-text field;
- Unicode separators and formatted variants;
- message, SMTP, support, billing webhook;
- reject or redact as designed;
- raw payload never stored/logged/traced;
- hosted payment flow never posts card data to the platform.

## 20. Privacy and data-lifecycle scenarios

### Rights

- export, rectification, restriction/release, objection;
- sale/share opt-out and GPC;
- sensitive-PI limit/release;
- processing record and measures schedule;
- privacy case create/verify/transition/extend/artifact/communication;
- appeal create/list/decide/deadline/escalation;
- lawful state-transition rejection;
- pseudonymized identifiers and no raw sensitive statements.

### Erasure

- inline body;
- offloaded body;
- attachment;
- event/link/outbox/soft-bounce/suppression/workflow;
- ClickHouse deletion;
- queued/delayed/active BullMQ jobs;
- worker race during erasure;
- object deletion transient/permanent failure and retry;
- tombstone prevents resurrection;
- repeated request idempotency;
- legal/regulatory hold returns conflict;
- tenant isolation;
- restore then tombstone replay before traffic;
- backups expire according to policy.

### Retention and holds

- Free 7/7;
- Pro 90/90;
- Enterprise requested 365/90 with physical ceiling;
- tenant tightening;
- read visibility at boundary;
- body/event/message/link/export/webhook/support/DMARC cleanup;
- tenant and recipient holds;
- hold release;
- audit archive before purge;
- partition create/drop/default rows;
- failed run is persisted;
- metric/alert when a sweep stops running.

## 21. Regulated-workload scenarios

### Activation

- Free denied for HIPAA, FERPA, SEC/FINRA.
- Pro denied for all three.
- Enterprise request allowed but activation blocked initially.
- HTTPS artifact, SHA-256 shape, expiry, reviewer separation.
- missing, rejected, expired, self-approved, wrong-framework evidence.
- complete evidence and admin decision.
- modes independent.
- suspend reason and post-suspension enforcement.
- evidence replacement/review and audit.

### Classification and channels

- value-free PAN/PHI/education/broker classification;
- text, HTML, template output, metadata, attachment filename/text where
  supported;
- single, batch, SMTP, SendGrid, workflow, support;
- obfuscated and boundary samples;
- no sensitive value in error, audit, log, trace, metric, or review queue;
- PAN always prohibited.

### Secure portal, rights, and archive

- HIPAA/FERPA ordinary delivery blocked/redirected according to policy;
- two separately delivered portal credentials;
- both required;
- wrong, cross-recipient, expired, revoked, replayed;
- encrypted content at rest;
- no-store response;
- access audit;
- HIPAA rights/disclosure/breach lifecycle;
- FERPA access/amendment/hearing/disclosure/redisclosure lifecycle;
- SEC/FINRA archive-before-accept;
- real provider receipt validation;
- provider timeout/unavailable/malformed receipt accepts zero;
- reconciliation and retention lock;
- real external prerequisite evidence before staging activation.

## 22. Audit, control evidence, and immutable storage scenarios

### Audit integrity

- every security/customer/admin mutation emits the expected action;
- actor ID/type/label, tenant, resource, IP, and safe metadata;
- concurrent writers maintain a valid tenant chain;
- cross-tenant chains remain independent;
- intentional row/metadata/hash mutation is detected;
- archive-before-purge preserves continuity;
- chain continues correctly after archive;
- verification API role matrix;
- no secret or regulated source value in audit metadata.

### Checkpoints and WORM export

- Ed25519 checkpoint generation and signature verification;
- key rotation/incorrect key behavior;
- complete segment and signed head exported;
- checksum and sequence verified after retrieval;
- KMS encryption context;
- genuine Object Lock COMPLIANCE retention;
- ordinary admin cannot overwrite/delete;
- partial upload, timeout, duplicate export, and retry;
- checkpoint does not advance until export confirmation;
- independently controlled credentials;
- restore/reconcile missing export.

### Monthly control evidence

- each expected control produces complete/partial/missing correctly;
- a missing operational run becomes a finding, never a zero-count pass;
- collection at most once for a closed month;
- manual recollection;
- recollection clears earlier review;
- reviewer role and immutable sign-off;
- evidence rejects email and credential-shaped fields;
- period/timezone/calendar boundary;
- scheduler outage alert;
- access-review ordinary, break-glass, appropriate, inappropriate, immutable
  decision, and retention preservation.

## 23. Support, abuse, KYC, and admin scenarios

### Customer support

- create/list/detail/read/reply/rate;
- unread count;
- resolved-only CSAT;
- SLA clock;
- cross-tenant denial;
- card data blocking;
- attachment/content limits if supported;
- notification email delivery.

### Admin API

Every one of the 81 literal admin routes must pass:

- minimum allowed role;
- every lower role denied;
- disabled/expired session denied;
- CSRF/origin/fetch-metadata checks for cookie mutations;
- bearer-tooling behavior;
- audit record for read/mutation where required;
- customer/tenant attribution;
- input boundary;
- not-found/cross-tenant safety;
- destructive confirmation/rate limit.

Feature journeys must cover:

- fleet overview/timeseries/top tenants;
- tenants, notes, update, suspend, reinstate;
- support inbox, SLA, triage, suggested reply, canned responses;
- abuse single/bulk approve/reject;
- KYC approve/request info/reject;
- pools, reputation, blocklist;
- sender health review;
- DLQ replay/delete/purge;
- billing events/replay/reconcile;
- payment gateways;
- settings and retention;
- audit pagination/filter/export;
- admins/password/disable/self-lockout;
- elevations/break-glass/expiry/access review;
- control evidence collection/review;
- regulated evidence and workload review;
- privacy tombstone replay.

### Admin browser

Playwright must use the production-built SPA behind the real gateway:

- password login;
- MFA step;
- cookie bootstrap/reload;
- CSRF;
- session expiry/401 cache purge;
- role-based navigation;
- every screen load/error/empty state;
- every mutation;
- destructive typed confirmation;
- browser back/refresh/deep link;
- keyboard navigation;
- WCAG automated checks;
- Chromium, Firefox, WebKit;
- no secret in local/session storage;
- CSP/security-header validation.

## 24. Scheduler scenarios

Each of these 26 jobs requires due, no-op, effect, failure, recovery, lock,
metric, and log tests:

1. `send_outbox_drain`
2. `export_drain`
3. `webhook_secret_rotation_cleanup`
4. `reputation_guard`
5. `blocklist_monitor`
6. `warmup_advance`
7. `dkim_retire`
8. `clickhouse_reconcile`
9. `privacy_erasure_retry`
10. `canspam_unsubscribe_monitor`
11. `idempotency_sweep`
12. `metering_reconcile`
13. `sender_health_sweep`
14. `billing_dunning_sweep`
15. `billing_plan_change_expiry`
16. `billing_plan_change_reconcile`
17. `billing_scheduled_downgrade_apply`
18. `billing_plan_change_sla`
19. `admin_elevation_expiry`
20. `audit_checkpoint`
21. `partition_maintenance`
22. `daily_retention`
23. `control_evidence_collection`
24. `postmaster_ingest`
25. `volume_baseline_update`
26. `stale_send_recovery`
27. `workflow_run_sweep`
28. `workflow_run_retention`
29. `review_queue_timeout`

The current source contains 29 named entries even though earlier inventory
summaries described 26 operational jobs. The automated parity gate must use
source discovery so documentation count drift cannot hide a job.

## 25. Observability scenarios

- `/live`, `/health`, `/ready` during healthy and each dependency failure;
- authenticated/unauthenticated metrics;
- every service scraped by Prometheus;
- expected targets green;
- each critical alert forced in staging;
- Alertmanager receiver confirms notification and resolution;
- Grafana dashboard queries return non-empty correct series;
- API -> queue -> worker -> SMTP/tracker/webhook trace propagation;
- correlation IDs across logs;
- no PAN, PHI, email body, token, secret, password, DKIM key, or MFA seed;
- log/metric cardinality limits;
- retention and disk-full behavior;
- clock skew.

## 26. Security scenarios

- authentication bypass and token confusion;
- customer/admin audience separation;
- scope/role/capability matrix;
- IDOR across every `:id`, `:email`, `:messageId`, `:customerId`;
- SQL/NoSQL/template/header/HTML injection;
- SSRF and DNS rebinding;
- path traversal and unsafe filenames;
- request smuggling/proxy normalization;
- rate-limit bypass by header/IP variants;
- CSRF, CORS, Origin, Fetch Metadata;
- session fixation;
- cookie flags;
- password/key/token entropy and expiry;
- secrets in error/log/trace/export;
- dependency/image/SBOM scan;
- DAST against E3;
- external penetration test and retest.

Fuzz route parameters, generated tokens, MIME parsers, DSN/ARF, DMARC XML,
webhook payloads, template variables, workflow definitions, and privacy case
state transitions.

## 27. Performance, soak, and chaos scenarios

### Load

- sustained send rate per plan;
- burst and queue backpressure;
- REST batch maximum;
- SMTP connection/recipient concurrency;
- tracker open/click/unsubscribe storm;
- webhook retry storm;
- workflow bulk enrollment;
- large message/event history;
- analytics with production-sized ClickHouse;
- export and erasure batches;
- admin list pagination.

### Soak

- 24-hour minimum staging soak;
- stable memory, handles, connections, queue lag, and disk;
- scheduler executes across clock boundaries;
- no duplicate events, sends, billing, or evidence.

### Chaos

- kill API during transaction;
- kill worker before/after send;
- Redis loss and promotion;
- PostgreSQL primary loss;
- ClickHouse outage;
- object-store outage;
- DNS failure;
- Haraka restart with queued mail;
- webhook receiver outage;
- KMS/Vault temporary denial;
- full node loss and network partition;
- recovery meets approved RPO/RTO.

## 28. Deployment, backup, restore, and migration scenarios

- clean Terraform plan/apply/destroy in staging account;
- Helm render and apply;
- migration pre-install/pre-upgrade job only once;
- upgrade from every supported release baseline;
- application compatibility during rolling deploy;
- rollback to compatible image or forward-fix;
- certificate issue/renewal;
- network-policy allow and deny;
- pod disruption and HPA;
- PostgreSQL full restore;
- PITR to selected timestamp;
- Redis promotion with queued jobs;
- ClickHouse restore;
- object-store restore/version handling;
- audit Object Lock survives operator deletion attempt;
- restored privacy tombstones replay before readiness;
- backup expiry and legal-hold interaction;
- measured RPO/RTO stored as evidence.

## 29. CI and release pipeline

### Pull request gates

- build every package, including admin console and docs;
- migration validation;
- unit/integration/API E2E;
- three-persona core E2E;
- route/feature/scheduler parity;
- code coverage;
- OpenAPI parity/breaking change;
- npm audit, SBOM, Trivy;
- deterministic browser smoke.

### Nightly gates

- E1 full topology;
- all persona suites;
- generated-link suite;
- real webhook receiver;
- ClickHouse/ClamAV/Vault/object-store integration;
- admin browser matrix;
- scheduler suite;
- moderate load and failure injection.

### Release-candidate gates

- exact release commit;
- clean E0 and E1;
- E2 provider sandboxes;
- E3 Hetzner deployment;
- HA/restore/PITR/failover;
- load/soak/chaos;
- security scan and current external assessment;
- signed evidence manifest.

## 30. Evidence artifacts

Every release must retain:

- commit SHA and image digests;
- environment/version manifest;
- migration list/checksums;
- test result XML/JSON;
- code coverage;
- Playwright traces/screenshots/videos on failure;
- Mailpit/MIME samples without sensitive data;
- webhook receiver records;
- DNS/DKIM/TLS verification;
- provider sandbox IDs;
- Prometheus snapshots and fired alerts;
- Grafana dashboard screenshots/export;
- Jaeger trace IDs;
- backup/failover timestamps and RPO/RTO;
- vulnerability/SBOM results;
- penetration-test report and remediation retest;
- approved exceptions with owner and expiry.

## 31. Defect policy

- P0/P1 security, isolation, data-loss, double-send, unsubscribe, billing,
  regulated-content, erasure, or restore defects block release.
- Every production or manual-test defect gets:
  - a minimal regression test;
  - a real-artifact E2E test when the defect crossed components;
  - root-cause classification;
  - review of sibling paths;
  - evidence that the fix passed in the environment where the defect could
    occur.
- A focused passing test never replaces the full release suite.
- Flaky tests are defects; quarantine requires owner, reason, and expiry and
  cannot make a production gate green.

## 32. Implementation sequence

### Phase A: make missing coverage impossible to hide

Deliver:

- runtime route inventory and route-to-test parity;
- feature IDs added to the persona matrix;
- scheduler discovery/parity;
- Vitest coverage reports and CI thresholds;
- test-result/evidence manifest keyed by commit SHA.

Exit: an unmapped route, feature, scheduler, or expired exception fails CI.

### Phase B: close deterministic code-controlled gaps

Add or extend:

- `persona-auth-security.e2e.test.ts`;
- `persona-batch-boundaries.e2e.test.ts`;
- `persona-plan-limits.e2e.test.ts`;
- `persona-retention-contract.e2e.test.ts`;
- `persona-privacy-advanced.e2e.test.ts`;
- `persona-billing-reads.e2e.test.ts`;
- `persona-subaccounts-full.e2e.test.ts`;
- `persona-regulated-denials.e2e.test.ts`;
- `critical-lane-cap.e2e.test.ts`;
- `admin-deliverability.e2e.test.ts`;
- `webhook-worker-live-receiver.e2e.test.ts`.

Exit: every plan-contract cell has a deterministic allow/deny test.

### Phase C: generated artifacts and real local topology

Create the E1 stack and add:

- delivered-email link extraction library;
- verification/reset/invite/open/click/unsubscribe/secure-portal URL suite;
- Nginx real-socket route tests;
- SMTP STARTTLS tests;
- inbound/outbound Haraka round trip;
- real ClickHouse, ClamAV, Vault, object-store, webhook receiver;
- scheduler suite;
- Prometheus/Alertmanager/Jaeger synthetic checks.

Exit: every generated artifact crosses the same router/service boundary used in
deployment, and all local integrations pass without mocks.

### Phase D: browser coverage

Add Playwright projects for:

- admin authentication/session/CSRF;
- every admin screen and mutation;
- secure-portal access/revocation/expiry;
- unsubscribe page GET and POST;
- verification/reset/invitation links;
- Chromium, Firefox, WebKit, and accessibility.

Exit: production-built browser surfaces pass behind the real gateway.

### Phase E: provider sandboxes

Automate:

- SES send/bounce/complaint sandbox;
- Stripe lifecycle;
- PayPal lifecycle;
- Cashfree lifecycle;
- controlled DNS/DKIM/DMARC;
- AWS KMS/Object Lock;
- real non-production SEC/FINRA archive when contracted.

Exit: every configured production provider has a green sandbox contract test
and retained provider IDs/receipts.

### Phase F: Hetzner staging and resilience

Execute:

- exact Terraform/Helm deployment;
- migration upgrade;
- realistic load and 24-hour soak;
- node/database/Redis/worker/network chaos;
- backup, restore, PITR, privacy replay, and failover;
- alert and trace verification;
- measured RPO/RTO.

Exit: approved service objectives are met with the exact release images.

### Phase G: independent production approval

Complete:

- external penetration test;
- remediation;
- retest;
- framework-specific assessment;
- operational access review;
- incident/breach tabletop;
- evidence review and signed release decision.

Exit: no open P0/P1 release blocker or expired risk acceptance.

## 33. Completion criteria

The platform may be considered E2E-ready for production only when:

- every registered route is mapped and green;
- every feature-sheet row is mapped and green;
- every scheduler job is mapped and green;
- every Free/Pro/Enterprise contract cell is tested;
- all generated-artifact boundary tests pass;
- all P0 code-controlled gaps pass in CI;
- all P0 provider/staging tests have retained evidence;
- admin browser flows pass;
- real SMTP/DKIM/TLS and bounce/complaint round trips pass;
- real billing-provider sandbox lifecycles pass;
- privacy erase/restore and regulated fail-closed behavior pass;
- observability alerts and traces pass;
- load, soak, restore, PITR, and failover meet approved targets;
- independent penetration-test findings are remediated/retested;
- the exact release commit and image digests are approved;
- no expired test exception remains.

Until all criteria are satisfied, documentation must say **production testing
incomplete** and regulated modes must remain disabled.
