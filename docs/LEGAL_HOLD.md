# Legal holds

## Purpose

Legal holds prevent recipient erasure and scheduled retention from destroying
covered online records while a tenant or recipient hold is active. They are a
technical enforcement mechanism, not a complete legal-hold program.

## What was built

**Migration `040_legal_holds.sql`** — `legal_holds(id, customer_id, scope,
reason, created_by, created_at, released_at, released_by)`, following the
application model. A hold is active while `released_at IS NULL`. Tenant-scoped,
fail-closed RLS is applied by the current migration set. Scopes:
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

## Automated evidence

- Migration 040 applies cleanly (8 columns verified).
- `npm run build`: exit 0 (compiler caught a wrong DbExecutor import source and
  an untyped callback param during development; fixed).
- `legal-hold.test.ts` covers lifecycle, recipient- vs tenant-scope coverage,
  case-insensitive matching, tenant isolation, and the `assertNoActiveHold` gate.
- `e2e/legal-hold.e2e.test.ts` covers the real HTTP round-trip: erasure returns
  409 while held (and the message row is confirmed still present), then
  succeeds after release; plus a tenant-wide hold blocking an arbitrary
  recipient.
- `e2e/retention-holds.e2e.test.ts` verifies held bodies, events, message rows,
  and tracked links survive retention and purge after release.
- `e2e/dmarc.e2e.test.ts` verifies tenant-wide holds preserve expired DMARC
  evidence.
- The focused compliance regression run on 2026-07-22 passed 110 tests across
  20 files, including these suites.

## Scope note (honest)

The following adjacent controls remain outside the application guarantee:
- **Data residency** (pinning a tenant's data to a region) is an
  infrastructure/deployment-topology concern (region-scoped DB/storage), not a
  single code change, and can't be meaningfully built or proven in this sandbox.
- **Backup erasure** (propagating a deletion into database backups / the
  analytics store) depends on the backup system and ClickHouse durability work
  (#13) and real backup infrastructure. The in-DB erasure + legal-hold gate is
  the authoritative-record half; propagating into backups is an ops/#13 task.
