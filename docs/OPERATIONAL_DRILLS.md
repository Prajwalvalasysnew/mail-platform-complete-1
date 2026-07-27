# Operational drills & load tooling (Phase 4)

This is the operator runbook for the reproducible reliability drills and load
scenarios. It closes the tooling side of the "HA/DR and failure evidence" and
"operational certification" gaps: the scripts are runnable and self-checking, so
the *evidence* can be produced on demand. Where a drill can only be fully proven
against production-sized data or a live cluster, that is called out explicitly.

## Quick index

| Concern | Tool | Runnable locally? |
| --- | --- | --- |
| Kubernetes manifests render & are well-formed | `scripts/helm-render-check.sh` | ✅ yes (helm) |
| Redis failover: durability + availability | `scripts/redis-failover-drill.sh` | ✅ yes (docker) |
| Postgres backup → restore integrity + RTO | `scripts/backup-restore-drill.sh` | ✅ yes (docker) |
| Postgres point-in-time recovery (PITR) + RPO/RTO evidence | `scripts/pitr-drill.sh` | ⚠️ needs a CNPG cluster with object-store backups (see docs/HA_DR.md) |
| Send pipeline throughput/SLO | `infra/loadtest/send.js` (k6) | ⚠️ needs a running API |
| Tracker (open/click) throughput/SLO | `infra/loadtest/tracker.js` (k6) | ⚠️ needs a running tracker |

## Helm render check

```
./scripts/helm-render-check.sh
```

Lints the chart, renders it with default **and** production-like overlays, and
parses every rendered document to confirm it is valid Kubernetes YAML with the
required workload kinds. Reproducible evidence for the previously-skipped
"Helm rendering not executed" certification item.

Last local run: **PASSED** — 27 valid manifests per overlay (Deployments,
Services, ConfigMaps, HPAs, PDBs, NetworkPolicies, a StatefulSet, and the
migration Job).

## Redis failover drill

```
./scripts/redis-failover-drill.sh
```

Stands up a primary + AOF replica, replicates a marker key and a queue, kills
the primary, promotes the replica (`REPLICAOF NO ONE` — the action managed
Redis/Sentinel automates), and asserts:

1. **Durability** — the marker and all queued jobs survived on the promotee.
2. **Availability** — the promoted node accepts new reads/writes.

Last local run: **PASSED**. In staging, also verify *automatic* failover via
your managed Redis/Sentinel and that BullMQ workers reconnect without dropping
in-flight jobs.

## Postgres backup / restore drill

```
./scripts/backup-restore-drill.sh
```

Dumps the live DB, restores into a scratch database, and verifies table count,
migration-history parity, and per-table row counts. Now also prints a measured
**restore time (RTO proxy)**. For a real RPO/RTO SLA, run against a
production-sized snapshot with your actual object storage attached, and measure
point-in-time-recovery lag (RPO) from WAL archiving — not just the logical
restore covered here.

**Privacy verification (BASE-12).** The drill also checks that erased data
stayed gone, not only that data came back: no tombstoned message exists again,
consent rows marked pseudonymized still hold a pseudonym, and the suppression
count is reported for comparison against the pre-restore figure.

This drill restores a dump of the *current* database, so it cannot resurrect
anything by itself. A real restore from an **older** image can, and tombstone
replay is mandatory before the restored node serves traffic — see
[restore re-deletion](runbooks/RESTORE_RE_DELETION.md). On a development
database the first check can trip on test fixtures
(`privacy-worker-tombstone.e2e.test.ts` deliberately seeds a tombstone beside a
surviving message); run the drill against production or a production-shaped
copy.

## k6 load scenarios

```
k6 run -e API_URL=http://localhost:3000 -e API_KEY=mp_test_... infra/loadtest/send.js
k6 run -e TRACKER_URL=http://localhost:3002 infra/loadtest/tracker.js
```

Each scenario carries its SLO as k6 `thresholds` (latency percentiles,
acceptance/answer rate, error rate), so a regression fails the run. Use a
`mp_test_` key for `send.js` to exercise the full admission path without sending
real mail. For a capacity report, run these against a staging deployment sized
like production and record the sustained RPS at which thresholds still hold.

## Still requires live infrastructure (Phase 4 evidence, not code)

These are authored/queued but can only be *proven* against real infra:

- **k6 soak against staging** with a published capacity/headroom report.
- **Automatic** Redis (Sentinel/managed) and Postgres failover, with measured
  RPO/RTO against production-sized data.
- **ClickHouse dedup drill**: insert the same event via both the hot path and
  the reconciler against a real ClickHouse, force a merge, and assert one stored
  row and one counted event (schema proven statically in
  `clickhouse-schema.test.ts`; see `docs/CLICKHOUSE_DURABILITY.md`).
- **Haraka MTA**: real TLS certificate + STARTTLS proof, static inbound IP,
  PTR/forward-DNS/HELO alignment, and node/pod disruption recovery.
- **Worker chaos**: crash / network-partition / SMTP-outage injection with
  queue-drain verification.
