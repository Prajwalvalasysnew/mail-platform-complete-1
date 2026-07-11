#!/usr/bin/env bash
# Redis failover drill for mail-platform (BullMQ queues + rate-limit state).
#
# Verifies the two properties that matter when Redis fails over:
#   1. DURABILITY — data written before the failure survives on the promoted
#      node (AOF replicated to a replica), so queued jobs are not lost.
#   2. AVAILABILITY — after promotion the surviving node accepts reads and
#      writes, so the platform recovers.
#
# It stands up a primary + replica with AOF, replicates a marker key, kills the
# primary, promotes the replica (REPLICAOF NO ONE — the action Sentinel/managed
# Redis automates), and asserts the marker survived and new writes succeed. This
# is the manual equivalent of the automatic failover you should also verify
# against your managed Redis/Sentinel topology in staging.
#
# Requires: docker. Self-contained (own network + containers, cleaned up on exit).
#
# Usage:
#   ./scripts/redis-failover-drill.sh

set -euo pipefail

NET="mp-redis-drill-net"
PRIMARY="mp-redis-drill-primary"
REPLICA="mp-redis-drill-replica"
IMAGE="${REDIS_IMAGE:-redis:7-alpine}"

cleanup() {
  docker rm -f "$PRIMARY" "$REPLICA" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "==> creating isolated network + primary/replica (AOF on)"
docker network create "$NET" >/dev/null
docker run -d --name "$PRIMARY" --network "$NET" "$IMAGE" \
  redis-server --appendonly yes --appendfsync everysec >/dev/null
docker run -d --name "$REPLICA" --network "$NET" "$IMAGE" \
  redis-server --appendonly yes --replicaof "$PRIMARY" 6379 >/dev/null

rp() { docker exec "$PRIMARY" redis-cli "$@"; }
rr() { docker exec "$REPLICA" redis-cli "$@"; }

echo "==> waiting for replication to sync"
for i in $(seq 1 30); do
  [ "$(rr -h 127.0.0.1 info replication 2>/dev/null | tr -d '\r' | grep 'master_link_status:up' || true)" ] && break
  sleep 1
  [ "$i" = 30 ] && { echo "FAIL: replica never synced"; exit 1; }
done

MARKER="drill-$(date +%s)"
echo "==> writing marker '$MARKER' to primary and confirming it replicates"
rp set drill:marker "$MARKER" >/dev/null
rp lpush drill:queue job-a job-b job-c >/dev/null
for i in $(seq 1 20); do
  [ "$(rr get drill:marker | tr -d '\r')" = "$MARKER" ] && break
  sleep 0.5
  [ "$i" = 20 ] && { echo "FAIL: marker did not replicate"; exit 1; }
done
echo "    replica has the marker + $(rr llen drill:queue | tr -d '\r') queued jobs"

echo "==> KILLING the primary (simulated failure)"
docker rm -f "$PRIMARY" >/dev/null

echo "==> promoting the replica (REPLICAOF NO ONE)"
rr replicaof no one >/dev/null

# 1. DURABILITY: data written before the failure must survive on the promotee.
GOT="$(rr get drill:marker | tr -d '\r')"
QLEN="$(rr llen drill:queue | tr -d '\r')"
[ "$GOT" = "$MARKER" ] || { echo "FAIL: marker lost across failover (got '$GOT')"; exit 1; }
[ "$QLEN" = "3" ] || { echo "FAIL: queued jobs lost across failover (llen=$QLEN)"; exit 1; }
echo "    durability OK: marker survived, all 3 jobs survived"

# 2. AVAILABILITY: the promoted node must accept new writes.
rr set drill:postfailover ok >/dev/null
[ "$(rr get drill:postfailover | tr -d '\r')" = "ok" ] || { echo "FAIL: promoted node rejects writes"; exit 1; }
echo "    availability OK: promoted node accepts new writes"

echo "==> Redis failover drill PASSED (durability + availability verified)"
