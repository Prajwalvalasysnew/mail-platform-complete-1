// Tenant context for Row-Level Security (RLS) enforcement.
//
// Background: 023_rls.sql introduced permissive rollout policies. Migration
// 043_rls_fail_closed.sql removes the null-tenant escape hatch and forces RLS.
// Cross-tenant worker/admin processes use an explicit BYPASSRLS service role;
// the API must use a non-bypass role and set `app.customer_id` transactionally.
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
 * Returns true only when the current role cannot bypass RLS and every required
 * tenant table has FORCE RLS plus a fail-closed tenant policy. Any inspection
 * error returns false so production startup fails closed.
 */
export async function rlsIsEnforced(): Promise<boolean> {
  try {
    const roleSafe = await db
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
    if (!roleSafe) return false;

    const requiredTables = [
      'messages', 'events', 'suppressions', 'templates', 'sending_domains',
      'webhooks', 'usage_daily', 'review_queue', 'consent_events', 'legal_holds',
    ];
    const posture = await sql<{
      table_name: string;
      rls_enabled: boolean;
      rls_forced: boolean;
      policy_qual: string | null;
    }>`
      select c.relname as table_name,
             c.relrowsecurity as rls_enabled,
             c.relforcerowsecurity as rls_forced,
             p.qual as policy_qual
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policies p
        on p.schemaname = n.nspname
       and p.tablename = c.relname
       and p.policyname = c.relname || '_tenant'
      where n.nspname = 'public'
        and c.relname in (${sql.join(requiredTables)})
    `.execute(db);

    if (posture.rows.length !== requiredTables.length) return false;
    return posture.rows.every((row) => {
      const qual = row.policy_qual ?? '';
      return row.rls_enabled
        && row.rls_forced
        && /current_tenant_id\(\)/i.test(qual)
        && !/current_tenant_id\(\)\s+IS\s+NULL/i.test(qual);
    });
  } catch {
    // A failed posture probe is not evidence of safety. Production startup
    // must fail closed until the database role and policies can be verified.
    return false;
  }
}
