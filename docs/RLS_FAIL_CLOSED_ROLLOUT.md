# RLS fail-closed rollout checklist

## Why this exists

`infra/migrations/023_rls.sql` enables Postgres RLS on 9 tenant tables, but
every policy has an `OR current_tenant_id() IS NULL` clause. That clause
means: unless the querying session has explicitly set `app.customer_id`,
the policy matches **every row of every tenant**. Nothing in the running API
was calling `withTenant()` (the helper that sets that session var), so in
practice RLS was providing no isolation at all — it was silently permissive,
not silently protective.

`infra/migrations-pending/036_rls_fail_closed.sql` removes that clause for 8
of the 9 tables (see below for why `api_keys` is handled differently) and
adds `FORCE ROW LEVEL SECURITY`. Once applied, any query against those tables
that does **not** run inside a `withTenant()`-scoped transaction will return
**zero rows**, not an error. That is a correctness bug waiting to happen for
every code path that hasn't been converted, so the migration stays in
`infra/migrations-pending/` (outside the auto-applied `infra/migrations/`
directory) until this checklist is complete.

## What "converted" means

A code path is converted when every read/write it makes against messages,
events, suppressions, templates, sending_domains, webhooks, usage_daily, or
review_queue runs on the transaction handle produced by
`tenantScoped(req, ...)` (API routes — see `packages/api/src/lib/tenant.ts`)
or `withTenant(customerId, ...)` (non-request code), not the global `db`.

Worker, tracker, scheduler, and admin code are a deliberate exception: they
are meant to run under a separate Postgres role with `BYPASSRLS` (see
`scripts/setup-rls-roles.sql`), because they either act across many tenants
at once (schedulers, admin listing) or receive events with no authenticated
tenant session (bounce/complaint parsing, tracker pixel hits). Do not wrap
those in `withTenant()` — grant the bypass role instead.

## Done in this pass

- [x] `packages/shared/src/db.ts` — added `DbExecutor` type (`Kysely | Transaction`).
- [x] `packages/api/src/lib/tenant.ts` — added `requestTenantId()` / `tenantScoped()`.
- [x] `packages/shared/src/suppression.ts` — ALL FOUR functions now accept an
      optional `DbExecutor` (default: global `db`): `addSuppression`,
      `addSuppressionsBulk`, `removeSuppression`, AND (this pass)
      `isSuppressedBatch` / `isSuppressed` — the read/cache-check side that
      feeds the send-time suppression filter.
- [x] `packages/shared/src/quota.ts` — `reserveQuota` accepts an optional
      `DbExecutor` for its `usage_daily` cold-cache reconciliation reads.
- [x] `packages/api/src/routes/suppressions.ts` — fully converted (list, add,
      remove, import, export, unsubscribe-groups CRUD).
- [x] `packages/api/src/routes/privacy.ts` — fully converted (delete-recipient,
      deletions list, export-recipient).
- [x] `packages/api/src/routes/send.ts` — **the critical hot path is now
      converted**: both `/send` and `/send/batch` route every touch of
      `templates`, `sending_domains`, `suppressions` (via `isSuppressed(Batch)`),
      and `usage_daily` (via `reserveQuota`) through `tenantScoped()`, as does
      the final `messages`/`events`/`review_queue` insert transaction in both
      handlers. `customers`, `audit_log`, `unsubscribe_groups`, and
      `unsubscribe_group_members` reads are intentionally left on the global
      `db` — none of those are in the RLS-protected table set.
      **Known trade-off:** the batch handler's per-message loop now opens one
      short tenant transaction per recipient for the template lookup and the
      suppression check (previously zero, since it used the global `db`
      directly). For very large batches this adds per-recipient BEGIN/COMMIT
      overhead. Not yet load-tested — see "Still open" below.

## Code conversion: complete. Operational steps: still open.

All application-code conversion is done (verified by the sweep below). What's
left is purely operational — nothing here requires more code changes unless
the load-test in the first bullet finds a real problem:

### Follow-up on send.ts itself
- [ ] Load-test `/send/batch` with large batches (100 messages, the schema's
      max) to quantify the per-recipient transaction overhead introduced
      above. If it's significant, consider batching the per-recipient
      suppression check back into the single `isSuppressedBatch()` call
      (already tenant-scoped, already used earlier in `/send`) instead of
      the per-recipient `isSuppressed()` loop — that would need a small
      restructure of the batch handler's validation loop, not just a
      wrapper swap.

### API routes still on global `db` for the 8 fail-closed tables
- [x] `packages/api/src/routes/templates.ts` — fully converted (list, get,
      create, update, delete). Fully self-contained file, no shared service
      layer to touch.
- [x] `packages/api/src/routes/messages.ts` — fully converted for `messages`/
      `events` (list, scheduled list, get-by-id, cancel). The `send_outbox`
      update inside the cancel handler intentionally stays on global `db` —
      that table isn't in the RLS-protected set.
- [x] `packages/api/src/routes/usage.ts` — `usage_daily` and `events` queries
      converted; the `customers` quota-limits lookup stays on global `db`
      (not RLS-protected).
- [x] `packages/api/src/routes/webhooks.ts` — `webhooks` and `events` (in the
      retry-failures handler) queries converted; `webhook_delivery_log`
      queries intentionally stay on global `db` (not RLS-protected).
- [x] `packages/api/src/routes/analytics.ts` — all three handlers (summary,
      timeseries, breakdown) converted; all query `events` (joined with
      `messages` for two of the three).
- [x] `packages/api/src/routes/customers.ts` — **confirmed no changes needed.**
      `/signup`, `/verify-email`, `/resend-verification` only touch
      `customers` (not RLS-protected) and `api_keys` (policy stays
      permissive by design — see the migration file). `/admin/api-keys` is a
      legacy, pre-existing cross-tenant admin route gated by a static
      `ADMIN_TOKEN`; it's out of scope for this rollout (it was already
      flagged separately in the original gap analysis as needing removal/
      relocation behind the real admin plane — that's a different fix, not
      an RLS one).

### Shared service functions called from those routes
- [x] `packages/shared/src/domains.ts` — see above.
- [x] `packages/shared/src/message-activity.ts` — see above.
- [x] `packages/shared/src/webhooks.ts` — see above.
- [x] `packages/shared/src/outbox.ts` — see above (no changes needed).

### Confirmed no changes needed
- `packages/api/src/routes/account-domains.ts`, `account-webhooks.ts` — only
  ever call the now-converted shared functions with a `customerId`; they
  never touch `db` directly.
- `packages/api/src/routes/customers.ts` — see above.
- `packages/shared/src/testkit.ts` — touches `messages`/`events` but is
  test/seed-only tooling, never imported by a production route file.

## Verification method

Final sweep across every `.ts` file in `packages/api/src` and
`packages/shared/src` (excluding admin/worker/scheduler/retention/
reputation/billing/support/auth-plugin/customers.ts, which are deliberately
untouched — see above) for any remaining `db.selectFrom|updateTable|
insertInto|deleteFrom` call against `messages`, `events`, `suppressions`,
`templates`, `sending_domains`, `webhooks`, `usage_daily`, or `review_queue`.
Result: **zero remaining matches outside `testkit.ts`.** Every production
request-path touch of the 8 fail-closed tables now runs through
`tenantScoped()` (API routes) or an internal `withTenant()` call (shared
modules with a single, always-tenant-known caller).

This was verified by static grep AND a full `tsc` typecheck: after `npm
install`, all four packages (`@platform/shared`, `@platform/api`,
`@platform/worker`, `@platform/tracker`) compile clean with the tenant-scoping
changes in place. Note: the typecheck surfaced a real CJS/ESM dual-package
hazard in the first cut of the tenant executor types — the API (ESM) importing
kysely's `Transaction` independently produced a nominally-distinct type from
`@platform/shared` (CJS), tripping TS's `#private` brand check. Fixed by
exporting a `TenantExecutor` type alias from `packages/shared/src/
tenant-context.ts` and having the API's `tenantScoped` helper use that instead
of importing kysely directly. The DB-backed runtime behavior (does RLS actually
isolate rows) still needs the staging smoke test below — a clean typecheck
proves the wiring is type-correct, not that the policies isolate at runtime.

### Deprioritized — not actually required to ship the migration
- `packages/shared/src/apikey-management.ts` (`api_keys` table) — the prepared
  migration in `infra/migrations-pending/036_rls_fail_closed.sql`
  **deliberately leaves the `api_keys` policy permissive** (see the comment
  in that file — the API-key auth lookup happens before the tenant is known,
  so it can't be tenant-scoped without breaking auth itself). Converting
  `apikey-management.ts` to use `withTenant()` internally would still be good
  defense-in-depth (same one-caller pattern as `domains.ts`), but it doesn't
  block applying the migration the way the tables below do. Worth doing later,
  not urgent.

### Explicitly NOT converting (should use the bypass role instead)
- `packages/api/src/routes/admin.ts` — cross-tenant by design
- `packages/shared/src/retention.ts`, `reputation.ts`, `billing.ts`,
  `support.ts` — scheduler/admin invoked
- `packages/api/src/plugins/auth.ts` — pre-auth key lookup (see the `api_keys`
  note in the migration file)
- Everything in `packages/worker/src/*`, `packages/tracker/src/*`,
  `packages/haraka-*`

## Also required before/at the same time as applying the migration

- [ ] Run `scripts/setup-rls-roles.sql` (or equivalent for your hosting
      provider) against the target database to create a non-superuser,
      non-BYPASSRLS role for the API, and a `BYPASSRLS` role for
      worker/scheduler/admin, and point `DATABASE_URL` for each service at
      the correct role. The API already refuses to boot in production if its
      role can bypass RLS (`rlsIsEnforced()` check in `packages/api/src/server.ts`) —
      that check will start being meaningful once the fail-closed policy is
      live too.
- [ ] Smoke test against a staging DB: create two customers, seed rows in all
      8 tables for both, and verify each customer's API key only ever sees
      its own rows, AND that the worker/scheduler paths still see everything
      they need under the bypass role.

      Note: `packages/tests/rls-isolation.test.ts` already automates the core
      of this. It creates a dedicated non-BYPASSRLS role, seeds two tenants,
      and proves: (1) tenant A cannot see tenant B's rows; (2) a query that
      omits the customer_id filter still cannot leak across tenants; (3) the
      app role is genuinely non-superuser/non-BYPASSRLS; and (4) the
      null-tenant behavior matches whichever policy is applied — it detects
      fail-closed vs permissive at runtime from `pg_policies` and asserts the
      correct contract either way, so it stays green through the rollout and
      will actively catch a regression from fail-closed back to permissive
      once 035 is applied. The remaining manual step is running this against a
      real staging DB with 035 applied (and confirming test 4 takes the
      fail-closed branch), plus the worker/scheduler-under-bypass-role check,
      which the automated test does not yet cover.
- [ ] Once verified, move `infra/migrations-pending/036_rls_fail_closed.sql`
      into `infra/migrations/` under the next free sequence number (there may
      be later numbered migrations by then) and run it through the normal
      migration pipeline.

## Pattern to follow for each remaining file

```ts
// route file
import { tenantScoped } from '../lib/tenant.js';

app.get('/domains', { preHandler: requireScope('domains') }, async (req) => {
  const auth = req.auth!;
  return tenantScoped(req, (trx) => listDomains(auth.customer_id, trx));
});
```

```ts
// shared service file
import { db, type DbExecutor } from './db.js';

export async function listDomains(customerId: string, executor: DbExecutor = db) {
  return executor.selectFrom('sending_domains').selectAll()
    .where('customer_id', '=', customerId).execute();
}
```

Default parameter to the global `db` keeps every existing (unconverted)
caller working exactly as before; only call sites that pass a tenant `trx`
get the RLS benefit. This lets the rollout happen file-by-file without a
big-bang cutover.
