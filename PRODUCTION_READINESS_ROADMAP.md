# Production-Readiness Roadmap — toward "10/10 like SendGrid"

This is an honest gap analysis after a deep code review. It separates **what the
code does well**, **real gaps found in this pass**, and **what a code review
structurally cannot tell you** — the things that actually decide whether a
platform performs like SendGrid in production.

---

## TL;DR

The **application code is strong** — auth, password/key hashing, quota, idempotency,
rate limiting, DKIM, SSRF, and header-injection defenses are all done correctly,
and after the audit + hardening work the suite is **508/508 green**. Across the
review, **10 real bugs were found and fixed** (stale-send recovery, batch
body-drop, bounce double-count, /profile 401, webhook DNS-rebind, RLS dormancy,
customer + admin TOTP replay, admin-MFA brute-force, GDPR body-erasure), plus a
scalability bottleneck (per-recipient round-trips) and several robustness gaps —
each backed by a regression test.

But "10/10 like SendGrid" is a **platform** claim, not a code claim. The real
remaining distance is in deliverability, cluster-scale validation, an independent
security review, and operational maturity — none of which a code audit can
certify. Those are laid out as Phases 2–4 below.

---

## What the code does genuinely well

- **Password hashing** — scrypt (memory-hard), NFKC-normalized, self-describing
  params with transparent rehash, constant-time verify.
- **API key verification** — peppered HMAC-SHA256, constant-time, prefix-indexed
  lookup (no full scans), typed keys (live/test/publishable).
- **Rate limiting** — Redis-backed (cross-instance), per-key with IP fallback,
  stricter per-endpoint caps on send/batch, proper 429 + Retry-After + headers,
  fail-open on Redis error.
- **Injection defenses** — Handlebars with HTML-escaping on (no stored XSS via
  vars); nodemailer handles header CRLF sanitization; custom header names are
  regex-restricted; all `sql.raw` sites interpolate compile-time constants, not
  user input.
- **Security headers** — full set (CSP, HSTS, nosniff, frame-deny, permissions).
- **Delivery robustness** — transactional outbox, DLQ on retry exhaustion, stale-
  send recovery (fixed), DKIM fail-closed via DENYSOFT.

These are the parts most platforms get wrong. They're right here.

---

## Real gaps found in this review (code-level, actionable)

> **UPDATE — Phase 1 COMPLETE.** All five gaps below (A–E) have been fixed and
> tested. Full suite is now **497/497 green** with 5 new regression tests:
> RLS isolation proven under a non-privileged role (including the "forgot the
> WHERE filter" leak case) via a new `withTenant()` helper + `rlsIsEnforced()`
> startup check; 1 MB caps on send/template bodies; `last_used_at` throttled to
> ≤1 write/key/60s via a Redis gate; `analytics.ts` `sql.raw` interpolation
> replaced with static fragments; and `releaseQuota` clamped at zero.
> The one remaining **ops** step for (A): run the API under a dedicated
> non-BYPASSRLS Postgres role and route tenant queries through `withTenant` —
> the mechanism and tests are in place; the role assignment is a deployment task.


### A. RLS is dormant — cross-tenant "defense in depth" is not active (High)

`023_rls.sql` enables RLS on all tenant tables with policies of the form
`USING (customer_id = current_tenant_id() OR current_tenant_id() IS NULL)`, where
`current_tenant_id()` reads `app.customer_id` from the session. **But nothing in
the API ever sets `app.customer_id`** — there is no `SET LOCAL` / `set_config`,
no per-request tenant transaction, and the app uses one shared pooled `db`
instance. Consequences:

- If the API connects as a normal role, `current_tenant_id()` is always NULL, the
  `OR … IS NULL` branch matches every row, and **RLS is a complete no-op**.
- If it connects as a superuser/BYPASSRLS role, RLS is bypassed anyway.

Either way the second layer doesn't exist; app-level `WHERE customer_id = ?`
filters (which *are* applied consistently) are the only isolation. **Fix:** wrap
every authenticated request in a transaction that runs
`SELECT set_config('app.customer_id', $1, true)` before handler queries, run the
API under a non-BYPASSRLS role, and add a cross-tenant integration test that
proves customer A cannot read customer B's rows even with a deliberately buggy
query. Until then, don't rely on RLS as a control.

### B. Unbounded template & body sizes (Medium)

`templates.html_body` / `text_body` (template create) and `html` / `text` (send
payload) have **no max-length validation**. The 10 MB Fastify `bodyLimit` is the
only backstop. A customer can store a multi-MB template or one with pathological
Handlebars nesting, rendered per-recipient — a billing-amplification / CPU-DoS
vector and a multi-tenant fairness problem. **Fix:** cap body/template sizes
(e.g. 256 KB–1 MB), and consider a render timeout / complexity budget.

### C. `last_used_at` write on every authenticated request (Medium, scale)

The auth plugin issues a DB UPDATE to `api_keys.last_used_at` on every call
(backgrounded, but still one write per request). At high RPS this is write
amplification and row-lock contention on hot keys. **Fix:** throttle to e.g. once
per 60s per key (compare-and-skip via Redis, or only update if stale), or batch
asynchronously.

### D. `sql.raw` interval/trunc interpolation is safe-but-fragile (Low)

`analytics.ts` builds `interval '…'` and `date_trunc('…')` via `sql.raw` on values
derived from zod enums — safe today, but one refactor away from injection. **Fix:**
map the enum to fully static `sql` fragments rather than interpolating strings.

### E. Quota release underflow (Low)

`releaseQuota` decrements counters with no floor; a double-release could go
negative. **Fix:** `GREATEST(0, …)` in the Lua / decrement path.

---

## Additional security fix — TOTP replay prevention (this pass)

**Finding (Medium-High).** `verifyMfaForUser` accepted any valid TOTP code within
the ±1-step (~90s) skew window with no record of what had been consumed, so a
single valid 6-digit code could be **replayed** multiple times inside its
validity window — e.g. reused by a phishing proxy or after a shoulder-surf.
Recovery codes were correctly single-use, but TOTP codes were not.

**Fix.** Per RFC 6238 §5.2, the verifier now records the highest consumed
time-step per factor (`mfa_factors.last_used_step`, migration 032) and rejects
any code whose step is ≤ the last used one. The update is a single conditional
`UPDATE ... WHERE last_used_step IS NULL OR last_used_step < $step`, which also
serializes two concurrent logins racing the same code (only one UPDATE matches).
Added `verifyTotpStep()` (returns the matched counter) plus unit tests and a
DB-backed replay test proving a used code cannot be reused and that invalid codes
never advance the counter.

Files: `shared/src/totp.ts`, `shared/src/mfa.ts`, `shared/src/schema.ts`,
`infra/migrations/032_mfa_totp_replay.sql`. Tests: `totp.test.ts`,
`mfa-replay.test.ts`.



These decide real-world parity and require work no static review can substitute for:

1. **Deliverability — the actual product.** IP warmup *executed* over weeks,
   sender reputation monitoring, FBL enrollment with each major mailbox provider,
   inbox-placement testing (not just "we sent a 250 OK"), dedicated-IP management,
   blocklist monitoring/auto-remediation, postmaster-tools integration. SendGrid's
   moat is here. The code has warmup/reputation *scaffolding*; whether mail lands
   in inboxes at scale is unproven.

2. **Scale & load validation.** I stress-tested concurrency at 12–20 parallel
   requests in-process. Production parity needs k6/Gatling load tests at realistic
   RPS, DB hot-spot analysis (the `messages` table, usage counters), connection-
   pool sizing under load, queue depth behavior under backpressure, and a
   documented throughput ceiling. None exists yet.

3. **Independent security review.** This was a read-through, not a pen test, a
   dependency CVE scan (`npm audit` / Snyk), a secrets-in-history scan, or a SOC 2 /
   ISO 27001 process. A public email API is a high-value target; it needs all of
   these.

4. **Operational maturity.** Runbooks, on-call rotation, incident response,
   tested backup/restore + PITR, disaster recovery, multi-AZ/region failover,
   schema-migration rollback strategy, chaos/failover drills. The Helm/k8s manifests
   are a starting point, not operational readiness.

5. **Data & compliance.** GDPR/CCPA erasure completeness (paths exist — verify
   they're exhaustive), data-residency, audit-log immutability/retention, DPA
   posture, CAN-SPAM physical-address + one-click unsubscribe end-to-end proof.

6. **Provider/region redundancy.** Single Postgres + single Redis as shown are
   SPOFs; SendGrid parity implies HA Postgres (replicas/failover), Redis HA/cluster,
   and multi-region delivery.

---

## Admin console & compliance review (latest pass)

Three more real issues found reviewing the admin console, RBAC, and GDPR/retention
paths; all fixed and tested (suite now **508/508 green across 76 files**).

**Admin TOTP replay (High).** `verifyAdminTotp` had the same replay weakness as
customer MFA — a valid admin code could be reused within its ~90s window, and
admin is the highest-value target. Fixed with `admin_users.totp_last_used_step`
(migration 033) and the same RFC 6238 §5.2 step-guard. Test:
`admin-totp-replay.test.ts`.

**Admin MFA brute-force not throttled (Medium).** The admin login counted failed
*password* attempts toward lockout but not failed *MFA-code* attempts — so behind
a known-good password an attacker could guess/replay TOTP codes without limit.
Fixed so a wrong/replayed MFA code also increments the lockout counter
(5 attempts → 15-minute lock), identical to a bad password.

**GDPR erasure left PII in object storage (High, compliance).**
`POST /v1/privacy/delete-recipient` deleted the `messages` rows but never removed
the recipient's OFFLOADED body objects, so under `BODY_STORAGE=fs|s3` the
PII-bearing email body persisted in object storage indefinitely while the request
reported "completed" — a right-to-erasure violation. Fixed to delete orphaned body
objects after the DB commit, while preserving content-addressed bodies still
referenced by another recipient. Tests in `privacy-erasure-bodies.e2e.test.ts`
cover both the delete and the shared-body-survival case.

**Reviewed clean:** the admin authorization model (tiered roles
support<operator<admin<superadmin with correct rank comparison, peppered/hashed
session tokens, `disabled` re-checked on every request, sessions revoked on
disable, login lockout); billing reconciliation (conservative read-mostly drift
detector, no auto-correction); time-based retention (only purges terminal-status
bodies and content-addressed objects with no live references); DKIM key rotation
(proper overlapping-selector lifecycle, 2048-bit, encrypted keys).

---

## Inbound pipeline & tracker review (latest pass)

Two more hardening items found reviewing the untrusted-mail inbound parser and the
public tracker endpoints; both fixed.

**Inbound DSN/FBL parse was unbounded (Medium, DoS).** `parseDsn` / `parseFbl`
concatenated the message text plus the full content of *all* attachments into one
string, then ran several regexes over it — so a malicious or malformed bounce with
huge/many attachments could build an arbitrarily large in-memory string and force
repeated scans, a memory/CPU amplification vector on the inbound MTA. Fixed with a
256 KB cap (`buildBoundedBlob`) — structured DSN/FBL fields always appear early, so
real reports parse unchanged. Test asserts a valid DSN at the top of a 5 MB message
still parses while the input is bounded.

**Click-redirect scheme re-validation (Low, defense-in-depth).** The tracker's
`/c/:encoded/:linkId` handler 302-redirects to the stored `original_url`. Link
rewriting already filters to `http(s)` at storage time, but the redirect did not
re-validate — so any malformed/unexpectedly-sourced row could in principle turn
the trusted tracking domain into a `javascript:`/`data:` redirector. Added a
scheme re-check before the 302.

**Reviewed clean:** team/membership RBAC (privilege escalation past `owner` blocked
at every mutation; last-owner guard prevents org lockout; capability-gated routes);
invite acceptance (hashed single-use token, expiry, membership bound to the invited
email — not a user-supplied one); VERP/FBL signature verification (HMAC, constant-
time, body Message-ID never trusted over the signed id).

---

## A concrete path to "production-grade" (in priority order)

**Phase 1 — close the code gaps (days):** wire up RLS (A) + cross-tenant test,
cap body/template sizes (B), throttle `last_used_at` (C), harden analytics SQL (D),
floor quota release (E). All are small, testable changes.

**Phase 2 — verify, don't assume (weeks):** `npm audit`/Snyk + dependency
pinning; k6 load test to a documented throughput number; backup/restore + PITR
drill; HA Postgres + Redis; structured runbooks; error-budget/SLO alerting on the
existing Prometheus metrics.

**Phase 3 — earn deliverability (weeks–months, ongoing):** real IP warmup,
FBL/postmaster enrollment, inbox-placement monitoring, blocklist auto-remediation.
This is continuous, not a checkbox.

**Phase 4 — external validation:** independent pen test; SOC 2 Type II if selling
to businesses; legal review of compliance flows.

---

## Honest bottom line

Code quality: **strong, and meaningfully closer after this work.** Calling the
whole *platform* a 10/10 SendGrid equivalent today would be inaccurate — Phase 1
is quick and entirely in reach; Phases 2–4 are the real distance, and most of it
is operational and deliverability work that lives outside the codebase. I'd rather
tell you that plainly than check a box.
