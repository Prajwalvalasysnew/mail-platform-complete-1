// Migration runner. Replaces "raw .sql files applied by hand" with a tracked
// runner: it records applied versions + checksums in schema_migrations, applies
// pending files in lexical order inside a transaction each, and refuses to run
// if a previously-applied file's checksum changed (drift detection).
//
// Forward-only by default (transactional email schemas rarely need down
// migrations in prod); a --down hook is intentionally omitted to avoid
// dangerous rollbacks. CI runs this against a fresh DB to catch broken SQL.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { Pool } from 'pg';

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? join(process.cwd(), 'infra', 'migrations');

function checksum(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [table]
  );
  return rows[0]?.exists ?? false;
}

export async function runMigrations(
  opts: { dir?: string; log?: (m: string) => void; baselineExisting?: boolean } = {}
): Promise<{ applied: string[]; baselined: string[] }> {
  const dir = opts.dir ?? MIGRATIONS_DIR;
  const log = opts.log ?? ((m: string) => console.log(`[migrate] ${m}`));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const applied: string[] = [];
  const baselined: string[] = [];
  // Serialize concurrent migration runs (e.g. several workers booting at once
  // during a horizontal scale-out). A session-level advisory lock makes all but
  // one runner wait; the others then see migrations already applied and no-op.
  // The constant is an arbitrary fixed key shared by all instances.
  const LOCK_KEY = 4572918843;
  const lockConn = await pool.connect();
  try {
    await lockConn.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
    // Bootstrap the bookkeeping table (idempotent).
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), checksum TEXT)`);

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await pool.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations'
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    if (opts.baselineExisting && done.size === 0 && await tableExists(pool, 'customers')) {
      log('baselining existing schema_migrations from current migration files');
      for (const file of files) {
        const sql = await readFile(join(dir, file), 'utf8');
        const sum = checksum(sql);
        await pool.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
          [file, sum]
        );
        done.set(file, sum);
        baselined.push(file);
      }
      log(`baselined ${baselined.length} migration(s)`);
    }

    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      const sum = checksum(sql);
      const version = file;
      if (done.has(version)) {
        const prev = done.get(version);
        if (prev && prev !== sum) {
          throw new Error(`migration ${version} changed after being applied (checksum ${prev} -> ${sum}); migrations are immutable`);
        }
        continue;
      }
      log(`applying ${version}`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, sum]);
        await client.query('COMMIT');
        applied.push(version);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${version} failed: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }
    log(applied.length ? `applied ${applied.length} migration(s)` : 'no pending migrations');
    return { applied, baselined };
    } finally {
      await lockConn.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    lockConn.release();
    await pool.end();
  }
}
