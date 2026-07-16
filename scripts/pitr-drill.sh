#!/usr/bin/env bash
# Point-in-time-recovery drill for mail-platform on CloudNativePG
# (DATABASE_10_10_PLAN Phase 3.1). Verifies the thing backups exist for:
# that you can actually restore to a timestamp, and measures how long it
# takes (RTO) and how much data the WAL archive would lose (RPO proxy).
#
# What it does:
#   1. Writes a marker row into the live cluster and records T0.
#   2. Creates a NEW CNPG cluster bootstrapped by PITR from the live
#      cluster's object-store backup, targeting T0.
#   3. Waits for recovery, asserts the marker row exists in the restored
#      cluster and that rows written after T0 do NOT.
#   4. Reports elapsed restore time, then deletes the drill cluster.
#
# Run quarterly (docs/OPERATIONAL_DRILLS.md) and record the numbers in
# docs/PRODUCTION_CHECKLIST.md. This drill is only as honest as the data
# size — run it against production-sized storage, not an empty cluster.
#
# Usage:
#   CLUSTER=mail-postgres NAMESPACE=default ./scripts/pitr-drill.sh
#
# Env:
#   CLUSTER      source CNPG cluster name        (default: mail-postgres)
#   NAMESPACE    kubernetes namespace            (default: default)
#   DRILL_NAME   restored cluster name           (default: <cluster>-pitr-drill)
#   PG_DB        database name                   (default: mail_platform)
#   PG_USER      database owner                  (default: mail)
#   KEEP=1       keep the drill cluster afterwards (default: delete)

set -euo pipefail

CLUSTER="${CLUSTER:-mail-postgres}"
NAMESPACE="${NAMESPACE:-default}"
DRILL_NAME="${DRILL_NAME:-${CLUSTER}-pitr-drill}"
PG_DB="${PG_DB:-mail_platform}"
PG_USER="${PG_USER:-mail}"

info() { echo "[pitr-drill] $*"; }
fail() { echo "[pitr-drill] ✗ $*" >&2; exit 1; }
ok()   { echo "[pitr-drill] ✓ $*"; }

psql_live() {
  kubectl exec -n "$NAMESPACE" "${CLUSTER}-1" -c postgres -- \
    psql -U "$PG_USER" -d "$PG_DB" -tAc "$1"
}
psql_drill() {
  kubectl exec -n "$NAMESPACE" "${DRILL_NAME}-1" -c postgres -- \
    psql -U "$PG_USER" -d "$PG_DB" -tAc "$1"
}

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    info "deleting drill cluster $DRILL_NAME"
    kubectl delete cluster.postgresql.cnpg.io -n "$NAMESPACE" "$DRILL_NAME" --ignore-not-found
  fi
}
trap cleanup EXIT

# ── 1. Marker row + recovery target time ────────────────────────────────────
MARKER="pitr-drill-$(date +%s)"
info "writing marker '$MARKER' to live cluster"
psql_live "CREATE TABLE IF NOT EXISTS pitr_drill_markers (marker TEXT PRIMARY KEY, at TIMESTAMPTZ DEFAULT now());"
psql_live "INSERT INTO pitr_drill_markers (marker) VALUES ('$MARKER');"
sleep 2
T0=$(psql_live "SELECT to_char(now(), 'YYYY-MM-DD HH24:MI:SS.US+00');")
sleep 2
psql_live "INSERT INTO pitr_drill_markers (marker) VALUES ('${MARKER}-after-t0');"
ok "marker committed; recovery target T0=$T0 (the -after-t0 row must NOT survive)"

# Force a WAL switch so T0 is definitely in the archive.
psql_live "SELECT pg_switch_wal();" > /dev/null
sleep 5

# ── 2. PITR-bootstrap a new cluster from the backup object store ────────────
info "creating drill cluster $DRILL_NAME (PITR to $T0)"
RESTORE_START=$SECONDS
kubectl apply -n "$NAMESPACE" -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: ${DRILL_NAME}
spec:
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:16.4
  storage:
    size: 200Gi
  bootstrap:
    recovery:
      source: ${CLUSTER}
      recoveryTarget:
        targetTime: "${T0}"
  externalClusters:
    - name: ${CLUSTER}
      barmanObjectStore:
        destinationPath: s3://YOUR-BACKUP-BUCKET/mail-postgres
        s3Credentials:
          accessKeyId:
            name: mail-pg-s3-creds
            key: ACCESS_KEY_ID
          secretAccessKey:
            name: mail-pg-s3-creds
            key: SECRET_ACCESS_KEY
EOF

info "waiting for drill cluster to become ready (this is your RTO)"
kubectl wait --for=condition=Ready -n "$NAMESPACE" \
  "cluster.postgresql.cnpg.io/$DRILL_NAME" --timeout=30m \
  || fail "drill cluster did not become ready in 30m"
RESTORE_RTO=$((SECONDS - RESTORE_START))
ok "restored in ${RESTORE_RTO}s"

# ── 3. Assertions ────────────────────────────────────────────────────────────
FOUND=$(psql_drill "SELECT count(*) FROM pitr_drill_markers WHERE marker='$MARKER';" | tr -d '[:space:]')
[ "$FOUND" = "1" ] || fail "marker row missing after PITR — restore is NOT trustworthy"
ok "marker row present in restored cluster"

AFTER=$(psql_drill "SELECT count(*) FROM pitr_drill_markers WHERE marker='${MARKER}-after-t0';" | tr -d '[:space:]')
[ "$AFTER" = "0" ] || fail "post-T0 row present — recovery target was not honored"
ok "post-T0 write correctly absent (recovery stopped at T0)"

echo ""
echo "[pitr-drill] ════════════════════════════════════════"
echo "[pitr-drill]  PITR DRILL PASSED"
echo "[pitr-drill]  target time : $T0"
echo "[pitr-drill]  restore RTO : ${RESTORE_RTO}s"
echo "[pitr-drill]  record these numbers in docs/PRODUCTION_CHECKLIST.md"
echo "[pitr-drill] ════════════════════════════════════════"
