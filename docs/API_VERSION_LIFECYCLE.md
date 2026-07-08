# API version lifecycle (gap analysis Top-20 #20)

Report #20 (score 7.0 → target): "Sunset header exists, but compatibility
enforcement is incomplete." The §23.3.5 "10/10 solution" lists 6 items. This
change delivers the code-level, testable ones (1–4) and lays the groundwork for
5–6.

## Delivered

**1. Versioning policy doc** — `docs/api-versioning.md`: version strategy
(`/v1` prefix), the explicit breaking vs backward-compatible change lists, the
error-code stability rule, the deprecation process (Announce → Sunset headers →
migration window → remove), and the CI gates.

**2. OpenAPI breaking-change detector** — `openapi-breaking-change.test.ts`
diffs the current published spec against a committed baseline
(`packages/tests/fixtures/openapi-baseline.json`, 63 operations) and FAILS on:
removed operations, changed operationIds, or newly-required parameters. Additive
changes (new operations / optional params) are reported, not failed. Regenerate
the baseline on an approved breaking change with
`node scripts/update-openapi-baseline.mjs`. This is the CI diff-gate the report
asks for. (Verified it actually catches a removed operation, not just passes.)

**4. Stable error-code registry** — `packages/shared/src/error-codes.ts`
catalogues all ~78 machine-readable `error` codes with description + HTTP
status. `error-registry.test.ts` enforces: (a) every code emitted by the routes
is registered (completeness — it caught 6 unregistered auth-plane codes on first
run), and (b) the registry never drops a previously-shipped code (a frozen
baseline enforces backward compatibility). Codes are now a governed part of the
public contract.

## Already present (confirmed, not regressed)

**3. Deprecation signaling** — `server.ts` already emits `Sunset` /
`Deprecation` / `Link rel="deprecation"` headers on `/v1` when `V1_SUNSET_DATE`
is set. The policy doc now documents how/when to use it (endpoint-level owner +
replacement metadata is captured in api-versioning.md rather than per-route
annotations, which would be the fuller form of item 3).

Route/spec parity (`openapi-route-parity.test.ts`) continues to ensure the spec
can't silently drift from the implementation.

## Verified how

- `npm run build`: exit 0.
- `error-registry.test.ts` 3/3, `openapi-breaking-change.test.ts` 4/4.
- The breaking-change detector was sanity-checked by injecting a removed
  operation into the baseline — it correctly failed with a BREAKING message —
  then restored.
- Full suite: 93 files, 632 tests, 0 failures.

## Not delivered (honest scope)

- Item 5 (publish versioned OpenAPI artifacts per release) and item 6 (SDK
  compatibility tests against previous spec versions) need a release pipeline
  that stores per-release specs. The baseline snapshot + detector here are the
  building block; wiring them into a release/publish workflow is CI-infra work
  outside this codebase change.
- Full endpoint-level deprecation metadata (per-route owner/replacement/sunset
  annotations) — the policy + mechanism exist; per-route annotation objects are
  a larger spec-authoring pass.
