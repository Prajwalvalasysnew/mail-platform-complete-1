#!/usr/bin/env bash
# Backup / restore drill for mail-platform.
#
# Dumps the live database, restores it into a temporary scratch database, runs
# migrations on the scratch copy to verify idempotency, checks the table count,
# then drops the scratch database and removes the dump file.
#
# Usage:
#   ./scripts/backup-restore-drill.sh
#
# Environment variables (all optional — defaults match the dev docker-compose):
#   PG_CONTAINER   docker container name    (default: mail-postgres)
#   PG_USER        postgres user            (default: mail)
#   PG_DB          source database name     (default: mail_platform)
#   SCRATCH_DB     restore-target db name  (default: mail_platform_restore_drill)
#   DUMP_FILE      path for the dump file   (default: /tmp/mail_platform_drill.dump)

set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-mail-postgres}"
PG_USER="${PG_USER:-mail}"
PG_DB="${PG_DB:-mail_platform}"
SCRATCH_DB="${SCRATCH_DB:-mail_platform_restore_drill}"
DUMP_FILE="${DUMP_FILE:-/tmp/mail_platform_drill.dump}"

info()  { echo "[drill] $*"; }
ok()    { echo "[drill] ✓ $*"; }
fail()  { echo "[drill] ✗ $*" >&2; exit 1; }

cleanup() {
  info "cleaning up scratch database and dump file"
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";" 2>/dev/null || true
  docker exec "$PG_CONTAINER" rm -f "$DUMP_FILE" 2>/dev/null || true
}
trap cleanup EXIT

# ── 1. Verify source DB is reachable ─────────────────────────────────────────
info "checking source database $PG_DB"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c "SELECT 1;" > /dev/null \
  || fail "cannot connect to source database"
ok "source database reachable"

# ── 2. Dump ───────────────────────────────────────────────────────────────────
info "dumping $PG_DB → $DUMP_FILE (inside container)"
docker exec "$PG_CONTAINER" \
  pg_dump -U "$PG_USER" -Fc -f "$DUMP_FILE" "$PG_DB"
ok "dump complete"

# ── 3. Create scratch DB ──────────────────────────────────────────────────────
info "creating scratch database $SCRATCH_DB"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";"
docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres \
  -c "CREATE DATABASE \"$SCRATCH_DB\" OWNER \"$PG_USER\";"
ok "scratch database created"

# ── 4. Restore (measure RTO) ─────────────────────────────────────────────────
info "restoring dump into $SCRATCH_DB"
RESTORE_START=$SECONDS
docker exec "$PG_CONTAINER" \
  pg_restore -U "$PG_USER" -d "$SCRATCH_DB" --no-owner --role="$PG_USER" "$DUMP_FILE"
RESTORE_RTO=$((SECONDS - RESTORE_START))
ok "restore complete — measured restore time (RTO proxy): ${RESTORE_RTO}s"

# ── 5. Verify table count ─────────────────────────────────────────────────────
info "verifying restored schema"
SRC_TABLES=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';")
DST_TABLES=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$SCRATCH_DB" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';")

SRC_TABLES=$(echo "$SRC_TABLES" | tr -d '[:space:]')
DST_TABLES=$(echo "$DST_TABLES" | tr -d '[:space:]')

if [ "$SRC_TABLES" != "$DST_TABLES" ]; then
  fail "table count mismatch: source=$SRC_TABLES restored=$DST_TABLES"
fi
ok "table count matches ($SRC_TABLES tables)"

# ── 6. Verify migration history is intact ────────────────────────────────────
SRC_MIGS=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
  "SELECT count(*) FROM schema_migrations;")
DST_MIGS=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$SCRATCH_DB" -tAc \
  "SELECT count(*) FROM schema_migrations;")

SRC_MIGS=$(echo "$SRC_MIGS" | tr -d '[:space:]')
DST_MIGS=$(echo "$DST_MIGS" | tr -d '[:space:]')

if [ "$SRC_MIGS" != "$DST_MIGS" ]; then
  fail "migration history mismatch: source=$SRC_MIGS restored=$DST_MIGS"
fi
ok "migration history intact ($SRC_MIGS migrations)"

# ── 7. Spot-check a data row ──────────────────────────────────────────────────
info "spot-checking row counts"
for TABLE in customers api_keys sending_domains messages events suppressions; do
  SRC_COUNT=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
    "SELECT count(*) FROM $TABLE;" | tr -d '[:space:]')
  DST_COUNT=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$SCRATCH_DB" -tAc \
    "SELECT count(*) FROM $TABLE;" | tr -d '[:space:]')
  if [ "$SRC_COUNT" != "$DST_COUNT" ]; then
    fail "row count mismatch in $TABLE: source=$SRC_COUNT restored=$DST_COUNT"
  fi
  ok "$TABLE: $SRC_COUNT rows"
done

# ── 8. Verify erasures survived the restore (BASE-12) ────────────────────────
# The steps above prove data comes BACK. This proves erased data STAYS GONE,
# which the compliance plan requires of a resilience exercise ("restored
# erasures and suppressions remain enforced"). A restore from an image taken
# BEFORE an erasure resurrects the erased rows; these are the invariants that
# detect it.
info "verifying privacy invariants on the restored copy"

# 8a. No tombstoned message may exist again. In production, erasure deletes the
# message and writes the tombstone in one transaction, so a tombstoned message
# that still exists means the restore brought erased data back and tombstone
# replay has not been run.
#
# On a DEVELOPMENT database this can trip on test fixtures:
# privacy-worker-tombstone.e2e.test.ts deliberately seeds a tombstone next to a
# surviving message to exercise the stale-job worker gate. Run the drill against
# production or a production-shaped copy.
RESURRECTED=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$SCRATCH_DB" -tAc \
  "SELECT count(*) FROM privacy_message_tombstones t
     JOIN messages m ON m.message_id = t.message_id AND m.customer_id = t.customer_id;" \
  | tr -d '[:space:]')
if [ "$RESURRECTED" != "0" ]; then
  fail "restore resurrected $RESURRECTED erased message(s). Run tombstone replay before serving traffic:
       POST /admin/privacy/replay-tombstones  (see docs/runbooks/RESTORE_RE_DELETION.md)"
fi
ok "no erased messages resurrected"

# 8b. A consent row marked pseudonymized must still hold a pseudonym. A
# plaintext address here means the scrub was rolled back by the restore.
UNSCRUBBED=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$SCRATCH_DB" -tAc \
  "SELECT count(*) FROM consent_events
    WHERE pseudonymized_at IS NOT NULL AND email NOT LIKE 'erased:%';" \
  | tr -d '[:space:]')
if [ "$UNSCRUBBED" != "0" ]; then
  fail "restore rolled back pseudonymization on $UNSCRUBBED consent row(s). Run tombstone replay
       (see docs/runbooks/RESTORE_RE_DELETION.md)"
fi
ok "erased identifiers still pseudonymized"

# 8c. Suppressions must survive. An opt-out lost to a restore means a recipient
# who unsubscribed starts receiving mail again — report the count so the
# operator can compare it against the pre-restore figure.
SUPPRESSIONS=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$SCRATCH_DB" -tAc \
  "SELECT count(*) FROM suppressions;" | tr -d '[:space:]')
TOMBSTONES=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$SCRATCH_DB" -tAc \
  "SELECT count(*) FROM privacy_message_tombstones;" | tr -d '[:space:]')
ok "suppressions preserved: $SUPPRESSIONS (compare against the pre-restore count)"
ok "erasure tombstones carried over: $TOMBSTONES"

echo ""
echo "[drill] ════════════════════════════════════════════"
echo "[drill]  BACKUP / RESTORE DRILL PASSED"
echo "[drill]  source DB : $PG_DB"
echo "[drill]  tables    : $SRC_TABLES"
echo "[drill]  migrations: $SRC_MIGS"
echo "[drill]  restore RTO: ${RESTORE_RTO}s (local dump→restore; measure against"
echo "[drill]              production-sized data + real object storage for the SLA)"
echo "[drill]  suppressions: $SUPPRESSIONS   tombstones: $TOMBSTONES"
echo "[drill] ────────────────────────────────────────────"
echo "[drill]  NOTE: this drill restores a dump of the CURRENT database, so it"
echo "[drill]  cannot resurrect anything by itself. A real restore from an"
echo "[drill]  OLDER image can, and tombstone replay is mandatory before the"
echo "[drill]  restored node serves traffic:"
echo "[drill]    POST /admin/privacy/replay-tombstones"
echo "[drill]    docs/runbooks/RESTORE_RE_DELETION.md"
echo "[drill] ════════════════════════════════════════════"
