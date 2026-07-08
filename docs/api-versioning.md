# API versioning & compatibility policy

This document defines the public API's versioning strategy, compatibility
promise, deprecation process, and the automated gates that enforce them.
(Gap analysis Top-20 #20, §23.3.5.)

## Versioning strategy

- The public API is served under a URL version prefix: `/v1/...`.
- The current stable version is **v1**.
- The machine-readable contract is the published OpenAPI document at
  `GET /openapi.json` (source: `packages/shared/src/openapi.ts`). Its `info.version`
  tracks the spec revision.

## Compatibility promise (within a major version)

Within `/v1` we will NOT make breaking changes. Specifically, we treat these as
**breaking** and will not do them within a version:

- removing or renaming a published operation (METHOD + path),
- changing an `operationId` (generated SDKs key off these),
- adding a new **required** request parameter to an existing operation,
- removing a documented response field,
- removing or renaming a machine-readable `error` code (see the error registry).

We MAY make these **backward-compatible** changes without a version bump:

- adding new operations,
- adding new **optional** parameters,
- adding new response fields,
- adding new `error` codes,
- relaxing validation.

## Stable error codes

Every machine-readable `error` code is catalogued in
`packages/shared/src/error-codes.ts` (`ERROR_CODES`) with a description and HTTP
status. Codes are part of the stable contract — clients branch on them. They are
governed by the same deprecation process as endpoints.

## Deprecation process

1. Announce: mark the endpoint/version deprecated in the OpenAPI spec and this
   doc, with a replacement and a sunset date.
2. Signal at runtime: set `V1_SUNSET_DATE` (RFC 1123). The API then returns
   `Deprecation: true`, a `Sunset` header, and a `Link rel="deprecation"` on
   `/v1` responses (already wired in `server.ts`).
3. Migration window: keep the deprecated surface working until the sunset date,
   with a migration guide.
4. Remove only after the sunset date, in a new major version.

## Automated enforcement (CI gates)

These run in the normal test suite (offline, no infra):

- **Breaking-change detector** — `openapi-breaking-change.test.ts` diffs the
  current spec against a committed baseline (`fixtures/openapi-baseline.json`)
  and FAILS on removed operations, changed operationIds, or newly-required
  params. New (additive) operations are reported, not failed. When you ship an
  approved breaking change (new version), regenerate the baseline:
  `node scripts/update-openapi-baseline.mjs` and commit it in the same change.
- **Error-code registry guard** — `error-registry.test.ts` ensures every `error`
  code the routes emit is registered, and that the registry never silently drops
  a previously-shipped code (a frozen baseline enforces the superset rule).
- **Route/spec parity** — `openapi-route-parity.test.ts` ensures every public
  `/v1` route is either documented in the spec or explicitly allowlisted, so the
  spec can't silently drift from the implementation.

## Not yet implemented (honest status)

- Publishing versioned OpenAPI artifacts per release (item 5) and SDK
  compatibility tests against previous spec versions (item 6) require a release
  pipeline that produces and stores per-release specs; the baseline snapshot
  here is the building block. These are process/CI-infrastructure tasks rather
  than code gaps.
