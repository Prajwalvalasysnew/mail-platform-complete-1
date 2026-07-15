import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './schema.js';

// A DB handle that is either the plain global `db` or a transaction (in
// particular, the tenant-scoped transaction produced by `withTenant()`).
// Tenant-scoped service functions should accept this instead of importing the
// global `db` directly, so callers under RLS fail-closed can pass the
// transaction that actually has `app.customer_id` set.
export type DbExecutor = Kysely<Database> | Transaction<Database>;

let _pool: Pool | null = null;
let _db: Kysely<Database> | null = null;

function getConnectionString(): string {
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error('DATABASE_URL is required');
  return cs;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got '${raw}'`);
  return n;
}

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: getConnectionString(),
      // All tunables are env-overridable so each service (API vs worker) can
      // size its pool independently; defaults match the previous hardcoded
      // values. A timeout of 0 disables it (node-postgres semantics).
      max: envInt('PGPOOL_MAX', 20),
      idleTimeoutMillis: envInt('PGPOOL_IDLE_TIMEOUT_MS', 30_000),
      connectionTimeoutMillis: envInt('PGPOOL_CONNECT_TIMEOUT_MS', 5_000),
      // Server-side guards: a runaway query or an abandoned open transaction
      // (which blocks vacuum and holds locks) is killed by Postgres rather
      // than living forever. The migration runner uses its own Pool without
      // these, so long DDL is unaffected.
      statement_timeout: envInt('PG_STATEMENT_TIMEOUT_MS', 30_000),
      idle_in_transaction_session_timeout: envInt('PG_IDLE_TX_TIMEOUT_MS', 60_000),
      application_name: process.env.PG_APPLICATION_NAME ?? process.env.SERVICE_NAME ?? 'mail-platform',
    });
  }
  return _pool;
}

/**
 * Snapshot of pool utilization for metrics/health endpoints. Callers (the
 * services' metrics loops) push these into the mp_pg_pool_connections gauge.
 */
export function poolStats(): { total: number; idle: number; waiting: number } {
  if (!_pool) return { total: 0, idle: 0, waiting: 0 };
  return { total: _pool.totalCount, idle: _pool.idleCount, waiting: _pool.waitingCount };
}

// Lazy proxy: the connection is only established on first actual query,
// so importing this module (e.g. in tests) does not require a live DB.
//
// Methods must be bound to the underlying Kysely instance. Kysely uses native
// ES private fields (e.g. #props); if we returned an unbound method, calling
// `db.insertInto(...)` would invoke it with `this` set to this Proxy (which has
// no private fields) and throw "Cannot read private member #props". Binding
// functions to `_db` keeps the correct receiver. Non-function properties pass
// through unchanged.
export const db: Kysely<Database> = new Proxy({} as Kysely<Database>, {
  get(_target, prop) {
    if (!_db) {
      _db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: getPool() }) });
    }
    const value = Reflect.get(_db as any, prop, _db);
    if (typeof value !== 'function') return value;
    // Bind to the real instance so Kysely's private fields resolve correctly,
    // but preserve any own-properties hanging off the function (e.g. `db.fn` is
    // a callable that also carries `.sum`, `.count`, `.avg`, …). A naive
    // `.bind()` would drop those, so we re-copy them onto the bound function.
    const bound = value.bind(_db);
    for (const key of Object.keys(value)) {
      (bound as any)[key] = (value as any)[key];
    }
    return bound;
  },
});

export async function closeDb(): Promise<void> {
  if (_db) await _db.destroy(); // destroy() ends the pool internally
  _db = null;
  _pool = null;
}
