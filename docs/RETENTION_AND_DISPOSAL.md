# Retention and disposal policy

**Control:** BASE-06 (compliance implementation plan)
**Reviewed:** 2026-07-25
**Review frequency:** annually, and whenever a store or record type is added.

Every store and record type needs an approved minimum and maximum retention, a
legal-hold override, an enforcing deletion job, monitoring, a defined backup
treatment, and a restore-time re-deletion procedure. This document is that
schedule.

The **values below are engineering defaults, not an approved policy.** Legal
and the privacy owner must approve the final windows for the deployment;
contractual commitments to customers override these defaults in either
direction.

## 1. Schedule

All windows are enforced by `runRetention()`
(`packages/shared/src/retention.ts`), run on the worker scheduler. Every
destructive step skips data under an active legal hold and reports it as
`held_rows_skipped`.

| Record type | Store | Default window | Env var | Hold-gated | Disposal |
| --- | --- | --- | --- | --- | --- |
| Inline message bodies | PostgreSQL | 90 days | `RETENTION_BODY_DAYS` | Yes | Columns nulled on terminal messages |
| Offloaded bodies and attachments | Object store | Follows body window | — | Yes | Object deleted once no message references it |
| Message metadata | PostgreSQL | 395 days | `RETENTION_MESSAGE_DAYS` | Yes | Row deleted |
| Delivery events | PostgreSQL | 90 days | `RETENTION_EVENT_DAYS` | Yes | Row deleted |
| Analytics event copy | ClickHouse | Must match `RETENTION_EVENT_DAYS` | — (TTL) | No | **Set the ClickHouse TTL to match — it is not driven by the sweep** |
| Tracked links | PostgreSQL | Follows body window | — | Yes | Row deleted |
| Processed send-outbox rows | PostgreSQL | 30 days | `RETENTION_OUTBOX_DAYS` | Yes | Row deleted; `pending` never purged |
| Webhook delivery log | PostgreSQL | 30 days | `RETENTION_WEBHOOK_LOG_DAYS` | No | Row deleted (operational telemetry) |
| Blocklist checks | PostgreSQL | 180 days | `RETENTION_BLOCKLIST_DAYS` | No | Row deleted (no tenant content) |
| DMARC reports and records | PostgreSQL | 365 days | `RETENTION_DMARC_DAYS` | Tenant holds only | Children then parents, batched |
| Review queue (resolved/rejected) | PostgreSQL | 30 days | `RETENTION_REVIEW_QUEUE_DAYS` | No | Row deleted |
| Export artifacts | PostgreSQL + object store | 7 days | `RETENTION_EXPORT_DAYS` | No | Row and object deleted; link stops resolving |
| Billing webhook payloads | PostgreSQL | 90 days | `RETENTION_BILLING_PAYLOAD_DAYS` | No | Payload column nulled; **row kept as the idempotency marker** |
| Audit log | PostgreSQL | 365 days hot | `RETENTION_AUDIT_DAYS` | Not gated | **Archived, never destroyed** — moved to `audit_log_archive` with hash-chain fields |
| Suppressions and consent ledger | PostgreSQL | Indefinite | — | — | Never time-expired: an opt-out must outlive the message that caused it. Identifiers pseudonymized on erasure (BASE-03) |
| Privacy tombstones | PostgreSQL | Indefinite | — | — | Never purged: they are what makes restore-time re-deletion possible |
| Deletion requests and object items | PostgreSQL | Indefinite | — | — | Erasure evidence; recipient stored as keyed pseudonym |

### Records that must not expire

Four categories are deliberately exempt from time-based deletion, and a future
change proposing to expire them should be treated as a compliance regression:

- **Suppressions and consent events** — expiring an opt-out would let the
  recipient be mailed again, which is the CAN-SPAM violation the ledger exists
  to prevent.
- **Privacy message tombstones** — without them a restore silently resurrects
  erased data.
- **Deletion requests** — the evidence that an erasure happened.
- **Audit log** — archived rather than deleted, preserving the hash chain.

## 2. Plan and tenant overrides

Per-plan and per-tenant windows (`retention-policy.ts`, migration 065) can
only **tighten** the environment defaults, never extend them. Selling a longer
window means raising the environment ceiling *and* the ClickHouse TTL
together; otherwise the promise is unenforceable and the analytics copy
expires before the promised window ends.

## 3. Open-request interlock (FERPA-07)

An **open access request pins the data it covers**. While a privacy case for a
recipient is in a non-terminal status and carries an `access`, `portability`,
or `rectification` request type, the retention sweep will not purge that
recipient's data. Pinned rows are reported as `request_pinned_rows_skipped`,
separately from legal holds, because the two are released by different events:
a hold by the matter closing, a pin by the request being fulfilled.

Without this, the sweep can delete the very records a data subject asked for
while their request is in flight — leaving the controller answering a
statutory request with data it destroyed *after* receiving the request.

**An open erasure request does NOT pin.** Deletion is the outcome the subject
asked for, so letting the sweep get there first fulfils the request rather
than frustrating it — and pinning on erasure would be self-defeating, since
the case could never complete through the ordinary lifecycle.

The pin is scoped to the request's subject within its own tenant: it is not a
tenant-wide freeze, because over-preserving would quietly defeat the retention
policy for every other recipient.

## 4. Legal holds

An active hold (`scope = 'customer'` for a whole tenant, `recipient:<email>`
for one recipient) blocks both retention sweeps and direct erasure. Held rows
are counted, skipped, and collected by a later sweep once the hold is
released. Steps that archive rather than destroy, and tables with no tenant
content, are not hold-gated. See `docs/LEGAL_HOLD.md`.

## 5. Backups

Backups are **not** selectively rewritten. No online deletion can reach into a
backup image, so erased data persists in any backup taken before the erasure,
until that image expires.

Required, and **not implemented in this repository**:

- an approved backup retention period, so erased data has a bounded lifetime;
- encryption and key management for backup images (BASE-07), so key
  destruction is available as a disposal mechanism;
- the restore-time re-deletion procedure — this one **is** implemented; see
  `docs/runbooks/RESTORE_RE_DELETION.md` and
  `POST /admin/privacy/replay-tombstones`.

A restored node must not serve traffic until tombstone replay has run.

## 6. Monitoring

The sweep returns per-step counts. Alert on:

- the retention job not completing on schedule (silent non-deletion is the
  failure that matters — nothing looks broken while data accumulates);
- `held_rows_skipped` growing steadily, which usually means a hold was never
  released;
- `request_pinned_rows_skipped` growing steadily, which means privacy cases are
  being opened and never closed — the data stays pinned and the statutory
  deadline is probably being missed too;
- `deletion_object_items` in `failed` with exhausted attempts, which means
  erasure is incomplete for a data subject;
- ClickHouse TTL drift against `RETENTION_EVENT_DAYS`.

Manual run: `POST /admin/retention/run` (operator role).

## 7. Open items

- Approved windows signed off by Legal and the privacy owner.
- Backup retention, encryption, and key-destruction procedure (BASE-07).
- Documented disposal for logs, metrics, and tracing backends.
- Subprocessor data-return and destruction terms (BASE-13).

## Related

- `docs/DATA_INVENTORY.md` — BASE-01 inventory this schedule covers
- `docs/LEGAL_HOLD.md` — hold semantics
- `docs/runbooks/RESTORE_RE_DELETION.md` — post-restore obligations
- `docs/COMPLIANCE_IMPLEMENTATION_PLAN.md` — BASE-06
