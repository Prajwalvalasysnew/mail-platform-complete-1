# SCIM 2.0 provisioning (gap analysis Top-20 #9)

## Scope

Report #9: "Admin OIDC exists; customer enterprise SSO/SCIM is not complete."
Enterprise SSO/SCIM is a large surface. This delivers the highest-value,
fully-testable slice: **SCIM 2.0 (RFC 7644) user provisioning and
deprovisioning** for customer tenants — the "SCIM deprovisioning" requirement
called out in the report (§3409). It builds on the existing users + memberships
model (which already supported SSO-only users: password_hash is nullable).

Interactive SSO *login* (SAML/OIDC redirect flows) is intentionally NOT included
here — it requires a live IdP + browser round-trip to test meaningfully, whereas
SCIM is a server-to-server API fully exercisable in CI. The admin OIDC login in
`admin.ts` remains the reference for that follow-up.

## What was built

**Migration `038_scim_provisioning.sql`**: `scim_tokens` (per-tenant bearer
token, HMAC-hashed at rest), and `users.scim_external_id` + `users.scim_managed`.

**Service layer `packages/shared/src/scim.ts`**:
- Token mint/resolve/list/revoke (HMAC-hashed, like api keys / sessions).
- SCIM User CRUD mapped onto users + memberships:
  - Create — idempotent on email; provisions the user, links externalId, grants
    a default `analyst` membership (identity comes from the IdP; authorization
    stays in-app).
  - Get / List (with `userName eq` / `externalId eq` filter support).
  - PATCH / PUT — including the deprovisioning path (`active=false`).
  - DELETE — soft deprovision.

**Deprovisioning semantics**: setting `active=false` (via PATCH, PUT, or DELETE)
**disables the user account**. A disabled user is rejected at both session
resolution and password auth (see `user-sessions.ts` / `users.ts`), so access is
fully revoked. The membership row and user row are preserved, so (a) the tenant
can re-activate the user later, (b) the user still appears in SCIM listings as
`active:false` per spec, and (c) audit/message references stay valid.

**Routes `packages/api/src/routes/scim.ts`** (registered at `/scim/v2`):
- Bearer-token preHandler resolves the token to a tenant; all operations are
  scoped to it (cross-tenant access is rejected — proven by test).
- `GET /scim/v2/ServiceProviderConfig`, `GET|POST /scim/v2/Users`,
  `GET|PUT|PATCH|DELETE /scim/v2/Users/:id`. SCIM `application/scim+json` content
  type and RFC-7644 error envelopes.

**Token management** (dashboard, org-admin gated via `members:manage`):
`GET|POST /v1/team/scim-tokens`, `DELETE /v1/team/scim-tokens/:id`. The
plaintext token is shown once on creation, alongside the tenant's SCIM base URL.

## Verified how (real, live infra)

- Migration 038 applies cleanly (scim columns/table verified present).
- `npm run build` (all packages): exit 0. The compiler caught 6 real type
  errors during development (wrong import source for MembershipRole, ??/||
  precedence, strict-null narrowing) — all fixed before tests.
- `scim.test.ts`: 10/10 pass against live Postgres — token mint/resolve/revoke,
  cross-tenant token isolation, create+idempotency, get + cross-tenant
  rejection, `userName eq` filter, PATCH/DELETE deprovision (user disabled),
  the `{value:{active}}` PATCH shape, and re-activation.
- Running the tests caught a real design bug: the first cut removed the
  membership on deprovision, which made re-activation impossible (the user
  could no longer be found by the tenant). Fixed by disabling the user account
  instead — which is both the correct SCIM semantic and a cleaner enforcement
  point (disabled status already blocks all auth).
- The OpenAPI route-parity guard caught the new `/team/scim-tokens` routes;
  they were allowlisted (dashboard plane).
- Full suite: 89 files, 600 tests, 0 failures.

## Not included (honest scope)

- Interactive customer SSO login (SAML/OIDC redirect) — needs a live IdP to
  prove; separate follow-up.
- SCIM Groups (`/scim/v2/Groups`) — role/group sync. Users is the core ask;
  Groups can map to memberships roles in a follow-up.
- Per-tenant IdP metadata config UI — belongs with the self-serve dashboard (#16).
