# OpenAPI route parity

Addresses gap-analysis §23.3.3 ("OpenAPI is hand-maintained, incomplete, and
stale against runtime routes").

## The problem (verified)

The API serves ~110 route operations; `packages/shared/src/openapi.ts`
documented ~39 paths. That gap means the spec can't be trusted for SDK
generation or as a contract, and — worse — nothing stops it drifting further.

## What was added

`packages/tests/openapi-route-parity.test.ts` — a runnable test that enumerates
the REAL Fastify route tree (by registering the same route modules the
production server and e2e harness use, via an `onRoute` hook) and diffs it
against the spec. It runs WITHOUT a database: route registration makes no DB
calls, so `app.ready()` builds the full route tree without connecting.

Two guards:
1. **No stale docs** — every path in `openapi.ts` must still exist as a real
   route. Catches a documented route being renamed/removed (a breaking change).
2. **Ratchet on undocumented routes** — public `/v1` routes not in the spec
   must be in an explicit `ALLOWLIST` in the test, each an acknowledged
   decision (dashboard/session routes, provider webhooks, sub-routes pending
   docs). A NEW undocumented public route fails the test until it's either
   documented in `openapi.ts` or consciously allowlisted. The drift can no
   longer grow silently.

This is deliberately a ratchet, not a wall: requiring the whole spec to be
complete today would just fail immediately and get disabled. The allowlist
makes today's drift explicit and bounded; shrinking it over time = documenting
more of the API.

## Also fixed

Writing the test surfaced that `POST /send/batch` — a core public endpoint —
was undocumented. It's now added to `openapi.ts` properly (modeled on `/send`,
with the partial-success `results[]` response shape), rather than allowlisted
away. Writing the test also corrected several wrong assumptions about actual
route names (e.g. the MFA/password routes are `/auth/mfa`, `/auth/mfa/enroll`,
`/auth/password/forgot|reset`, not the names first guessed) — the test refused
to pass until the allowlist matched reality, which is the point.

## Verified how

- `npm run build` (all packages) passes, exit 0.
- `openapi-route-parity.test.ts`: 2/2 pass. Runs standalone (no DB/Redis).
- The test genuinely failed first and caught 8 real route-name/coverage
  mistakes before being corrected — evidence it's checking reality, not a
  tautology.

## Progress against the backlog

The ALLOWLIST is the backlog of routes to document. Since the guard was added,
the documented public surface has grown from 39 → 50 paths by documenting the
highest-value clusters a customer builds against:
- Analytics: `/analytics/summary`, `/analytics/timeseries`, `/analytics/breakdown`
- Usage: `/usage/quota`, `/stats`
- Webhook management: `/webhooks/{id}/rotate-secret`, `/test`, `/deliveries`,
  `/retry-failures`, `/deliveries/{deliveryId}/replay`

Each was verified against the real handler's response shape before being added,
and removed from the ALLOWLIST — so the ratchet tightened rather than staying
flat. The parity test still passes (2/2), which confirms every newly documented
path/method matches a real route exactly (the "no stale docs" guard would fail
otherwise).

## Next step (not done here)

The remaining ALLOWLIST entries are the rest of the backlog (dashboard/session
routes, privacy sub-routes, provider webhooks). The larger §23.3.3 fix is
generating the spec (or SDK) FROM route schemas so the two can't diverge at
all; this test is the guardrail that makes incremental progress safe in the
meantime.
