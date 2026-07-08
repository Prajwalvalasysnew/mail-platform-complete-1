# Mail Platform — Consolidated Fix Summary

Single reference for everything found and fixed across the full audit. Final
state: **508/508 tests green across 76 files** (started at 456/463). Every fix
below is backed by a regression test. Full per-area detail is in
`AUDIT_REPORT.md`, `PRODUCTION_READINESS_ROADMAP.md`, and `LOAD_TEST_FINDINGS.md`.

---

## Real bugs fixed (10)

| # | Severity | Bug | Fix |
|---|----------|-----|-----|
| 1 | High | **Stale-send recovery dead** — scheduler queried a `messages.updated_at` column that never existed; crash-stranded messages stuck in `sending` forever. | Added `sending_at` column + trigger + partial index (migration 031); recovery keys off it. |
| 2 | High | **Batch send dropped bodies** — `/send/batch` hard-coded `body_storage:'inline'` and never called `put()`, so under `fs/s3` every batch message delivered empty. | Offload each batch body before the transaction (content-addressed dedupe). |
| 3 | Medium | **Bounce/complaint double-count** — random UUID idempotency key let provider DSN/FBL re-deliveries be counted repeatedly. | Deterministic SHA-256 key over (event-type, message-id, recipient). |
| 4 | High | **`/v1/profile` always 401** — route mounted outside the auth scope; customers couldn't set CAN-SPAM `physical_address`, blocking ALL live sends. | Split into its own plugin registered inside the auth scope. |
| 5 | High | **Webhook DNS-rebind SSRF** — validated the URL's IP, then re-resolved at connect time (TOCTOU); could reach `169.254.169.254`. | Pin the connection to the validated IP via a custom undici dispatcher. |
| 6 | High | **RLS dormant** — RLS enabled on all tables but the app never set `app.customer_id`, so policies matched every row (no isolation). | `withTenant()` (transaction-local `set_config`) + `rlsIsEnforced()` startup check; proven under a non-privileged role. |
| 7 | Medium-High | **Customer TOTP replay** — a valid MFA code could be reused within its ~90s window. | Track `mfa_factors.last_used_step`, reject reuse (RFC 6238 §5.2; migration 032). |
| 8 | High | **Admin TOTP replay** — same as #7 on the higher-value admin path. | `admin_users.totp_last_used_step` + step-guard (migration 033). |
| 9 | Medium | **Admin MFA brute-force** — failed MFA codes (behind a good password) didn't count toward lockout. | Wrong/replayed MFA code now increments the 5-attempt/15-min lockout. |
| 10 | High | **GDPR erasure left PII in object storage** — `delete-recipient` deleted DB rows but orphaned the body object in `fs/s3`. | Delete orphaned body objects post-commit; preserve shared (deduped) bodies. |

## Hardening gaps closed (6)

- **Billing webhook signature fail-open** — `if (!secret) return true` accepted forged payloads; now fails closed in production + config-guard requires the active provider's webhook secret.
- **Public `/metrics`** — leaked per-customer operational data; now token-guarded (constant-time) on API + tracker, with ingress-level deny.
- **Event status downgrades** — out-of-order provider events could overwrite a terminal status; added a `STATUS_PRECEDENCE` guard (status only advances).
- **Unbounded body/template sizes** — added 1 MB caps on send + template bodies.
- **Inbound DSN/FBL parse unbounded (DoS)** — bounce/FBL parsing concatenated all attachment content and regex-scanned it; capped at 256 KB (`buildBoundedBlob`). Real reports parse unchanged; a 5 MB message is bounded.
- **Click-redirect scheme re-validation** — the tracker now re-checks `http(s)` before a 302, so a bad stored row can't turn the tracking domain into a `javascript:`/`data:` redirector (storage-time filter already existed; this is defense-in-depth).

## Robustness / scale gaps closed (4)

- **Per-recipient round-trips (scalability)** — the send path screened recipients in a sequential loop (~2000 round-trips for a 1000-recipient send). Batched into `isSuppressedBatch` + `isTrapOrDisposableBatch` → ~3 round-trips regardless of count; top-of-path lookups parallelized.
- **`last_used_at` write per request** — throttled to ≤1 write/key/60s via a Redis gate.
- **Analytics `sql.raw` fragility** — replaced string interpolation with static `sql` fragments (injection-proof by construction).
- **Quota release underflow** — `releaseQuota` now clamps at zero in one Lua round-trip.

## Test-suite improvements

- 30+ new regression/stress tests, including: concurrency stress proving **no quota oversell** (20 concurrent vs limit 5 → exactly 5) and **no idempotency double-send** (12 concurrent, one key → exactly 1 message).
- De-brittled the migration-count tests (dynamic), fixed an async KMS assertion, and hardened two replay tests + flagged a tight worker-poll timeout for CI stability.
- Added an in-process load harness (`packages/tests/load/run-load.ts`).

---

## Reviewed and found clean (no fix needed)

Password hashing (scrypt, constant-time, transparent rehash); API-key verification
(peppered HMAC, prefix-indexed, constant-time); rate limiting (Redis-backed, per-key
+ per-endpoint); admin RBAC (tiered roles, hashed sessions, disable-revokes, lockout);
DKIM signing + key rotation (mailauth, fail-closed, overlapping-selector lifecycle);
SSRF static + DNS-time checks; transactional outbox with `SKIP LOCKED`; billing
reconciliation (conservative drift detector); time-based retention (terminal-only,
ref-counted object GC); header-injection (nodemailer + regex-restricted custom headers).

---

## What remains for "10/10 like SendGrid" (NOT code)

The code-level work is in strong shape. The remaining distance is operational and
cannot be certified by a code audit:

1. **Ops rollout of fix #6** — run the API under a dedicated non-BYPASSRLS Postgres
   role and route tenant queries through `withTenant` (mechanism + tests are done).
2. **Scale validation** — run the k6 load test against a staging cluster; capture
   the horizontal scaling curve, DB pool saturation, and queue-drain rate.
3. **HA infrastructure** — HA Postgres (replicas/failover), Redis HA/cluster,
   multi-region; the single instances shown are SPOFs.
4. **Independent security review** — pen test, `npm audit`/Snyk dependency scan,
   secrets-in-history scan, SOC 2 / ISO 27001 if selling to businesses.
5. **Deliverability (SendGrid's actual moat)** — real IP warmup over weeks, FBL +
   postmaster enrollment with major mailbox providers, inbox-placement monitoring,
   blocklist auto-remediation. Continuous, not a checkbox.
6. **Operational maturity** — runbooks, on-call, incident response, tested
   backup/restore + PITR, disaster-recovery drills.
