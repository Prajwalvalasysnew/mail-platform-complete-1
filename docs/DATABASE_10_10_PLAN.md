# Database Architecture: Path from 8/10 to 10/10 Production Grade

This is the execution plan for closing every gap identified in the end-to-end
database review (July 2026). It is scoped to the data layer: Postgres,
ClickHouse, the retention/lifecycle machinery, and the deployment posture
around them. Application-level items live in `PRODUCTION_READINESS_ROADMAP.md`.

> **Status**
> - **Phase 0 — DONE** (v0.7.26): hold-aware batched retention, unbounded-table
>   purges, cutoff indexes (062), pool hardening + gauges.
> - **Phase 1.1 — DONE** (v0.7.27): `events` partitioned by month (063),
>   `event_keys` dedup side table, `partition_maintenance` scheduler job with
>   hold-aware partition drops.
> - Phase 1.2 (messages), Phase 2, 3, 4 — pending.

## Where we stand

| Area | Today | Target |
|---|---|---|
| Schema design, migrations, integrity | 9.5/10 — checksummed forward-only runner, advisory-locked, per-file transactions | keep |
| Tenant isolation | 9/10 — fail-closed RLS with `WITH CHECK`, dedicated roles | keep |
| Data lifecycle **policy** | 9/10 — 90d events/bodies, 365d audit→archive, rollups forever (more generous than SendGrid's 3d / Mailgun's 1–7d) | keep, add per-plan tiers |
| Data lifecycle **mechanics** | 6/10 — unpartitioned firehose tables, unbatched seq-scan DELETEs, four unbounded tables | 10/10 via partitioning + bounded growth |
| Compliance interlock | 8/10 — erasure is hold-gated; **routine retention is not** | 10/10 |
| HA / DR as committed in repo | 6.5/10 — single PG + CH nodes, `pg_dump` drill, no PITR/replicas/pooler | 10/10 |
| Analytics serving | 7/10 — dashboards query the hot OLTP `events` table; ClickHouse underused | 10/10 |

**Overall today: 8/10.** The remaining two points are concentrated in four
phases below, ordered by leverage. Phase 0 is bug-fix territory and should
land first; Phases 1–3 are independent enough to parallelize.

---

## Phase 0 — Immediate correctness & safety fixes (1–2 days)

### 0.1 Make retention legal-hold aware (bug)
`assertNoActiveHold` gates the erasure endpoint (`privacy.ts`), but
`runRetention` (`packages/shared/src/retention.ts`) nulls bodies, deletes S3
objects, and deletes events with **no** hold check. A tenant under litigation
hold still has its data destroyed by the nightly sweep, which defeats the
hold (`docs/LEGAL_HOLD.md` promises the opposite).

- Exclude any customer with an active `scope = 'customer'` hold from all
  destructive retention steps (body null, object delete, event delete).
- For `recipient:<email>` scopes, exclude that recipient's messages/events.
- Emit a metric + log line for rows skipped due to hold, so parked data is
  visible, and re-sweep them once the hold is released.
- Regression tests: hold placed → sweep runs → data intact; hold released →
  next sweep purges.

### 0.2 Stop the unbatched retention DELETE
`DELETE FROM events WHERE occurred_at < cutoff` runs as one transaction and
cannot use any existing index (all lead with other columns) — a seq scan that
will hold locks, spike WAL, and bloat the table at production volume.

- Interim (until Phase 1 partitioning): add `CREATE INDEX CONCURRENTLY
  idx_events_occurred ON events (occurred_at)` and convert the delete to a
  batched loop (`DELETE … WHERE id IN (SELECT id … ORDER BY id LIMIT 10_000)`)
  with a short pause between batches and a per-run row budget.
- Same batching for the inline-body `UPDATE` (step 1 of `runRetention`),
  which has the identical unbounded-transaction problem.

### 0.3 Purge the four unbounded tables
Never cleaned today: `tracked_links`, `webhook_delivery_log`, `messages`
metadata rows (bodies are nulled, rows kept forever), `blocklist_checks`.

- `tracked_links`: delete rows whose message is past body retention (90d).
- `webhook_delivery_log`: 30d default (`RETENTION_WEBHOOK_LOG_DAYS`).
- `blocklist_checks`: 180d.
- `messages` rows: policy decision + `RETENTION_MESSAGE_DAYS` (default 395d
  ≈ 13 months so year-over-year dashboards still work); physical purge
  mechanics land with Phase 1 partitioning, but the knob and the hold-aware
  batched delete can land now.

### 0.4 Harden the connection layer (`packages/shared/src/db.ts`)
- `PGPOOL_MAX` (default 20), `statement_timeout` (default 30s),
  `idle_in_transaction_session_timeout` (default 60s), `application_name`
  per service — all env-driven.
- Export pool gauges (total/idle/waiting) to Prometheus; alert on waiting > 0
  sustained.

**Acceptance:** suite green with new regression tests; retention run on a
seeded 10M-row events table completes in bounded batches without lock waits;
no table in the schema lacks either a retention path or a documented
"grows-with-tenants, bounded" justification (e.g. `suppressions` is correctly
kept forever — industry standard).

---

## Phase 1 — Partitioning & bounded growth (1–2 weeks; the core two points)

### 1.1 Partition `events` by month
No inbound FKs reference `events` (verified), so this is the easy one and
sets the pattern.

- New table `events_p PARTITION BY RANGE (occurred_at)`, PK `(id,
  occurred_at)` (partitioned PKs must include the partition key), same
  composite indexes, RLS policies recreated (`FORCE`, fail-closed, same as
  043).
- Cutover: create partitioned table + partitions → backfill in `id`-order
  batches → brief lock window to swap names → keep `events_legacy` one
  retention cycle as a fallback, then drop. The ClickHouse reconciler
  watermark (`clickhouse_sync_state.last_synced_event_id`) is unaffected —
  ids are preserved.
- New scheduler job `partition_maintenance` (30-min cadence, scheduler-lock
  protected like the rest): pre-create 3 months of future partitions; expired
  partitions are **DETACH**ed, then **DROP**ped only when no active legal
  hold could cover their rows — if a hold exists, the detached partition is
  parked and re-checked each run. Retention for events becomes O(1) metadata
  ops instead of row deletes: no bloat, no vacuum debt, instant.
- `RETENTION_EVENT_DAYS` keeps working: it selects which partitions are
  expired.

### 1.2 Partition `messages` by month (`queued_at`)
Harder because of two constraints, both solvable:

- `UNIQUE (message_id)` must become `UNIQUE (message_id, queued_at)` on a
  partitioned table. Global uniqueness stays guaranteed in practice because
  we generate Message-IDs (UUID-based); document this and keep an app-level
  duplicate check on insert.
- `send_outbox.message_id` FK (`009_send_outbox.sql`) can't reference the
  widened unique constraint. Drop the FK: outbox rows live for seconds-to-
  minutes and are already reconciled by `reclaimStaleSendOutbox`; enforce the
  relationship in the insert path (both rows are written in one transaction
  already) and add an orphan-sweep assertion to the outbox drain.
- Same cutover pattern, maintenance job, and hold-aware detach/drop as 1.1.
  Message rows past `RETENTION_MESSAGE_DAYS` age out by partition drop;
  `usage_daily` and ClickHouse rollups carry the long-term stats.
- Fallback if the cutover risk is unacceptable at the time: keep hot
  `messages` unpartitioned and batch-move expired rows to a partitioned
  `messages_archive` instead (same access paths, slower purge). Decide at
  implementation time; the target state is native partitioning.

### 1.3 Vacuum & bloat guardrails
- Per-table autovacuum tuning for the hot tables (`messages`, `events` until
  partitioned, `send_outbox`, `idempotency_keys`): lower
  `autovacuum_vacuum_scale_factor` (~0.02) and cost limits appropriate to the
  write rate.
- Bloat + dead-tuple + vacuum-age panels in Grafana, alerts in Alertmanager
  (`infra/grafana`, `infra/alertmanager` already exist — extend them).

**Acceptance:** seeded 100M-event / 30M-message dataset; partition drop
completes in <1s with zero lock impact on concurrent send traffic; p99 of
`POST /v1/send` and message listing unchanged before vs. after cutover;
`migration-topology.test.ts` extended to cover the partitioned layout.

---

## Phase 2 — Per-plan retention & customer data lifecycle (≈1 week; product parity)

This is where the competitors monetize. SendGrid ships 3 days of activity by
default and sells 30; Mailgun ships 1–30 days of logs by plan tier; Postmark
sells 7→365-day retention as an add-on. We have a better default (90d) but no
tiering, no per-tenant knob, and no self-serve export.

### 2.1 Plan-tiered retention
- Add `events_retention_days` / `body_retention_days` to the plan catalog
  (`048_billing_plan_catalog.sql`) — e.g. free 7d / pro 30d / scale 90d /
  enterprise custom ≤365d — plus per-customer override columns for
  enterprise deals.
- Enforcement model: **logical retention on reads, physical purge at
  platform max.** Queries (messages list, events, analytics) filter to the
  tenant's window; partition drops happen at the platform-wide maximum
  (365d). This is how you serve mixed tenancy without per-tenant deletes
  fighting partition-level retention.
- `runRetention` body purge honors the per-tenant window (bodies are the
  expensive asset; purge them at the tenant's tier, not the platform max).

### 2.2 Self-serve export (the "contact support" gap, inverted)
SendGrid's answer to >30d history is "you should have consumed the Event
Webhook." Ours can be better:

- `POST /v1/exports` — async job (BullMQ) streaming a tenant's events/
  messages for a date range to NDJSON/CSV in the body store (S3), signed
  download URL, keyset-paginated reads so it never deep-scans.
- Optional scheduled exports (daily/weekly to the customer's own S3 bucket)
  — this is Mailgun's log-forwarding feature and closes the compliance-team
  use case that support tickets otherwise absorb.
- Document the lifecycle publicly (retention per plan, export paths, webhook
  streaming) the way `docs/CLICKHOUSE_DURABILITY.md` documents internals.

### 2.3 ClickHouse alignment
- Raise `mail.events` TTL to the platform max (365d) so enterprise-tier
  analytics have raw events; per-tenant windows enforced logically in query
  helpers. Rollups (`events_daily`) remain unbounded — they are tiny and are
  what power "stats forever," same as the incumbents.

**Acceptance:** plan change immediately changes visible history window
(e2e test); export of a 10M-event month completes without touching p99s;
retention sweep provably honors per-tenant windows + legal holds together.

---

## Phase 3 — HA / DR posture (1–2 weeks, mostly infra; parallelizable)

The code is ready for this (three DB roles already split in helm values;
outbox/reconciler patterns make failover safe). What's missing is the
deployment story the repo actually commits to.

### 3.1 Postgres
- **Primary recommendation: managed Postgres** (RDS/Aurora or Cloud SQL) —
  automated PITR, replicas, failover. **Self-hosted alternative:**
  CloudNativePG operator manifests added under `infra/k8s/` with 1 sync
  replica + pgBackRest WAL archiving to S3.
- Targets to publish in `docs/PRODUCTION_CHECKLIST.md`: **RPO ≤ 5 min, RTO ≤
  30 min**, verified quarterly.
- Extend `scripts/backup-restore-drill.sh` to (a) run against a
  production-sized snapshot, (b) exercise PITR to a timestamp, not just
  dump/restore, (c) record measured RPO/RTO in the drill output.
- Alerts: replication lag, WAL-archive failure, backup age > 24h.

### 3.2 Connection pooling & read routing
- PgBouncer (transaction mode) or RDS Proxy in front of the API/worker.
  `withTenant()` uses `SET LOCAL` inside explicit transactions, which is
  transaction-pooling safe — verify with an integration test in CI.
- Optional `DATABASE_REPLICA_URL`: a read-only executor for analytics
  fallback, exports (2.2), and admin/list endpoints. Not required for 10/10
  but the seam is cheap to add while touching `db.ts`.

### 3.3 ClickHouse & Redis
- ClickHouse: ReplicatedMergeTree + Keeper (3 nodes) or ClickHouse Cloud;
  `clickhouse-backup` to S3 nightly. The reconciler already makes a rebuild
  safe, but note the rebuild window is bounded by Postgres event retention —
  backups are the real recovery path; document this in
  `docs/CLICKHOUSE_DURABILITY.md`.
- Redis: managed/Sentinel; the failover drill (`scripts/redis-failover-drill.sh`)
  already exists — schedule it as a recurring game-day item alongside the
  backup drill in `docs/OPERATIONAL_DRILLS.md`.

**Acceptance:** documented, dated drill results for PG PITR, PG failover,
CH node loss, Redis failover; alerts fire in a game-day simulation; RPO/RTO
published.

---

## Phase 4 — Analytics serving & scale validation (≈1 week)

### 4.1 Serve dashboards from ClickHouse
`analytics.ts` runs `GROUP BY` over the hot Postgres `events` table for up to
30-day windows — the exact load ClickHouse exists to absorb.

- Route `/analytics/summary|timeseries|breakdown` to `events_daily`
  (`uniqExactMerge`) for the 7d/30d windows; keep Postgres for 24h (or when
  `clickhouseEnabled()` is false — the fallback already exists as a pattern).
- Contract tests asserting PG and CH agree on a seeded dataset (the
  reconciler + ReplacingMergeTree design makes exact agreement achievable —
  that's why `uniqExact` was chosen).

### 4.2 Prove it at volume
- Extend `infra/loadtest` to seed 100M events / 30M messages, then run the
  full daily lifecycle under sustained send load: retention sweep, partition
  maintenance, ClickHouse reconcile, export job.
- Publish the numbers (p99 send, p99 events list, sweep duration, replication
  lag during sweep) in `LOAD_TEST_FINDINGS.md`.
- pg_stat_statements + slow-query alerting wired into the existing
  Prometheus/Grafana stack.

**Acceptance:** lifecycle runs under load with no p99 regression >10%; a
dashboard exists where table growth, bloat, partition counts, and sweep
timings are visible at a glance.

---

## What each phase buys on the scorecard

| Phase | Score movement |
|---|---|
| 0 — hold-aware retention, batched deletes, unbounded tables, pool hardening | 8.0 → 8.5 (correctness holes closed) |
| 1 — partitioning + bounded growth | 8.5 → 9.3 (the structural gap) |
| 2 — per-plan retention + exports | product parity with SendGrid/Mailgun/Postmark; monetizes storage |
| 3 — PITR, replicas, pooling, drills | 9.3 → 9.8 (the "sleep at night" gap) |
| 4 — CH-served analytics + load proof | 9.8 → 10 (claims become measurements) |

Suggested sequencing: **Phase 0 immediately** (it contains a compliance bug),
then Phase 1 and Phase 3 in parallel (code vs. infra tracks), Phase 2 once
1.1 lands, Phase 4 last since it validates everything prior.
