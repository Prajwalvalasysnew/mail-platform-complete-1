# Gap analysis Top-20: items #5, #6, #7 status

## #6 Production migrations — RESOLVED (was already fixed; now guarded)

Report claim: "App containers still run migrations; Helm also has migration job."

Verified in this snapshot — the claim is STALE. The migration topology is
already correct on every path:

- **App boot code never migrates.** Exhaustive grep of `packages/api/src`,
  `packages/worker/src`, `packages/tracker/src` finds no `runMigrations()` or
  `migrate.js` call.
- **App Dockerfiles have clean CMDs** (`node .../server.js` etc.) — no migrate
  step, no entrypoint script that migrates.
- **docker-compose.yml** defines a dedicated one-shot `migrate` service and the
  app services gate on it with `condition: service_completed_successfully`
  (they wait for migrations to FINISH, not merely start). The comment in the
  file explicitly notes app containers no longer migrate at startup because
  "multiple replicas racing DDL on deploy" is unsafe.
- **docker-compose.production.yml** is an overlay applied on top of the base
  compose (`-f docker-compose.yml -f docker-compose.production.yml`), so it
  inherits the migrate service and the dependency gate.
- **Helm** runs migrations as a `pre-install,pre-upgrade` hook Job with
  `hook-weight: -5` (before app workloads), non-root, dropped capabilities,
  `backoffLimit: 3`. As a Helm hook it completes before app pods roll out.

**Added:** `packages/tests/migration-topology.test.ts` (6 tests) locks this in
— it fails if anyone reintroduces a migrate step into an app Dockerfile CMD or
app boot code, or removes the dedicated migrate service / Helm hook. This
converts a "currently correct by luck" state into a regression-guarded one.

## #5 Deliverability proof — NOT resolvable in this environment

Report: "Warmup/reputation code exists but real inbox placement is unproven."

The CODE exists and is tested: `warmup.ts` (IP pool warmup schedule),
`reputation.ts` (pool reputation tracking), soft-bounce escalation, DKIM
rotation (now tested), SPF/DMARC verification. What the report asks for —
"real inbox placement" — means actually sending mail to seed inboxes at Gmail/
Outlook/Yahoo and measuring placement, plus per-ISP throttling proven against
real ISP feedback. That REQUIRES:
- real sending IPs with PTR/rDNS,
- authenticated domains with live DNS,
- seed-list accounts at each major ISP,
- days-to-weeks of warmup traffic.

None of that is possible in a sandbox with no outbound SMTP, no real domains,
no ISP accounts. This is an operational proof task, not a code gap. It cannot
be honestly closed here; marking it done would be fabrication.

## #7 HA/DR proof — NOT resolvable in this environment

Report: "Managed Postgres/Redis HA and restore drills are documented more than
proven."

Same category. The repo documents HA/DR (managed Postgres with replicas,
Redis HA, backup/restore runbooks — see scripts/backup-restore-drill.sh). But
"proven" means actually failing over a real managed database, restoring from a
real backup, and measuring RTO/RPO against a running cluster. That needs live
cloud infrastructure. Cannot be done or honestly claimed in this sandbox.

## Summary

- #6: was already fixed; verified exhaustively and now guarded by a test.
- #5, #7: genuinely blocked on external infrastructure (real mail sending / real
  cloud cluster). The code scaffolding exists and is tested where testable; the
  remaining "proof" is an ops exercise that cannot be performed here.
