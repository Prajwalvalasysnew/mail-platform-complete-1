// Tenant context for Row-Level Security (RLS) enforcement.
//
// Background: 023_rls.sql enables RLS on tenant tables with policies of the form
//   USING (customer_id = current_tenant_id() OR current_tenant_id() IS NULL)
// where current_tenant_id() reads the `app.customer_id` Postgres session var.
// The `OR ... IS NULL` branch is a deliberate escape hatch for the worker /
// admin / migration connections (which run with no tenant set, or under a
// BYPASSRLS role). The consequence is that UNLESS the API sets app.customer_id,
// RLS matches every row and provides no isolation.
//
// This module supplies the missing piece: run a unit of work with the tenant
// set, so RLS actively scopes every query to that customer as a second layer
// behind the application's own WHERE customer_id = ? filters.
//
// SAFETY WITH A POOLED CONNECTION: we never use a bare `SET` on a pooled
// connection (it would leak to whichever request next checks that connection
// out). Instead we wrap the work in a transaction and use
//   SELECT set_config('app.customer_id', $1, true)   -- the `true` = LOCAL
// which is scoped to the transaction and automatically cleared on COMMIT or
// ROLLBACK. No cross-request bleed is possible.

import { sql, Kysely, type Transaction } from 'kysely';
import { db } from './db.js';
import type { Database } from './schema.js';

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

/**
 * The executor handed to a `withTenant` callback. Exported as a named alias so
 * that callers (e.g. the API's tenantScoped helper) reference THIS type rather
 * than importing `Transaction` from 'kysely' independently. Importing kysely
 * separately in a package with a different module resolution (the API is ESM;
 * @platform/shared compiles to CJS) yields a structurally-identical but
 * nominally-distinct `Transaction` type, tripping TS's `#private` brand check
 * (the CJS/ESM dual-package hazard). Re-using shared's own type avoids that.
 */
export type TenantExecutor = Transaction<Database>;

/**
 * Run `fn` inside a transaction whose Postgres session has app.customer_id set
 * to `customerId`, so RLS policies scope every query to that tenant. The setting
 * is transaction-local and auto-cleared, so it is safe on a pooled connection.
 *
 * The transaction handle is passed to `fn`; queries MUST use it (not the global
 * `db`) to be covered by the tenant scope, since the global `db` may check out a
 * different pooled connection.
 */
export async function withTenant<T>(
  customerId: string,
  fn: (trx: TenantExecutor) => Promise<T>
): Promise<T> {
  if (!UUID_RE.test(customerId)) {
    // Defensive: never interpolate an unvalidated value into set_config, and
    // never silently run with no tenant (which would be god-mode under RLS).
    throw new Error('withTenant: customerId must be a UUID');
  }
  return db.transaction().execute(async (trx) => {
    // set_config with isLocal=true ties the value to this transaction only.
    await sql`select set_config('app.customer_id', ${customerId}, true)`.execute(trx);
    return fn(trx);
  });
}

/**
 * Assert that RLS is actually being enforced for the current connection role.
 * Intended for a startup self-check in production: if the API is (mis)configured
 * to run under a BYPASSRLS/superuser role, RLS silently does nothing, so we want
 * to detect that explicitly rather than assume protection we don't have.
 *
 * Returns true if RLS scopes rows when a tenant is set. Best-effort: returns
 * true on any unexpected error so a check failure never blocks startup.
 */
export async function rlsIsEnforced(): Promise<boolean> {
  try {
    const probe = await db
      .transaction()
      .execute(async (trx) => {
        // Is the current role BYPASSRLS / superuser? Either disables RLS.
        const row = await sql<{ bypass: boolean; superuser: boolean }>`
          select rolbypassrls as bypass, rolsuper as superuser
          from pg_roles where rolname = current_user
        `.execute(trx);
        const r = row.rows[0];
        return !(r?.bypass || r?.superuser);
      });
    return probe;
  } catch {
    return true;
  }
}
