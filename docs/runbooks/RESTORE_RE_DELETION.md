# Runbook: re-deletion after a restore

**Control:** BASE-06 (retention and disposal), mandatory privacy regression
test 6 in the compliance implementation plan.
**Applies when:** any PostgreSQL restore, PITR rewind, replica rebuild from a
snapshot, or object-store rollback.

## Why this exists

Erasure removes data from the online stores. It does **not** rewrite backup
images — no online delete can. So a restore from a backup taken *before* an
erasure brings the erased rows back, and the platform silently resurrects data
a data subject already had removed.

This is the step that closes that gap. It is not optional and it is not
best-effort: **a restored node must not serve traffic until this has run and
been recorded.**

## What the platform tracks

`privacy_message_tombstones` is the durable record of which messages were
erased. It deliberately stores **no recipient address** — retaining the
identifier would defeat the erasure it documents. Replay therefore recovers
the address from the restored message rows themselves, verifies it against the
keyed pseudonym already recorded on the deletion request, uses it to re-run the
identifier scrub, and destroys those rows again.

A restored row whose address does **not** hash to the recorded pseudonym is
**not** purged. It is counted as `mismatched_skipped` and left for an operator,
because acting on it would mean scrubbing records for a recipient the erasure
request never covered.

## Procedure

1. **Bring the restored database up with application traffic still disabled.**
   Do not let the API, workers, or SMTP gateway reach it yet.

2. **Apply migrations**, so the tombstone table and its indexes exist at the
   restored point in time:

   ```bash
   node packages/shared/dist/bin/migrate.js infra/migrations
   ```

3. **Replay the tombstones.** Whole cluster:

   ```bash
   curl -sS -X POST https://<api-host>/admin/privacy/replay-tombstones \
     -H "authorization: Bearer <admin-token>" \
     -H 'content-type: application/json' -d '{}'
   ```

   Single tenant (the common case when restoring one customer's data):

   ```bash
   curl -sS -X POST https://<api-host>/admin/privacy/replay-tombstones \
     -H "authorization: Bearer <admin-token>" \
     -H 'content-type: application/json' \
     -d '{"customer_id":"<uuid>"}'
   ```

   The default batch is 1000 resurrected messages; pass `limit` (max 10000)
   and repeat until `resurrected_messages` comes back `0`.

4. **Read the result.**

   | Field | Meaning |
   | --- | --- |
   | `resurrected_messages` | Tombstoned messages found alive again — the size of the restore's privacy exposure |
   | `messages_purged` / `events_purged` / `tracked_links_purged` / `send_outbox_purged` | Rows re-deleted |
   | `recipients_repseudonymized` | Distinct recipients whose surviving identifier rows were scrubbed again |
   | `object_items_requeued` | Body-object, analytics, and queue deletions handed back to the retry worker |
   | `mismatched_skipped` | **Investigate before serving traffic** (see below) |

5. **Let the erasure retry worker drain.** Replay re-queues out-of-database
   deletions rather than performing them inline, so restored body objects,
   ClickHouse rows, and queued jobs are removed through the same audited path
   as the original erasure. Confirm:

   ```sql
   SELECT status, COUNT(*) FROM deletion_object_items GROUP BY status;
   ```

   Do not enable traffic while items are still `pending` for a restored
   request unless the security owner accepts the exposure in writing.

6. **Re-verify suppressions.** A restore can also roll back opt-outs recorded
   after the backup was taken. Confirm the suppression count for affected
   tenants matches the pre-restore figure; a recipient who unsubscribed after
   the backup must not start receiving mail again.

7. **Record it.** Evidence register entry: restore time, backup image, scope,
   the full replay result, retry-worker drain confirmation, and sign-off. No
   recipient addresses in the record.

## Handling `mismatched_skipped > 0`

This means a restored message row is tombstoned, but its `to_address` does not
hash to the pseudonym on its deletion request. Causes, in order of likelihood:

- **The pseudonym secret changed** between the erasure and the restore. Every
  row will mismatch. Resolve the key question first — replay cannot verify
  anything without the original secret.
- **The restore mixed images** from different points in time, or from a
  different environment.
- **Data corruption** in the restored set.

Do not force the purge. Escalate to the privacy owner and the security owner;
this is a data-integrity question, not an on-call decision.

## Related

- `docs/HA_DR.md` — restore and failover procedures
- `docs/OPERATIONAL_DRILLS.md` — the drill schedule this belongs in
- `docs/LEGAL_HOLD.md` — holds interact with erasure and must be re-checked
  after a restore
- `docs/COMPLIANCE_IMPLEMENTATION_PLAN.md` — BASE-06, regression test 6
