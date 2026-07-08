# Legal hold (gap analysis Top-20 #19)

## The gap

Report #19 (score 5.0): "Privacy endpoints exist; residency/legal hold/backup
erasure not complete." Acceptance criterion (report §): "Legal hold blocks
destructive erasure where required." Without it, a GDPR/CCPA erasure request
could destroy records that are under litigation hold or a retention obligation.

## What was built

**Migration `040_legal_holds.sql`** — `legal_holds(id, customer_id, scope,
reason, created_by, created_at, released_at, released_by)`, following the
report's spec. A hold is active while `released_at IS NULL`. Tenant-scoped RLS
(permissive 023-style; included in the pending fail-closed migration). Scopes:
`customer` (whole tenant) or `recipient:<email>` (one recipient).

**Service layer `packages/shared/src/legal-hold.ts`**: `placeLegalHold`,
`releaseLegalHold`, `listLegalHolds`, `activeHoldsCoveringRecipient`,
`isRecipientUnderHold`, and `assertNoActiveHold` (throws `LegalHoldError`).

**Erasure gate**: `POST /v1/privacy/delete-recipient` now calls
`assertNoActiveHold` as the FIRST statement inside the erasure transaction —
before any row is touched — so a held recipient's data is never destroyed. A
block returns `409 legal_hold_active` with the blocking holds' reasons. The new
error code is registered in the stable error-code registry.

**Management endpoints** (scope: messages, tenant-isolated):
- `GET  /v1/privacy/legal-holds` (optional `?active=true`)
- `POST /v1/privacy/legal-holds` — `{ scope, reason }`; a bare email is
  normalized to `recipient:<email>`.
- `POST /v1/privacy/legal-holds/{id}/release`

## Verified how (real, live infra)

- Migration 040 applies cleanly (8 columns verified).
- `npm run build`: exit 0 (compiler caught a wrong DbExecutor import source and
  an untyped callback param during development; fixed).
- `legal-hold.test.ts`: 8/8 — lifecycle, recipient- vs tenant-scope coverage,
  case-insensitive matching, tenant isolation, and the assertNoActiveHold gate
  (throws while held, resolves after release).
- `e2e/legal-hold.e2e.test.ts`: 2/2 — the REAL HTTP round-trip: erasure returns
  409 while held (and the message row is confirmed still present), then
  succeeds after release; plus a tenant-wide hold blocking an arbitrary
  recipient.
- The error-registry guard required registering `legal_hold_active`; the
  route-parity guard required allowlisting the 3 new routes — both did.
- Full suite: 95 files, 642 tests, 0 failures.

## Scope note (honest)

This delivers the LEGAL HOLD half of #19 — the part with a concrete acceptance
criterion ("blocks destructive erasure"). The other two sub-items are NOT
closed here:
- **Data residency** (pinning a tenant's data to a region) is an
  infrastructure/deployment-topology concern (region-scoped DB/storage), not a
  single code change, and can't be meaningfully built or proven in this sandbox.
- **Backup erasure** (propagating a deletion into database backups / the
  analytics store) depends on the backup system and ClickHouse durability work
  (#13) and real backup infrastructure. The in-DB erasure + legal-hold gate is
  the authoritative-record half; propagating into backups is an ops/#13 task.
