# Tamper-evident audit log (gap analysis Top-20 #10)

## The gap

Report #10: "Audit exists but is not tamper-evident" (score 6.0). The report
specifies the fix directly (§ audit hash chain): an `audit_log_hashes` table
chaining each audit row to the previous via a hash.

## What was built

**Migration `039_audit_hash_chain.sql`** — `audit_log_hashes(audit_id,
chain_key, seq, previous_hash, row_hash, created_at)`, FK to `audit_log` with
ON DELETE CASCADE, unique on `(chain_key, seq)`.

**`recordAudit` now appends a chain link on every write**, transactionally:
1. Insert the audit row (get its id + server `occurred_at`).
2. Take a per-chain Postgres advisory lock (`pg_advisory_xact_lock`) so
   concurrent writers to the same chain can't fork it by both reading the same
   "previous" link.
3. Read the latest link for the chain, compute
   `row_hash = SHA256(previous_hash || "\n" || canonical(audit row))`, insert
   the new link at `seq = prev.seq + 1`.

The chain is **per-customer** (`chain_key` = customer id, or `'system'` for the
null-customer chain) so one tenant's audit volume doesn't serialize another's.

`canonicalAuditPayload()` is a fixed, reproducible serialization of the
immutable audit fields (with stable-sorted metadata keys), so the hash can be
recomputed identically during verification.

**`verifyAuditChain(chainKey)`** re-walks the chain in order and returns
`{ ok, links_checked, broken_at? }`. It recomputes every `row_hash` from the
live audit row + prior hash and checks `previous_hash` pointers and `seq`
continuity. Any of these tampers surface as the first broken link:
- altered audit row or metadata → `row_hash_mismatch`
- spliced/reordered chain → `previous_hash_mismatch`
- deleted row (cascades to its link) → `sequence_gap`

**Endpoint** `GET /v1/account/audit/verify` (org-admin, `members:manage`)
exposes the check.

## Verified how (real, live infra)

- Migration 039 applies cleanly.
- `npm run build`: exit 0 (compiler caught a schema.ts edit slip mid-way,
  fixed before tests).
- `audit-hash-chain.test.ts`: 7/7 against live Postgres — chain built per row,
  strictly increasing seq, verifies intact, and DETECTS: altered action,
  altered metadata, deleted row (sequence gap), with per-tenant isolation
  (tampering tenant A doesn't fail tenant B) and empty-chain = ok.
- Full suite: 90 files, 607 tests, 0 failures — the transactional+advisory-lock
  recordAudit change did not break any of the many audit-dependent flows
  (login, admin actions, SCIM, billing, etc.).

## Threat model (honest scope)

This makes tampering **detectable**, which is what the report asked for and what
compliance frameworks (SOC 2 / ISO 27001) generally require for audit
integrity. It is NOT tamper-*proof*: an attacker with full write access to the
database could recompute and rewrite the entire chain from the tampered point
forward, since the hashing key/algorithm is in the app. Defeating that requires
an EXTERNAL anchor — periodically publishing the latest `row_hash` to an
append-only external sink (the report's "WORM/external audit sink", §709), so
the internal chain can be checked against a copy the DB attacker can't reach.
That external sink needs infrastructure outside this sandbox and is the
remaining follow-up; the in-database chain built here is its foundation (it's
the thing you'd anchor).
