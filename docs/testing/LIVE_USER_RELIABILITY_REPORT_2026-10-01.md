# Live-user reliability report — 2026-10-01

## Decision

The local platform passes its deterministic suite and core live customer
journeys, but the expanded campaign found three P0 and five P1
release-readiness issues. Do not treat the current local result as production
approval. The P0 findings must be fixed and regression-tested before launch,
and the remaining provider/staging gates must still be executed in their real
environments.

## Environment

- One local API, worker, tracker, SMTP gateway, inbound/outbound Haraka pair.
- PostgreSQL 16 and Redis 7.
- Real local ClickHouse, Prometheus, Grafana, Alertmanager, Jaeger, and Mailpit.
- Free, Paid, Enterprise, compliance-admin, and regulated-workload fixtures.
- Test-mode keys for generated load traffic; no external delivery or sender
  reputation impact.

## Successful checks

- 176 automated files / 1,236 tests passed.
- Free, Paid, and Enterprise live persona journeys passed.
- Free quota boundary enforcement passed.
- Enterprise RBAC, SSO, SCIM, subaccount isolation, and audit-chain checks
  passed.
- HIPAA ordinary-send denial, secure-portal round trip, and breach assessment
  passed.
- FERPA amendment and disclosure accounting passed.
- SEC/FINRA failed closed when no real archive provider was configured.
- ClickHouse authenticated insert, daily-rollup read, and message-level delete
  passed.
- ClickHouse outage returned correct PostgreSQL fallback data.
- Redis and workers recovered after Redis was restored.
- Normal-user baseline (3 dashboard users + 1 send/s): 241/241 checks passed,
  no workload failures, no dropped iterations, dashboard request p95 153 ms,
  send p95 209 ms.
- Fresh ordinary-user run (5 dashboard users + 1 send/s): 200/200 checks
  passed, no failed or dropped iterations, dashboard p95 421 ms, send p95
  978 ms, and the temporary key was revoked by teardown.
- Release build completed successfully for shared, API, worker, tracker, SMTP
  gateway, and SDK workspaces.
- Admin-console and documentation/OpenAPI production builds completed
  successfully.
- Hostile-client checks rejected unauthenticated sends, invalid credentials,
  malformed JSON, oversized JSON, unknown routes, and unsupported methods.
- Security headers were present and an untrusted browser Origin was not
  reflected.
- SMTP submission refused unauthenticated envelope commands and invalid AUTH.
- Customer login abuse protection returned ten `401` responses followed by
  `429` with `Retry-After`; changing `X-Forwarded-For` did not bypass the
  email-keyed limiter.
- Prometheus authenticated scrapes were healthy for API, worker, tracker, and
  SMTP gateway after monitoring was restored; no alert was firing.
- The isolated real-TCP send harness accepted every request without a 429 or
  other error and peaked near 42 requests/s on one API process.
- Database dump and restore reproduced 116 tables, 96 migrations, and every
  sampled row count exactly; local restore time was 54.0 seconds.
- All 96 migration filenames were valid and uniquely ordered.
- Helm lint passed. Default and production-like values each rendered 27 valid
  Kubernetes objects, including deployments, services, config maps, migration
  job, network policies, autoscalers, disruption budgets, ingress, and the
  stateful workload.

## Findings

### P0 — Runtime dependencies contain known high-severity vulnerabilities

`npm audit --omit=dev --audit-level=moderate` reported nine production
dependency vulnerabilities: eight high and one moderate. Affected runtime
families include Fastify, Nodemailer, Undici, `fast-uri`, `@grpc/grpc-js`, and
`deepmerge-ts`. The advisories include validation/auth-routing bypasses, SSRF
and host-confusion cases, recipient-domain validation bypasses, cross-tenant
SMTP credential exposure, TLS validation bypass, response splitting, and
denial-of-service conditions.

The audit reports fixes are available. Upgrade and lock the patched versions,
rebuild every image, rerun the complete suite and live gates, and make the
production dependency audit a blocking CI job.

### P0 — Public tracker click route accepts an invalid UUID into PostgreSQL

The public route `/c/:encoded/:linkId` validates the encoded Message-ID but
passes `linkId` directly into a UUID comparison. A request with a valid encoded
Message-ID and `link-0` causes PostgreSQL error `22P02`, returns HTTP 500, and
logs a full stack trace.

At up to 400 simulated users this produced 18,249 HTTP 500 responses. Click
p95 reached 3.70 seconds, the tracker health request timed out once, and memory
rose to roughly 332 MiB. Malformed encoded IDs also produce one warning and
stack trace per open request. Because both routes are public, this is a cheap
log-amplification and resource-exhaustion vector.

Validate `linkId` as a UUID before querying, return a quiet bounded 400/404,
sample or rate-limit malformed-token logs, add per-route abuse controls, and
add regression/load tests for invalid encoded IDs and invalid UUIDs.

### P0 — Send API hangs when Redis is unavailable

Controlled reproduction:

1. Create a test-mode key for a verified Paid tenant.
2. Stop Redis while API/PostgreSQL remain available.
3. Submit one `POST /v1/send` request with a 20-second client timeout.

Observed:

- Client timed out after 20,088 ms without an HTTP response.
- API emitted repeated unhandled ioredis `ECONNREFUSED`, `ENOTFOUND`, and
  `ETIMEDOUT` errors.
- No message row was committed.
- No durable `send_outbox` row was committed.
- API and workers recovered after Redis returned.

Impact: client threads/connections remain occupied during a dependency outage,
retry behavior is ambiguous, and the advertised durable outbox cannot help
because Redis-dependent work blocks before the database transaction.

Required remediation:

- Bound every request-path Redis operation with a short deadline.
- Add a Redis circuit breaker and return a consistent `503` with
  `Retry-After` when required pre-admission services are unavailable.
- Attach explicit Redis error listeners so outages do not produce unhandled
  error events.
- Decide which admission checks can safely fail closed, use a bounded cached
  value, or move behind the durable database commit.
- Add a live outage test asserting response time, response envelope, and
  idempotent retry behavior.

### P1 — Legitimate customer ramp is hard-stopped by anomaly quarantine

Workload: 10 concurrent dashboard users plus 3 transactional sends/second for
two minutes.

Observed:

- The customer baseline was 51 messages/hour.
- At 256 messages in the active hour, the five-times-baseline detector marked
  traffic anomalous and diverted it to `quarantine`.
- The quarantine pool accepted 50 messages, then reached its stage-0 daily cap.
- 19 sends returned HTTP 429, 37 arrival iterations were dropped.
- Send p95 reached 3.89 s and dashboard p95 reached 2.58 s.
- PostgreSQL quota was not the cause (378 of 50,000 daily messages used).
- Queue depth returned to zero and worker health remained good.

The anti-abuse behavior is internally consistent, but a Paid customer can be
blocked far below their purchased quota after a legitimate launch or traffic
spike. Add plan-aware ramp policy, customer-visible warnings, retry guidance,
and an operator approval/override path. Alert explicitly on anomaly diversion
and quarantine capacity rather than presenting this as generic rate limiting.

### P1 — ClickHouse fallback is correct but slow

With ClickHouse stopped, `GET /v1/analytics/summary?period=7d` returned correct
PostgreSQL results in 4,223 ms.

Add a much shorter ClickHouse query/connect timeout and a circuit breaker so
subsequent requests skip the known-unhealthy analytics projection immediately.
The fallback is a resilience success, but four-second dashboard latency is not
an acceptable steady outage mode.

### P1 — Compliance evidence is incomplete

The live collection and review workflow succeeded for all eight controls, but
the selected evidence period reported:

- `CANSPAM-05`: missing
- `BASE-06`: missing
- `BASE-10`: missing

`CANSPAM-08`, `BASE-05`, `BASE-03`, `PCI-02`, and `HIPAA-07` were complete.
Production approval requires explaining and closing each missing control, not
merely proving that the evidence API can store and review a missing result.

### P1 — Tracker capacity misses its documented latency SLO

After correcting the workload to use canonical encoded Message-IDs and a valid
nonexistent UUID, the tracker answered 99.65% of 38,710 requests under its
defined ramp to 400 users. It still missed the performance thresholds:

- Open p95: 381 ms (target 75 ms).
- Click p95: 3.94 s.
- Combined p95: 3.19 s; p99: 5.12 s.
- 134 checks returned outside the accepted 200/302/404 statuses.

The unknown-click path performs a PostgreSQL lookup for every public request.
Add cache/negative-cache protection, route-specific rate limiting, connection
pool and query budgets, and horizontal tracker replicas. Repeat with real
valid links because that path additionally records an event and redirects.

### P1 — Restore privacy invariant cannot pass on the current dataset

The restore itself was exact, but the privacy gate found 18 source/restored
message rows whose `(customer_id, message_id)` also appears in
`privacy_message_tombstones`. No pseudonymized consent record was restored in
plaintext. The drill documents that development fixtures can intentionally
produce this state, so this result does not prove production erasure failure;
it does mean the current development database cannot provide release evidence
for the restore/re-deletion control.

Run the same drill against a clean production-shaped copy, replay tombstones
before serving restored traffic, and require zero joined message/tombstone
rows as a deployment gate.

### P2 — Observability containers can remain silently stopped

Prometheus and Grafana both received graceful termination during the campaign
and remained exited until manually started. Core services continued running.
The local compose deployment has no effective automatic recovery for these
services, allowing the platform to operate without dashboards or scraping.

### P2 — Historical failed jobs remain without an active alert

Redis retained 48 historical failed send jobs. Recent samples all reported
`inline bodies are read from the messages table, not the body store`; none was
created by the current run. Prometheus showed no firing alert. Define failed-job
retention/cleanup, alert on new failures and age, and expose a reviewed DLQ
workflow.

## Deployment configuration gate

The default `npm run prod:check` validates `.env.production.example` in
template mode; it does not validate deployable secrets or a real environment.
No `.env.production` is present. Running the checker against the current
development `.env` correctly fails for missing production database roles,
Redis authentication, OIDC/MFA policy, secure admin cookies, WORM audit
storage, production domains/CORS, and non-placeholder secrets. A real secret
file should not be committed, but generated deployment configuration must pass
this checker in the deployment system before any go-live approval.

## Load-test artifact

`infra/loadtest/normal-users.js` models dashboard page loads with think time,
weighted secondary navigation, a welcome/receipt/password-reset message mix,
occasional message polling, test-mode delivery, local-target protection, and
automatic temporary-key cleanup. Failure output includes the first response
body per VU/operation so rate limits, quota failures, and pool capacity failures
can be distinguished.

`infra/loadtest/tracker.js` now generates canonical encoded Message-IDs, uses a
valid nonexistent UUID for the normal not-found click path, groups dynamic URLs
to avoid k6 metric-cardinality exhaustion, and classifies expected 404s as
successful HTTP responses. The malformed-token/invalid-UUID campaign remains
separate adversarial evidence.

## Gates that still require non-local infrastructure

- Stripe, PayPal, and Cashfree sandbox lifecycle and webhook delivery.
- Real DNS propagation, DKIM signing/verification, SPF, DMARC, PTR, and MX
  delivery across representative providers.
- Real SES/direct-MX throttling, bounce, complaint, greylist, and reputation
  behavior.
- HA PostgreSQL/Redis/ClickHouse failover under concurrent traffic.
- Backup/restore on the intended production storage and region topology.
- Long soak test with memory, connection-pool, queue-age, and reconciliation
  trends.
- Browser matrix on the release build, accessibility pass, and slow-network
  session-expiry behavior.
- Container-image HIGH/CRITICAL scan in CI. Local Docker Scout required an
  authenticated Docker account and could not produce the report in this run.
- External penetration test and independent compliance review.
