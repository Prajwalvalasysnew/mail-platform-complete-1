# HA / DR posture (DATABASE_10_10_PLAN Phase 3)

This is the deployment story for the data layer: what the platform commits
to, which components deliver it, and how the claims are verified with drills
instead of asserted.

## Targets (publish these, verify quarterly)

| Metric | Target | Verified by |
|---|---|---|
| RPO (data loss on total primary loss) | ≤ 5 min | continuous WAL archiving; `scripts/pitr-drill.sh` |
| RPO (single-node loss with failover) | 0 | 1 synchronous replica (CNPG) / managed sync standby |
| RTO (failover) | ≤ 2 min | operator/managed automatic promotion |
| RTO (full PITR rebuild) | ≤ 30 min at production size | `scripts/pitr-drill.sh` measured restore time |
| Backup age | < 24 h base backup + continuous WAL | `mail-postgres-nightly` ScheduledBackup + alerting |

Record each drill's measured numbers in `docs/PRODUCTION_CHECKLIST.md`.

## Postgres

**Preferred: managed Postgres** (RDS/Aurora, Cloud SQL). You get PITR,
replicas, and failover as configuration. Set:

- `MIGRATION_DATABASE_URL` → owner role (DDL)
- `API_DATABASE_URL` → `mail_api` (non-BYPASSRLS; the API refuses to boot in
  production otherwise)
- `SERVICE_DATABASE_URL` → `mail_service` (BYPASSRLS)

Roles come from `scripts/setup-rls-roles.sql`, run once per environment.

**Self-hosted: CloudNativePG** — `infra/k8s/postgres-cnpg.yaml` is a
reviewed example: 3 instances, 1 synchronous replica, continuous WAL
archiving to S3, nightly base backups, 30-day retention, PodMonitor for
Prometheus. Apply the CNPG operator first; adjust storage class, sizes, and
the S3 bucket.

**PITR drills.** `scripts/backup-restore-drill.sh` (dump→restore integrity)
remains the quick local check. `scripts/pitr-drill.sh` is the real one: it
writes a marker, PITR-bootstraps a fresh cluster from the object store to a
timestamp, asserts the marker survived and post-target writes did not, and
measures restore time. Run it quarterly against production-sized storage.

## Connection pooling

Every service already runs a bounded in-process pool (`PGPOOL_MAX`, default
20) with `statement_timeout` / `idle_in_transaction_session_timeout` kill
switches. At higher API replica counts put **PgBouncer in transaction
mode** (or RDS Proxy) in front of the API/worker roles:

- The tenant-RLS layer is transaction-pooling safe by construction:
  `withTenant()` issues `SET LOCAL app.customer_id` **inside an explicit
  transaction**, so the setting never leaks across pooled sessions.
- Keep the migration runner OFF the pooler (it needs session semantics and
  no statement timeout).
- Watch `mp_pg_pool_connections{state="waiting"}` — the `PgPoolSaturated`
  alert fires when requests queue for a connection.

## Read replica seam

Set `DATABASE_REPLICA_URL` to a read-only endpoint (CNPG's `-ro` service, an
RDS reader) and `getReadDb()` returns a replica-backed Kysely instance
(`PGPOOL_REPLICA_MAX`, default 10). Unset, it is the primary — callers never
special-case. Route only lag-tolerant reads there (exports, analytics,
admin listings); anything read-after-write stays on the primary.

## ClickHouse

Analytics only — Postgres is the source of truth and the reconciler
backfills gaps (`docs/CLICKHOUSE_DURABILITY.md`). For HA:

- **ClickHouse Cloud**, or self-hosted `ReplicatedMergeTree` across 3 nodes
  with ClickHouse Keeper.
- Nightly `clickhouse-backup` to S3. Note the rebuild-from-Postgres window
  is bounded by `RETENTION_EVENT_DAYS` — beyond it, backups are the only
  recovery path for raw events (rollups are tiny; back them up too).
- Keep the events TTL in lockstep with `RETENTION_EVENT_DAYS` (see
  `infra/clickhouse/init.sql`).

## Redis

Queues and counters. BullMQ jobs are reconstructable (send outbox drains,
event reconciler), and quota baselines are durable-seeded from Postgres, so
Redis loss is degradation, not data loss. Still: use managed Redis or
Sentinel with AOF (`appendonly yes` is already in the production compose),
and run `scripts/redis-failover-drill.sh` as part of the drill cadence.

## Alerting on the data layer

`infra/prometheus/alerts.yml` gained a `data-layer` group: default-partition
strays (events + messages), pool saturation, and a legal-hold retention
backlog. Add provider-side alerts for: replication lag > 60s, WAL archive
failures, backup age > 24h — these live where the cluster lives (CNPG
PodMonitor metrics or CloudWatch/Cloud SQL equivalents).
