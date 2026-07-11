// Request-scoped tenant DB access for RLS enforcement.
//
// Background: RLS policies on tenant tables (see infra/migrations/023_rls.sql
// and infra/migrations/043_rls_fail_closed.sql) only isolate data when the
// Postgres session has `app.customer_id` set for the duration of the query.
// `withTenant()` (packages/shared/src/tenant-context.ts) opens a transaction
// and sets that session var LOCAL to the transaction.
//
// This module is the glue between a Fastify request (which already knows the
// caller's tenant via API-key auth or session auth) and that transaction, so
// route handlers get a `trx` that is both (a) the only way to reach a tenant
// table under fail-closed RLS and (b) a normal Kysely executor they can pass
// straight to shared service functions.
//
// USAGE: replace `db.selectFrom(...)` in a route handler with
// `tenantScoped(req, (trx) => trx.selectFrom(...))`, and update any shared
// service function it calls to accept a `DbExecutor` parameter instead of
// importing the global `db`.

import type { FastifyRequest } from 'fastify';
import { withTenant, type TenantExecutor } from '@platform/shared';

/**
 * Resolve the authenticated tenant (customer) id for this request, from
 * either API-key auth (`req.auth`) or session auth (`req.user`).
 *
 * Throws if neither is present — that means a route registered this helper
 * behind the wrong auth plugin (or with no auth at all), which is a routing
 * bug, not a runtime condition to swallow. Under fail-closed RLS, silently
 * proceeding with no tenant would make every tenant-table query return zero
 * rows rather than leak data, but it should still fail loudly in dev/tests.
 */
export function requestTenantId(req: FastifyRequest): string {
  const fromApiKey = req.auth?.customer_id;
  const fromSession = req.user?.current_customer_id;
  const id = fromApiKey ?? fromSession;
  if (!id) {
    throw new Error(
      'requestTenantId: no tenant on request (route is missing an auth preHandler, or ran before one)'
    );
  }
  return id;
}

/**
 * Run `fn` inside a transaction scoped to the request's tenant. Use this in
 * place of the global `db` for any query against an RLS-protected table.
 */
export function tenantScoped<T>(
  req: FastifyRequest,
  fn: (trx: TenantExecutor) => Promise<T>
): Promise<T> {
  return withTenant(requestTenantId(req), fn);
}
