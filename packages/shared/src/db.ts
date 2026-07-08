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

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: getConnectionString(),
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return _pool;
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
