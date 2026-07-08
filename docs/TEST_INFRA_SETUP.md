# Test infrastructure: self-provisioning setup

## The problem (verified)

Running the DB-backed test suites (RLS isolation, e2e send pipeline, resource
CRUD, etc.) required a manual, error-prone sequence, and the docs pointed at the
WRONG database:

- `packages/tests/global-setup.ts` loaded `.env.test` (test Postgres on
  **5434**) but never applied migrations.
- `docs/TESTING.md` told you to migrate against the DEV compose
  (`docker compose up -d postgres redis`, port **5432**).

So a fresh contributor following the docs would migrate 5432, then the suite
would connect to 5434 and fail with confusing "relation does not exist" errors
deep inside the first query.

## The fix

`packages/tests/global-setup.ts` now applies migrations against whatever
`DATABASE_URL` resolves to, as part of vitest global setup:

- Uses the existing idempotent `runMigrations()` (advisory lock +
  `schema_migrations` bookkeeping), so on an already-migrated DB it no-ops —
  safe to run every time, and safe alongside CI's explicit migrate step (which
  now becomes belt-and-suspenders rather than required).
- On connection failure it throws a clear, actionable message naming the exact
  command to bring up the test infra, instead of a cryptic Kysely error.
- Skippable with `SKIP_TEST_MIGRATE=1` for pure-logic unit runs with no
  database available, or CI setups that provision the schema themselves.

`docs/TESTING.md` updated to the now-correct, minimal workflow:

```bash
docker compose -f docker-compose.test.yml up -d   # isolated test infra (5434/6380)
npm run build
npm test                                           # migrations auto-applied first
```

## Verified how

- Full monorepo build: exit 0, zero TS errors.
- Pure-logic suite (8 files, 70 tests) passes with `SKIP_TEST_MIGRATE=1`,
  confirming the async setup change didn't break the no-DB path.
- The no-DB, no-skip failure path was exercised: it produces the intended
  "Is the test Postgres up (docker compose -f docker-compose.test.yml up -d)?"
  error naming the correct port (5434), rather than hanging or erroring
  cryptically.

## What was actually run (full DB-backed verification)

The complete suite WAS run against real infrastructure (Postgres 18.4 via
`embedded-postgres`, Redis 7.4.1 compiled from source — since Docker was
unavailable, these were stood up directly as local processes on the test ports
5434/6380):

- **All 34 migrations** applied cleanly to a fresh database.
- **Full suite: 83 test files, 559 tests, 0 failures** — including every
  DB-backed and e2e suite (send pipeline, RLS isolation, webhooks service,
  event idempotency, DLQ, privacy erasure, billing reconciliation, admin/user
  MFA, etc.).
- **Self-provisioning proven end-to-end**: dropping to a completely empty
  database and running an e2e suite, `global-setup.ts` migrated it from scratch
  automatically and the tests passed — confirming the
  `docker compose up && npm test` one-liner behavior this change enables.

So the earlier limitation note ("DB-backed suites could not be executed here")
no longer applies — they were executed and are green.
