// Global setup: load the test environment and isolate test BullMQ queues from
// Docker worker queues.
//
// BUG THIS FIXES: this file previously only set QUEUE_PREFIX — .env.test and
// .env.test.local were never loaded by anything, despite docs/comments in both
// files claiming "the test suite loads this automatically via dotenv". A fresh
// clone running `npm test` without first manually exporting DATABASE_URL etc.
// would fail to connect (or worse, silently hit whatever DATABASE_URL happened
// to be set in the shell — e.g. a dev database).
//
// Load order (matches the documented intent in .env.test.local's header):
//   1. .env.test        — shared test defaults, safe to commit.
//   2. .env.test.local   — developer/CI-specific overrides (e.g. non-default
//                         ports), takes priority over .env.test.
// Real environment variables exported by the shell/CI always take priority.
// .env.test.local overrides only the shared defaults from .env.test.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/tests/ -> repo root
const repoRoot = path.resolve(__dirname, '..', '..');

export async function setup() {
  const externalEnvironment = { ...process.env };
  dotenv.config({ path: path.join(repoRoot, '.env.test') });
  dotenv.config({ path: path.join(repoRoot, '.env.test.local'), override: true });

  // dotenv's override option cannot distinguish values loaded from
  // .env.test from values explicitly supplied by CI. Restore the latter so a
  // developer-local file can never redirect CI to local-only ports/services.
  for (const [key, value] of Object.entries(externalEnvironment)) {
    if (value !== undefined) process.env[key] = value;
  }

  if (!process.env.DATABASE_URL) {
    // Fail loudly and immediately rather than letting the first test's DB
    // call throw a confusing connection error deep in a Kysely query.
    throw new Error(
      'DATABASE_URL is not set after loading .env.test / .env.test.local. ' +
        'Run `docker compose -f docker-compose.test.yml up -d` (or point ' +
        'DATABASE_URL at a local Postgres) before running tests.'
    );
  }

  // QUEUE_PREFIX is read by @platform/shared at module load time, so it must
  // be set before any test file imports from that package.
  if (!process.env.QUEUE_PREFIX) {
    process.env.QUEUE_PREFIX = `test_${Date.now()}_`;
  }

  // Apply migrations to the (fresh) test database so the suite is
  // self-provisioning: `docker compose -f docker-compose.test.yml up -d` then
  // `npm test` just works, with no separate manual `npm run migrate` step
  // against the correct (5434) test DB. runMigrations() is idempotent — it
  // uses an advisory lock + schema_migrations bookkeeping, so on an
  // already-migrated DB it simply no-ops. Skippable via SKIP_TEST_MIGRATE=1
  // for callers that provision the schema themselves (e.g. some CI setups).
  if (process.env.SKIP_TEST_MIGRATE !== '1') {
    // Imported lazily and by path so this file has no hard dependency on the
    // built dist when only non-DB unit tests are being run without a database.
    const { runMigrations } = await import('@platform/shared');
    const migrationsDir = path.join(repoRoot, 'infra', 'migrations');
    try {
      await runMigrations({ dir: migrationsDir, log() {} });
    } catch (err) {
      throw new Error(
        `Test setup failed to apply migrations against DATABASE_URL. Is the test ` +
          `Postgres up (docker compose -f docker-compose.test.yml up -d)? ` +
          `Underlying error: ${(err as Error).message}`
      );
    }
  }
}

export async function teardown() {
  // @platform/shared owns module-level BullMQ Queue clients and a lazy Kysely
  // pool. Leaving either alive makes Vitest wait for its Vite server shutdown
  // timeout even after every assertion has passed. This is deliberately global
  // teardown (rather than per-test-file cleanup): queues are singletons and
  // later files in the sequential suite may still need them.
  const { closeDb, closeQueues } = await import('@platform/shared');
  await closeQueues();
  await closeDb();
}
