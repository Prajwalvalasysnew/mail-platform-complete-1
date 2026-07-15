// Route-parity guard for the OpenAPI spec (gap analysis §23.3.3).
//
// The public OpenAPI document (packages/shared/src/openapi.ts) is
// hand-maintained and had drifted far from the routes the API actually serves
// (~39 documented paths vs ~110 route operations). This test makes the drift
// VISIBLE and BOUNDED: it enumerates the real Fastify route tree (by registering
// the same route modules the production server and e2e harness use) and compares
// it against the spec.
//
// It does NOT require the whole spec to be complete today — that would fail
// immediately and be useless. Instead it enforces a ratchet:
//   1. Every path already IN the spec must still exist as a real route
//      (catches a documented route being renamed/removed — a breaking change).
//   2. Routes intentionally left out of the public spec (admin plane, health,
//      internal, account/session/dashboard routes) are listed in an explicit
//      allowlist here, so adding a new public route without documenting it
//      shows up as a failure unless consciously allowlisted.
//
// This runs WITHOUT a live database: route registration itself makes no DB
// calls (only request handlers do), so we can build the route tree with
// app.ready() and never listen or connect.

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Env stubs so importing route modules (which read config at import time)
// doesn't throw. No real connections are made during registration.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://x:x@localhost:5432/x';
process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
process.env.VERP_SECRET ??= 'x'.repeat(30);
process.env.API_KEY_PEPPER ??= 'x'.repeat(40);
process.env.ADMIN_SESSION_PEPPER ??= 'x'.repeat(40);
process.env.USER_SESSION_PEPPER ??= 'x'.repeat(40);
process.env.MFA_RECOVERY_PEPPER ??= 'x'.repeat(40);

import { openapiSpec } from '@platform/shared';

import { authPlugin } from '@platform/api/plugins/auth.js';
import { errorEnvelope } from '@platform/api/plugins/error-envelope.js';
import { sendRoutes } from '@platform/api/routes/send.js';
import { domainRoutes } from '@platform/api/routes/domains.js';
import { suppressionRoutes } from '@platform/api/routes/suppressions.js';
import { messageRoutes } from '@platform/api/routes/messages.js';
import { customerRoutes } from '@platform/api/routes/customers.js';
import { profileRoutes } from '@platform/api/routes/profile.js';
import { templateRoutes } from '@platform/api/routes/templates.js';
import { usageRoutes } from '@platform/api/routes/usage.js';
import { analyticsRoutes } from '@platform/api/routes/analytics.js';
import { privacyRoutes } from '@platform/api/routes/privacy.js';
import { webhookRoutes } from '@platform/api/routes/webhooks.js';
import { adminRoutes } from '@platform/api/routes/admin.js';
import { accountRoutes } from '@platform/api/routes/account.js';
import { teamRoutes } from '@platform/api/routes/team.js';
import { keyRoutes } from '@platform/api/routes/keys.js';
import { accountWebhookRoutes } from '@platform/api/routes/account-webhooks.js';
import { accountDomainRoutes } from '@platform/api/routes/account-domains.js';
import { auditRoutes } from '@platform/api/routes/audit.js';
import { supportRoutes } from '@platform/api/routes/support.js';
import { accountBillingRoutes } from '@platform/api/routes/account-billing.js';
import { billingRoutes } from '@platform/api/routes/billing.js';

type RouteKey = string; // `${METHOD} ${path}`

// Fastify path params use `:id`; OpenAPI uses `{id}`. Normalize to OpenAPI style.
function toOpenApiPath(p: string): string {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

// The OpenAPI `servers` url is `/v1`, so spec paths are relative to /v1. Real
// routes registered under the /v1 prefix should have that stripped for
// comparison against spec paths.
function stripV1(p: string): string {
  if (p === '/v1') return '/';
  return p.startsWith('/v1/') ? p.slice(3) : p;
}

async function collectRoutes(): Promise<Set<RouteKey>> {
  const app: FastifyInstance = Fastify({ logger: false });
  const routes = new Set<RouteKey>();
  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) {
      if (m === 'HEAD' || m === 'OPTIONS') continue; // auto-added by Fastify
      routes.add(`${m} ${r.url}`);
    }
  });

  await app.register(errorEnvelope);

  // Mirror the production/e2e registration exactly (prefixes matter).
  await app.register(billingRoutes, { prefix: '/v1' });
  await app.register(customerRoutes, { prefix: '/v1' });
  await app.register(adminRoutes, { prefix: '/admin' });
  await app.register(accountRoutes, { prefix: '/v1' });
  await app.register(teamRoutes, { prefix: '/v1' });
  await app.register(keyRoutes, { prefix: '/v1' });
  await app.register(accountWebhookRoutes, { prefix: '/v1' });
  await app.register(accountDomainRoutes, { prefix: '/v1' });
  await app.register(auditRoutes, { prefix: '/v1' });
  await app.register(supportRoutes, { prefix: '/v1' });
  await app.register(accountBillingRoutes, { prefix: '/v1' });
  await app.register(async (instance) => {
    await instance.register(authPlugin);
    await instance.register(sendRoutes, { prefix: '/v1' });
    await instance.register(profileRoutes, { prefix: '/v1' });
    await instance.register(domainRoutes, { prefix: '/v1' });
    await instance.register(suppressionRoutes, { prefix: '/v1' });
    await instance.register(messageRoutes, { prefix: '/v1' });
    await instance.register(templateRoutes, { prefix: '/v1' });
    await instance.register(usageRoutes, { prefix: '/v1' });
    await instance.register(analyticsRoutes, { prefix: '/v1' });
    await instance.register(privacyRoutes, { prefix: '/v1' });
    await instance.register(webhookRoutes, { prefix: '/v1' });
  });

  await app.ready();
  await app.close();
  return routes;
}

// Spec paths as `${METHOD} ${path}` keys (path is spec-relative, i.e. under /v1).
function specRouteKeys(): Set<RouteKey> {
  const keys = new Set<RouteKey>();
  const paths = (openapiSpec as any).paths ?? {};
  for (const [path, ops] of Object.entries(paths)) {
    for (const method of Object.keys(ops as object)) {
      const m = method.toUpperCase();
      if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) {
        keys.add(`${m} ${path}`);
      }
    }
  }
  return keys;
}

// Real public (/v1) routes, normalized to spec-relative OpenAPI-style paths.
function realPublicSpecKeys(routes: Set<RouteKey>): Set<RouteKey> {
  const keys = new Set<RouteKey>();
  for (const key of routes) {
    const [method, url] = key.split(' ', 2);
    if (!url.startsWith('/v1')) continue; // only the public /v1 surface
    keys.add(`${method} ${toOpenApiPath(stripV1(url))}`);
  }
  return keys;
}

describe('OpenAPI route parity', () => {
  it('every documented spec path corresponds to a real route (no stale docs)', async () => {
    const real = realPublicSpecKeys(await collectRoutes());
    const spec = specRouteKeys();

    const staleInSpec = [...spec].filter((k) => !real.has(k)).sort();
    // If this fails, a route documented in openapi.ts was renamed or removed —
    // either restore the route or update the spec.
    expect(staleInSpec, `Spec documents routes that no longer exist:\n${staleInSpec.join('\n')}`).toEqual([]);
  });

  it('reports undocumented public routes (ratchet: allowlist or document them)', async () => {
    const real = realPublicSpecKeys(await collectRoutes());
    const spec = specRouteKeys();

    // Public /v1 routes intentionally NOT in the public API spec (yet). Each
    // entry is a conscious decision: dashboard/session-auth routes, internal,
    // or pending documentation. Shrinking this list = documenting more of the
    // API. It must never SILENTLY grow: a new undocumented public route fails
    // this test until it's either documented in openapi.ts or added here.
    const ALLOWLIST = new Set<RouteKey>([
      // Human-session (dashboard) auth — separate from the API-key public spec.
      'POST /auth/register', 'POST /auth/login', 'POST /auth/logout',
      'POST /auth/mfa', 'POST /auth/mfa/enroll', 'POST /auth/mfa/confirm',
      'POST /auth/mfa/disable',
      'GET /auth/me', 'POST /auth/switch-org',
      'POST /auth/verify-email', 'POST /auth/resend-verification',
      'POST /auth/password/forgot', 'POST /auth/password/reset',
      'GET /auth/sessions', 'DELETE /auth/sessions/{id}',
      // Team management (dashboard).
      'GET /team/members', 'POST /team/invites', 'POST /team/invites/accept',
      'DELETE /team/invites/{id}', 'PATCH /team/members/{userId}',
      'DELETE /team/members/{userId}', 'GET /team/invites',
      // SCIM provisioning token management (dashboard, org-admin gated).
      'GET /team/scim-tokens', 'POST /team/scim-tokens', 'DELETE /team/scim-tokens/{id}',
      // Account API-key self-management (dashboard).
      'GET /account/keys', 'POST /account/keys', 'POST /account/keys/{id}/rotate',
      'DELETE /account/keys/{id}',
      // Account domains/webhooks (dashboard variants of the public ones).
      'GET /account/domains', 'POST /account/domains', 'GET /account/domains/{id}',
      'POST /account/domains/{id}/verify', 'DELETE /account/domains/{id}',
      'GET /account/webhooks', 'POST /account/webhooks', 'PATCH /account/webhooks/{id}',
      'DELETE /account/webhooks/{id}', 'POST /account/webhooks/{id}/rotate-secret',
      // Account billing (dashboard).
      'GET /account/billing', 'POST /account/billing/checkout', 'POST /account/billing/portal',
      // Organization SSO enforcement policy (dashboard, settings:manage gated).
      'GET /account/settings/sso', 'PATCH /account/settings/sso',
      // WebAuthn / passkey management (dashboard, session-auth gated).
      'POST /account/webauthn/register/options', 'POST /account/webauthn/register',
      'GET /account/webauthn/credentials', 'DELETE /account/webauthn/credentials/{id}',
      // Audit & support (dashboard).
      'GET /audit', 'GET /account/audit', 'GET /account/audit/verify', 'GET /support/tickets', 'POST /support/tickets',
      'GET /support/tickets/{id}', 'POST /support/tickets/{id}/messages',
      'POST /support/tickets/{id}/rate',
      // Billing provider webhooks (called by Stripe/PayPal/Cashfree, not customers).
      'POST /billing/webhook', 'POST /billing/webhook/{provider}',
      // Webhook management sub-routes: now documented in openapi.ts (removed
      // from this allowlist as they've been covered).
      // (rotate-secret / test / deliveries / retry-failures / replay documented)
      // Suppression/unsubscribe-group management not yet in the public spec.
      'GET /suppressions/export', 'GET /unsubscribe-groups', 'POST /unsubscribe-groups',
      'PATCH /unsubscribe-groups/{id}', 'DELETE /unsubscribe-groups/{id}',
      'GET /unsubscribe-groups/{id}/members', 'POST /unsubscribe-groups/{id}/members',
      'DELETE /unsubscribe-groups/{id}/members/{email}',
      // Messages sub-routes pending docs.
      'GET /messages/scheduled',
      'DELETE /messages/{messageId}/cancel',
      // Self-serve data exports (Phase 2.2) — pending public spec docs.
      'POST /exports', 'GET /exports', 'GET /exports/{id}', 'GET /exports/{id}/download',
      // analytics/summary|timeseries|breakdown, usage/quota, stats now documented.
      'POST /privacy/delete-recipient', 'GET /privacy/deletions', 'GET /privacy/export-recipient',
      // Legal holds (gap analysis #19) — block erasure for held recipients.
      'GET /privacy/legal-holds', 'POST /privacy/legal-holds', 'POST /privacy/legal-holds/{id}/release',
      'GET /profile', 'PATCH /profile',
      'POST /signup', 'POST /verify-email', 'POST /resend-verification',
      'POST /admin/api-keys',
    ]);

    const undocumented = [...real].filter((k) => !spec.has(k) && !ALLOWLIST.has(k)).sort();
    expect(
      undocumented,
      `New public routes are neither in openapi.ts nor the parity allowlist:\n${undocumented.join('\n')}\n` +
        `Either document them in packages/shared/src/openapi.ts or add them to ALLOWLIST with rationale.`
    ).toEqual([]);
  });
});
