import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '@platform/shared';

const MIGRATIONS_DIR = join(process.cwd(), '..', '..', 'infra', 'migrations');
const createdDbs: string[] = [];

// Count migration files dynamically so adding a migration never breaks the test
// (the previous hardcoded "29" silently went stale the moment a 30th/31st
// migration was added).
async function migrationCount(): Promise<number> {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter((f) => f.endsWith('.sql')).length;
}

function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe db identifier: ${name}`);
  return `"${name}"`;
}

function dbUrl(name: string): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required for migration tests');
  const url = new URL(raw);
  url.pathname = `/${name}`;
  return url.toString();
}

async function adminClient() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required for migration tests');
  const url = new URL(raw);
  url.pathname = '/postgres';
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

async function createDb(prefix: string): Promise<string> {
  const dbName = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
  const client = await adminClient();
  try {
    await client.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
    createdDbs.push(dbName);
    return dbName;
  } finally {
    await client.end();
  }
}

async function dropDb(name: string): Promise<void> {
  const client = await adminClient();
  try {
    await client.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [name]);
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
  } finally {
    await client.end();
  }
}

async function countMigrations(url: string): Promise<number> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const row = await client.query('SELECT count(*)::int AS count FROM schema_migrations');
    return row.rows[0].count;
  } finally {
    await client.end();
  }
}

async function tableExists(url: string, table: string): Promise<boolean> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const row = await client.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      ) AS exists`,
      [table]
    );
    return row.rows[0].exists;
  } finally {
    await client.end();
  }
}

async function applyRawSqlMigrations(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      await client.query(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
    }
  } finally {
    await client.end();
  }
}

describe.runIf(!!process.env.DATABASE_URL)('migration runner', () => {
  afterEach(async () => {
    while (createdDbs.length > 0) {
      await dropDb(createdDbs.pop()!);
    }
  });

  it('applies every migration and records checksums on a fresh database', async () => {
    const name = await createDb('mp_migrate_fresh');
    const oldUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = dbUrl(name);
    try {
      const result = await runMigrations({ dir: MIGRATIONS_DIR, log() {} });
      const total = await migrationCount();
      expect(result.applied).toHaveLength(total);
      expect(result.baselined).toHaveLength(0);
      expect(await countMigrations(process.env.DATABASE_URL)).toBe(total);
      expect(await tableExists(process.env.DATABASE_URL, 'support_ticket_reads')).toBe(true);
    } finally {
      process.env.DATABASE_URL = oldUrl;
    }
  }, 60_000);

  it('baselines a raw-SQL initialized database without replaying migrations', async () => {
    const name = await createDb('mp_migrate_baseline');
    const url = dbUrl(name);
    await applyRawSqlMigrations(url);
    expect(await countMigrations(url)).toBe(0);

    const oldUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    try {
      const result = await runMigrations({ dir: MIGRATIONS_DIR, baselineExisting: true, log() {} });
      const total = await migrationCount();
      expect(result.applied).toHaveLength(0);
      expect(result.baselined).toHaveLength(total);
      expect(await countMigrations(url)).toBe(total);
    } finally {
      process.env.DATABASE_URL = oldUrl;
    }
  }, 60_000);
});
