// Retention / cleanup jobs.
//
// Purges old data to keep the hot tables lean:
//   - inline message bodies older than RETENTION_BODY_DAYS (default 90)
//   - offloaded body objects where every referencing message is past retention
//   - events rows older than RETENTION_EVENT_DAYS (default 90)
//   - message metadata rows older than RETENTION_MESSAGE_DAYS (default 395)
//   - tracked_links older than the body retention window
//   - webhook_delivery_log rows older than RETENTION_WEBHOOK_LOG_DAYS (default 30)
//   - blocklist_checks older than RETENTION_BLOCKLIST_DAYS (default 180)
//   - DMARC aggregate reports/records older than RETENTION_DMARC_DAYS (default 365)
//   - audit_log rows older than RETENTION_AUDIT_DAYS (default 365) — archived
//     to audit_log_archive, never destroyed, so legal holds do not gate this
//   - resolved/rejected review_queue rows older than RETENTION_REVIEW_QUEUE_DAYS (default 30)
//   - stored billing webhook payloads older than RETENTION_BILLING_PAYLOAD_DAYS
//     (default 90) — the payload column only; the billing_events row is the
//     idempotency marker and is kept (PCI-03)
//
// LEGAL HOLDS. Every destructive step skips data covered by an active legal
// hold (scope 'customer' = whole tenant, 'recipient:<email>' = one recipient),
// mirroring the assertNoActiveHold gate on the erasure endpoint. Held rows are
// counted in `held_rows_skipped` and are picked up by a later sweep once the
// hold is released. Steps that archive rather than destroy (audit log) and
// tables with no tenant content (blocklist_checks) are not hold-gated.
//
// BATCHING. Cutoff deletes/updates run in bounded batches (default 10k rows,
// RETENTION_BATCH_SIZE) so a sweep over a large backlog never holds a
// long-running transaction, spikes WAL, or blocks vacuum. Each batch is its
// own implicit transaction; the loop continues until a batch comes back short.
//
// All cutoffs default from env vars and can be overridden per call — useful
// for admin-triggered manual runs and for E2E tests (pass 0 to target recent
// rows).

import { sql } from 'kysely';
import { db } from './db.js';
import { getBodyStore } from './storage.js';
import { tenantRetentionWindowsSql } from './retention-policy.js';
import { purgeExpiredExports } from './data-exports.js';
import { dmarcRetentionPurged } from './metrics.js';

export interface RetentionOptions {
  /** Days to keep message bodies. Default: RETENTION_BODY_DAYS env or 90. */
  messageBodyRetentionDays?: number;
  /** Days to keep event rows. Default: RETENTION_EVENT_DAYS env or 90. */
  eventRetentionDays?: number;
  /** Days to keep message metadata rows. Default: RETENTION_MESSAGE_DAYS env or 395. */
  messageRetentionDays?: number;
  /** Days to keep audit_log rows. Default: RETENTION_AUDIT_DAYS env or 365. */
  auditRetentionDays?: number;
  /** Days to keep resolved/rejected review_queue rows. Default: RETENTION_REVIEW_QUEUE_DAYS env or 30. */
  reviewQueueRetentionDays?: number;
  /** Days to keep webhook_delivery_log rows. Default: RETENTION_WEBHOOK_LOG_DAYS env or 30. */
  webhookLogRetentionDays?: number;
  /** Days to keep blocklist_checks rows. Default: RETENTION_BLOCKLIST_DAYS env or 180. */
  blocklistRetentionDays?: number;
  /** Days to keep processed send_outbox rows. Default: RETENTION_OUTBOX_DAYS env or 30. */
  outboxRetentionDays?: number;
  /** Days to keep export artifacts. Default: RETENTION_EXPORT_DAYS env or 7. */
  exportRetentionDays?: number;
  /** Days to keep DMARC reports and source records. Default: RETENTION_DMARC_DAYS env or 365. */
  dmarcRetentionDays?: number;
  /**
   * Days to keep the stored billing webhook payload (PCI-03). The
   * billing_events ROW is never purged — it is the idempotency marker — only
   * the payload column is nulled. Default: RETENTION_BILLING_PAYLOAD_DAYS env
   * or 90.
   */
  billingPayloadRetentionDays?: number;
  /** Max rows per delete/update batch. Default: RETENTION_BATCH_SIZE env or 10_000. */
  batchSize?: number;
}

export interface RetentionResult {
  messages_body_purged: number;
  messages_purged: number;
  events_purged: number;
  event_keys_purged: number;
  tracked_links_purged: number;
  webhook_log_purged: number;
  blocklist_checks_purged: number;
  send_outbox_purged: number;
  exports_purged: number;
  dmarc_reports_purged: number;
  dmarc_records_purged: number;
  /** billing_events rows whose stored provider payload was nulled (PCI-03). */
  billing_payloads_purged: number;
  audit_purged: number;
  review_queue_purged: number;
  /** Rows matching a retention cutoff but preserved by an active legal hold. */
  held_rows_skipped: number;
  /**
   * Rows matching a retention cutoff but pinned by an OPEN access request
   * (FERPA-07). Distinct from held_rows_skipped because the two are released
   * by different events: a hold by a matter closing, a pin by the request
   * being fulfilled.
   */
  request_pinned_rows_skipped: number;
  /**
   * Rows matching a retention cutoff but locked by a regulatory retention
   * obligation (SEC-04). Released by the statutory period lapsing, not by any
   * operator action.
   */
  regulatory_locked_rows_skipped: number;
}

const TERMINAL_STATUSES = ['delivered', 'hard_bounced', 'failed', 'suppressed'] as const;

// SQL predicates over the in-scope `messages` row: an active legal hold
// covers it when the hold is tenant-wide ('customer') or names the row's
// recipient ('recipient:<email>', lower-cased). Matches recipientHoldScope()
// in legal-hold.ts and the assertNoActiveHold erasure gate.
const holdOnMessage = sql<boolean>`EXISTS (
  SELECT 1 FROM legal_holds h
  WHERE h.released_at IS NULL
    AND h.customer_id = messages.customer_id
    AND (h.scope = 'customer' OR h.scope = 'recipient:' || lower(messages.to_address))
)`;
// FERPA-07 (and the same problem under GDPR Art 15 / CCPA access): an OPEN
// access request pins the data it covers.
//
// Without this, the retention sweep can delete the very records a data subject
// asked for while their request is still in flight — and the controller then
// has to answer a statutory request with data it destroyed AFTER receiving the
// request. FERPA states it plainly (no destruction while an eligible access
// request is outstanding); the same reasoning applies to any access or
// portability request anywhere.
//
// ONLY read-type requests pin. An open ERASURE request must NOT block
// retention: deletion is the outcome the subject asked for, so letting the
// sweep get there first fulfils the request rather than frustrating it.
// Pinning on erasure would also be self-defeating — the case could never be
// completed by the ordinary lifecycle.
//
// Closed cases (fulfilled/denied/closed) release the pin, and a case whose
// subject has been pseudonymized after fulfilment can no longer match a
// plaintext address anyway.
const PINNING_REQUEST_TYPES = ['access', 'portability', 'rectification'] as const;
const openRequestOnMessage = sql<boolean>`EXISTS (
  SELECT 1 FROM privacy_cases c
  WHERE c.customer_id = messages.customer_id
    AND c.subject_kind = 'recipient'
    AND c.status NOT IN ('fulfilled', 'denied', 'closed')
    AND c.subject_pseudonymized_at IS NULL
    AND lower(c.subject_identifier) = lower(messages.to_address)
    AND c.request_types && ARRAY[${sql.join([...PINNING_REQUEST_TYPES])}]::text[]
)`;

// SEC-04: a regulatory retention obligation preserves the record until its
// statutory period lapses. Unlike a hold this is TIME-BOUND — past
// retain_until the ordinary policy resumes with no manual step, so an expired
// obligation cannot quietly become permanent retention.
const regulatoryLockOnMessage = sql<boolean>`EXISTS (
  SELECT 1 FROM regulatory_retention_locks r
  WHERE r.customer_id = messages.customer_id
    AND r.released_at IS NULL
    AND r.retain_until > now()
    AND (r.scope = 'customer' OR r.scope = 'recipient:' || lower(messages.to_address))
)`;

// A message is preserved when a legal hold covers it, an open access request
// pins it, or a regulatory obligation locks it. Every step that was hold-gated
// is gated by all three — the reasons differ but the requirement is identical:
// the data must survive.
const preservedMessage = sql<boolean>`(${holdOnMessage} OR ${openRequestOnMessage} OR ${regulatoryLockOnMessage})`;
const noHoldOnMessage = sql<boolean>`NOT ${preservedMessage}`;

/**
 * Run a batched mutation until it returns fewer rows than the batch size.
 * Returns the total affected-row count. `runBatch` must respect `limit`.
 */
async function drainBatches(
  batchSize: number,
  runBatch: (limit: number) => Promise<number>,
): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await runBatch(batchSize);
    total += n;
    if (n < batchSize) return total;
  }
}

/**
 * Run the sweep and persist a record that it ran (SOC2-06).
 *
 * The failure mode for retention is SILENCE: a sweep that stops running looks
 * exactly like a sweep with nothing to do, while data accumulates past its
 * window. Recording every run — including failures — is what makes the absence
 * detectable. Prefer this over calling runRetention() directly from a
 * scheduler or an operator endpoint.
 */
export async function runRetentionWithEvidence(opts: RetentionOptions = {}): Promise<RetentionResult> {
  const startedAt = new Date();
  try {
    const result = await runRetention(opts);
    await db.insertInto('retention_runs').values({
      started_at: startedAt,
      duration_ms: Date.now() - startedAt.getTime(),
      result: JSON.stringify(result) as never,
    } as never).execute().catch(() => {
      // Evidence recording must never turn a successful sweep into a failure.
    });
    return result;
  } catch (err) {
    await db.insertInto('retention_runs').values({
      started_at: startedAt,
      duration_ms: Date.now() - startedAt.getTime(),
      result: JSON.stringify({}) as never,
      error: err instanceof Error ? err.message.slice(0, 2000) : 'unknown_retention_error',
    } as never).execute().catch(() => {});
    throw err;
  }
}

export async function runRetention(opts: RetentionOptions = {}): Promise<RetentionResult> {
  const {
    messageBodyRetentionDays = Number(process.env.RETENTION_BODY_DAYS ?? 90),
    eventRetentionDays = Number(process.env.RETENTION_EVENT_DAYS ?? 90),
    messageRetentionDays = Number(process.env.RETENTION_MESSAGE_DAYS ?? 395),
    auditRetentionDays = Number(process.env.RETENTION_AUDIT_DAYS ?? 365),
    reviewQueueRetentionDays = Number(process.env.RETENTION_REVIEW_QUEUE_DAYS ?? 30),
    webhookLogRetentionDays = Number(process.env.RETENTION_WEBHOOK_LOG_DAYS ?? 30),
    blocklistRetentionDays = Number(process.env.RETENTION_BLOCKLIST_DAYS ?? 180),
    outboxRetentionDays = Number(process.env.RETENTION_OUTBOX_DAYS ?? 30),
    exportRetentionDays = Number(process.env.RETENTION_EXPORT_DAYS ?? 7),
    dmarcRetentionDays = Number(process.env.RETENTION_DMARC_DAYS ?? 365),
    billingPayloadRetentionDays = Number(process.env.RETENTION_BILLING_PAYLOAD_DAYS ?? 90),
    batchSize = Number(process.env.RETENTION_BATCH_SIZE ?? 10_000),
  } = opts;

  const bodyCutoff = new Date(Date.now() - messageBodyRetentionDays * 86_400_000);
  const eventCutoff = new Date(Date.now() - eventRetentionDays * 86_400_000);
  // Per-tenant windows (Phase 2.1): customer override → plan value → the
  // defaults above. Events windows only tighten (physical partition ceiling);
  // body windows may extend up to the message-row lifetime. The fixed cutoffs
  // above remain for tables without tenant windows (tracked_links keys off
  // the platform body window; message ROWS always drop at the platform
  // message window).
  const windows = tenantRetentionWindowsSql({
    eventsDays: eventRetentionDays,
    bodyDays: messageBodyRetentionDays,
    messageDays: messageRetentionDays,
  });
  const messageCutoff = new Date(Date.now() - messageRetentionDays * 86_400_000);
  const auditCutoff = new Date(Date.now() - auditRetentionDays * 86_400_000);
  const reviewCutoff = new Date(Date.now() - reviewQueueRetentionDays * 86_400_000);
  const webhookLogCutoff = new Date(Date.now() - webhookLogRetentionDays * 86_400_000);
  const blocklistCutoff = new Date(Date.now() - blocklistRetentionDays * 86_400_000);
  const outboxCutoff = new Date(Date.now() - outboxRetentionDays * 86_400_000);
  const dmarcCutoff = new Date(Date.now() - dmarcRetentionDays * 86_400_000);
  const billingPayloadCutoff = new Date(Date.now() - billingPayloadRetentionDays * 86_400_000);

  let heldSkipped = 0;
  let requestPinnedSkipped = 0;
  let regulatoryLockedSkipped = 0;

  // --- 1. Purge inline bodies (batched, hold-aware) ----------------------
  const messagesBodyPurgedInline = await drainBatches(batchSize, async (limit) => {
    const res = await sql<{ count: string }>`
      WITH windows AS (${windows}), batch AS (
        SELECT messages.id FROM messages
        LEFT JOIN windows w ON w.customer_id = messages.customer_id
        WHERE body_storage = 'inline'
          AND status IN (${sql.join([...TERMINAL_STATUSES])})
          AND queued_at < now() - make_interval(days => COALESCE(w.body_days, ${messageBodyRetentionDays})::int)
          AND (html_body IS NOT NULL OR text_body IS NOT NULL)
          AND ${noHoldOnMessage}
        ORDER BY queued_at
        LIMIT ${limit}
      ), updated AS (
        UPDATE messages m SET html_body = NULL, text_body = NULL
        FROM batch WHERE m.id = batch.id
        RETURNING m.id
      )
      SELECT COUNT(*)::text AS count FROM updated
    `.execute(db);
    return Number(res.rows[0]?.count ?? 0);
  });
  let messagesBodyPurged = messagesBodyPurgedInline;

  // Count inline bodies preserved by a legal hold (visibility). Counted
  // separately from the access-request interlock below so an operator can tell
  // "a matter is preserving this" from "a request is preserving this" — they
  // are released by completely different events.
  const heldInline = await sql<{ count: string }>`
    WITH windows AS (${windows})
    SELECT COUNT(*)::text AS count FROM messages
    LEFT JOIN windows w ON w.customer_id = messages.customer_id
    WHERE body_storage = 'inline'
      AND status IN (${sql.join([...TERMINAL_STATUSES])})
      AND queued_at < now() - make_interval(days => COALESCE(w.body_days, ${messageBodyRetentionDays})::int)
      AND (html_body IS NOT NULL OR text_body IS NOT NULL)
      AND ${holdOnMessage}
  `.execute(db);
  heldSkipped += Number(heldInline.rows[0]?.count ?? 0);

  // FERPA-07: inline bodies pinned by an OPEN access request.
  const pinnedInline = await sql<{ count: string }>`
    WITH windows AS (${windows})
    SELECT COUNT(*)::text AS count FROM messages
    LEFT JOIN windows w ON w.customer_id = messages.customer_id
    WHERE body_storage = 'inline'
      AND status IN (${sql.join([...TERMINAL_STATUSES])})
      AND queued_at < now() - make_interval(days => COALESCE(w.body_days, ${messageBodyRetentionDays})::int)
      AND (html_body IS NOT NULL OR text_body IS NOT NULL)
      AND ${openRequestOnMessage}
  `.execute(db);
  requestPinnedSkipped += Number(pinnedInline.rows[0]?.count ?? 0);

  // SEC-04: inline bodies locked by a regulatory retention obligation.
  const lockedInline = await sql<{ count: string }>`
    WITH windows AS (${windows})
    SELECT COUNT(*)::text AS count FROM messages
    LEFT JOIN windows w ON w.customer_id = messages.customer_id
    WHERE body_storage = 'inline'
      AND status IN (${sql.join([...TERMINAL_STATUSES])})
      AND queued_at < now() - make_interval(days => COALESCE(w.body_days, ${messageBodyRetentionDays})::int)
      AND (html_body IS NOT NULL OR text_body IS NOT NULL)
      AND ${regulatoryLockOnMessage}
  `.execute(db);
  regulatoryLockedSkipped += Number(lockedInline.rows[0]?.count ?? 0);

  // --- 2. Purge offloaded bodies (preservation-aware) --------------------
  // Only delete an object when EVERY message referencing that key is past
  // retention AND none of them is under a legal hold or an open access
  // request. First collect keys still live (referenced by a non-expired,
  // non-terminal, or preserved message), then delete the rest.
  const liveKeyRows = await sql<{ body_object_key: string }>`
    WITH windows AS (${windows})
    SELECT body_object_key FROM messages
    LEFT JOIN windows w ON w.customer_id = messages.customer_id
    WHERE body_storage != 'inline'
      AND body_object_key IS NOT NULL
      AND (
        status NOT IN (${sql.join([...TERMINAL_STATUSES])})
        OR queued_at >= now() - make_interval(days => COALESCE(w.body_days, ${messageBodyRetentionDays})::int)
        OR ${preservedMessage}
      )
    GROUP BY body_object_key
  `.execute(db);
  const liveKeys = new Set(liveKeyRows.rows.map((r) => r.body_object_key).filter(Boolean));

  const expiredObjectRows = (await sql<{ body_object_key: string }>`
    WITH windows AS (${windows})
    SELECT body_object_key FROM messages
    LEFT JOIN windows w ON w.customer_id = messages.customer_id
    WHERE body_storage != 'inline'
      AND body_object_key IS NOT NULL
      AND status IN (${sql.join([...TERMINAL_STATUSES])})
      AND queued_at < now() - make_interval(days => COALESCE(w.body_days, ${messageBodyRetentionDays})::int)
    GROUP BY body_object_key
  `.execute(db)).rows;

  const store = getBodyStore();
  for (const row of expiredObjectRows) {
    const key = row.body_object_key;
    if (!key) continue;
    if (liveKeys.has(key)) {
      continue;
    }
    await store.delete(key);
    const cleared = await db
      .updateTable('messages')
      .set({ body_object_key: null })
      .where('body_object_key', '=', key)
      .executeTakeFirst();
    messagesBodyPurged += Number(cleared?.numUpdatedRows ?? 0);
  }

  // --- 3. Purge old tracked links (batched, hold-aware via message) ------
  // Tracked links carry message content (original URLs); a hold on the
  // message's recipient/tenant preserves them. Links whose message row is
  // already gone have no hold context and purge on age alone.
  const trackedLinksPurged = await drainBatches(batchSize, async (limit) => {
    const res = await sql<{ count: string }>`
      WITH batch AS (
        SELECT tl.id FROM tracked_links tl
        LEFT JOIN messages ON messages.message_id = tl.message_id
        WHERE tl.created_at < ${bodyCutoff}
          AND (messages.id IS NULL OR ${noHoldOnMessage})
        ORDER BY tl.created_at
        LIMIT ${limit}
      ), deleted AS (
        DELETE FROM tracked_links t USING batch WHERE t.id = batch.id
        RETURNING t.id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `.execute(db);
    return Number(res.rows[0]?.count ?? 0);
  });

  // --- 4. Purge old events (batched, hold-aware) -------------------------
  // Events join back to their message for recipient-scope holds; events whose
  // message is already purged are still protected by tenant-wide holds.
  const eventsPurged = await drainBatches(batchSize, async (limit) => {
    const res = await sql<{ count: string }>`
      WITH windows AS (${windows}), batch AS (
        SELECT e.id FROM events e
        LEFT JOIN messages ON messages.message_id = e.message_id
        LEFT JOIN windows w ON w.customer_id = e.customer_id
        WHERE e.occurred_at < now() - make_interval(days => LEAST(COALESCE(w.events_days, ${eventRetentionDays}), ${eventRetentionDays})::int)
          AND NOT EXISTS (
            SELECT 1 FROM legal_holds h
            WHERE h.released_at IS NULL
              AND h.customer_id = e.customer_id
              AND (h.scope = 'customer'
                   OR (messages.to_address IS NOT NULL
                       AND h.scope = 'recipient:' || lower(messages.to_address)))
          )
        ORDER BY e.id
        LIMIT ${limit}
      ), deleted AS (
        DELETE FROM events ev USING batch WHERE ev.id = batch.id
        RETURNING ev.id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `.execute(db);
    return Number(res.rows[0]?.count ?? 0);
  });

  const heldEvents = await sql<{ count: string }>`
    WITH windows AS (${windows})
    SELECT COUNT(*)::text AS count FROM events e
    LEFT JOIN messages ON messages.message_id = e.message_id
    LEFT JOIN windows w ON w.customer_id = e.customer_id
    WHERE e.occurred_at < now() - make_interval(days => LEAST(COALESCE(w.events_days, ${eventRetentionDays}), ${eventRetentionDays})::int)
      AND EXISTS (
        SELECT 1 FROM legal_holds h
        WHERE h.released_at IS NULL
          AND h.customer_id = e.customer_id
          AND (h.scope = 'customer'
               OR (messages.to_address IS NOT NULL
                   AND h.scope = 'recipient:' || lower(messages.to_address)))
      )
  `.execute(db);
  heldSkipped += Number(heldEvents.rows[0]?.count ?? 0);

  // --- 5. Purge old message metadata rows (batched, hold-aware) ----------
  // Bodies were nulled at the body window; the metadata row itself ages out
  // at the (much longer) message window. Terminal statuses only — an old
  // queued/held row is an operational anomaly the stale-send recovery and
  // review-timeout jobs own, not retention. send_outbox rows cascade.
  const messagesPurged = await drainBatches(batchSize, async (limit) => {
    const res = await sql<{ count: string }>`
      WITH batch AS (
        SELECT id FROM messages
        WHERE queued_at < ${messageCutoff}
          AND status IN (${sql.join([...TERMINAL_STATUSES])})
          AND ${noHoldOnMessage}
        ORDER BY queued_at
        LIMIT ${limit}
      ), deleted AS (
        DELETE FROM messages m USING batch WHERE m.id = batch.id
        RETURNING m.id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `.execute(db);
    return Number(res.rows[0]?.count ?? 0);
  });

  // --- 5b. Purge expired event dedup claims (batched) --------------------
  // event_keys only needs to cover the retry horizon (hours); aging it with
  // the event window is already generous. Not hold-gated: the claim row is
  // an idempotency artifact, not tenant content.
  const eventKeysPurged = await drainBatches(batchSize, async (limit) => {
    const res = await sql<{ count: string }>`
      WITH batch AS (
        SELECT event_key FROM event_keys
        WHERE created_at < ${eventCutoff}
        ORDER BY created_at
        LIMIT ${limit}
      ), deleted AS (
        DELETE FROM event_keys k USING batch WHERE k.event_key = batch.event_key
        RETURNING k.event_key
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `.execute(db);
    return Number(res.rows[0]?.count ?? 0);
  });

  // --- 6. Purge webhook delivery log (batched, not hold-gated) -----------
  // Operational delivery telemetry (status codes, durations, endpoint
  // errors) — not tenant message content.
  const webhookLogPurged = await drainBatches(batchSize, async (limit) => {
    const res = await sql<{ count: string }>`
      WITH batch AS (
        SELECT id FROM webhook_delivery_log
        WHERE delivered_at < ${webhookLogCutoff}
        ORDER BY delivered_at
        LIMIT ${limit}
      ), deleted AS (
        DELETE FROM webhook_delivery_log w USING batch WHERE w.id = batch.id
        RETURNING w.id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `.execute(db);
    return Number(res.rows[0]?.count ?? 0);
  });

  // --- 6b. Purge processed send_outbox rows (batched) ---------------------
  // 'enqueued' rows are history once handed to the queue (a genuinely stuck
  // one is reclaimed back to 'pending' within minutes by the drain job);
  // 'failed' rows are kept for the same window for debugging. 'pending' rows
  // are never purged — they are still work to do.
  const sendOutboxPurged = await drainBatches(batchSize, async (limit) => {
    const res = await sql<{ count: string }>`
      WITH batch AS (
        SELECT id FROM send_outbox
        WHERE status IN ('enqueued', 'failed')
          AND created_at < ${outboxCutoff}
        ORDER BY created_at
        LIMIT ${limit}
      ), deleted AS (
        DELETE FROM send_outbox s USING batch WHERE s.id = batch.id
        RETURNING s.id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `.execute(db);
    return Number(res.rows[0]?.count ?? 0);
  });

  // --- 7. Purge blocklist checks (batched, platform-level data) -----------
  const blocklistPurged = await drainBatches(batchSize, async (limit) => {
    const res = await sql<{ count: string }>`
      WITH batch AS (
        SELECT id FROM blocklist_checks
        WHERE checked_at < ${blocklistCutoff}
        ORDER BY checked_at
        LIMIT ${limit}
      ), deleted AS (
        DELETE FROM blocklist_checks b USING batch WHERE b.id = batch.id
        RETURNING b.id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `.execute(db);
    return Number(res.rows[0]?.count ?? 0);
  });

  // --- 7b. Purge DMARC records, then their empty parent reports -----------
  // A single aggregate report may contain up to 100k source records. Delete
  // child records in independently bounded batches before deleting reports,
  // rather than relying on an unbounded ON DELETE CASCADE transaction.
  // Tenant-wide legal holds preserve the aggregate evidence; recipient holds
  // do not apply because DMARC rows contain no recipient identity.
  const dmarcRecordsPurged = await drainBatches(batchSize, async (limit) => {
    const res = await sql<{ count: string }>`
      WITH batch AS (
        SELECT rec.id FROM dmarc_report_records rec
        JOIN dmarc_reports rep ON rep.id = rec.report_id
        WHERE rep.date_range_end < ${dmarcCutoff}
          AND NOT EXISTS (
            SELECT 1 FROM legal_holds h
            WHERE h.customer_id = rep.customer_id
              AND h.scope = 'customer'
              AND h.released_at IS NULL
          )
        ORDER BY rep.date_range_end, rec.id
        LIMIT ${limit}
      ), deleted AS (
        DELETE FROM dmarc_report_records rec USING batch WHERE rec.id = batch.id
        RETURNING rec.id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `.execute(db);
    return Number(res.rows[0]?.count ?? 0);
  });

  const dmarcReportsPurged = await drainBatches(batchSize, async (limit) => {
    const res = await sql<{ count: string }>`
      WITH batch AS (
        SELECT rep.id FROM dmarc_reports rep
        WHERE rep.date_range_end < ${dmarcCutoff}
          AND NOT EXISTS (
            SELECT 1 FROM legal_holds h
            WHERE h.customer_id = rep.customer_id
              AND h.scope = 'customer'
              AND h.released_at IS NULL
          )
        ORDER BY rep.date_range_end, rep.id
        LIMIT ${limit}
      ), deleted AS (
        DELETE FROM dmarc_reports rep USING batch WHERE rep.id = batch.id
        RETURNING rep.id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `.execute(db);
    return Number(res.rows[0]?.count ?? 0);
  });

  const heldDmarc = await sql<{ count: string }>`
    SELECT (
      (SELECT COUNT(*) FROM dmarc_reports rep
       WHERE rep.date_range_end < ${dmarcCutoff}
         AND EXISTS (SELECT 1 FROM legal_holds h WHERE h.customer_id = rep.customer_id AND h.scope = 'customer' AND h.released_at IS NULL))
      +
      (SELECT COUNT(*) FROM dmarc_report_records rec
       JOIN dmarc_reports rep ON rep.id = rec.report_id
       WHERE rep.date_range_end < ${dmarcCutoff}
         AND EXISTS (SELECT 1 FROM legal_holds h WHERE h.customer_id = rep.customer_id AND h.scope = 'customer' AND h.released_at IS NULL))
    )::text AS count
  `.execute(db);
  heldSkipped += Number(heldDmarc.rows[0]?.count ?? 0);
  if (dmarcRecordsPurged) dmarcRetentionPurged.inc({ kind: 'record' }, dmarcRecordsPurged);
  if (dmarcReportsPurged) dmarcRetentionPurged.inc({ kind: 'report' }, dmarcReportsPurged);

  // --- 7c. Expire stored billing webhook payloads (PCI-03/BASE-06) --------
  // The payload is retained only so an operator can replay the event. Past
  // that window it is provider data with no remaining purpose, so the column
  // is nulled while the row — the idempotency marker — is kept forever. The
  // admin API then reports the event exactly as it reports a pre-035 row:
  // "not replayable". Not hold-gated: this is provider billing metadata, not
  // tenant message content, and the invoice/subscription records it produced
  // are unaffected.
  const billingPayloadsPurged = await drainBatches(batchSize, async (limit) => {
    const res = await sql<{ count: string }>`
      WITH batch AS (
        SELECT provider_event_id FROM billing_events
        WHERE payload IS NOT NULL
          AND processed_at < ${billingPayloadCutoff}
        ORDER BY processed_at
        LIMIT ${limit}
      ), cleared AS (
        UPDATE billing_events b SET payload = NULL
        FROM batch WHERE b.provider_event_id = batch.provider_event_id
        RETURNING b.provider_event_id
      )
      SELECT COUNT(*)::text AS count FROM cleared
    `.execute(db);
    return Number(res.rows[0]?.count ?? 0);
  });

  // --- 8. Archive + purge old audit log (not hold-gated: rows are moved to
  // audit_log_archive with their hash-chain fields, never destroyed) -------
  const auditResult = await sql<{ count: string }>`
    WITH candidates AS MATERIALIZED (
      SELECT a.id, a.customer_id, a.api_key_id, a.actor_type, a.actor_id,
        a.actor_label, a.action, a.resource, a.ip, a.metadata, a.occurred_at,
        h.chain_key, h.seq, h.previous_hash, h.row_hash
      FROM audit_log a
      LEFT JOIN audit_log_hashes h ON h.audit_id = a.id
      WHERE a.occurred_at < ${auditCutoff}
    ), archived AS (
      INSERT INTO audit_log_archive (
        audit_id, customer_id, api_key_id, actor_type, actor_id, actor_label,
        action, resource, ip, metadata, occurred_at,
        chain_key, seq, previous_hash, row_hash
      )
      SELECT id, customer_id, api_key_id, actor_type, actor_id, actor_label,
        action, resource, ip, metadata, occurred_at,
        chain_key, seq, previous_hash, row_hash
      FROM candidates
      ON CONFLICT (audit_id) DO NOTHING
      RETURNING audit_id
    ), deleted AS (
      DELETE FROM audit_log a USING candidates c
      WHERE a.id = c.id
      RETURNING a.id
    )
    SELECT COUNT(*)::text AS count FROM deleted
  `.execute(db);
  const auditPurged = Number(auditResult.rows[0]?.count ?? 0);

  // --- 8b. Purge expired export artifacts ---------------------------------
  const exportsPurged = await purgeExpiredExports(exportRetentionDays);

  // --- 9. Purge resolved/rejected review queue entries ------------------
  const reviewResult = await db
    .deleteFrom('review_queue')
    .where('status', 'in', ['approved', 'rejected'])
    .where('created_at', '<', reviewCutoff as any)
    .executeTakeFirst();
  const reviewQueuePurged = Number(reviewResult?.numDeletedRows ?? 0);

  return {
    messages_body_purged: messagesBodyPurged,
    messages_purged: messagesPurged,
    events_purged: eventsPurged,
    event_keys_purged: eventKeysPurged,
    tracked_links_purged: trackedLinksPurged,
    webhook_log_purged: webhookLogPurged,
    blocklist_checks_purged: blocklistPurged,
    send_outbox_purged: sendOutboxPurged,
    exports_purged: exportsPurged,
    dmarc_reports_purged: dmarcReportsPurged,
    dmarc_records_purged: dmarcRecordsPurged,
    billing_payloads_purged: billingPayloadsPurged,
    audit_purged: auditPurged,
    review_queue_purged: reviewQueuePurged,
    held_rows_skipped: heldSkipped,
    request_pinned_rows_skipped: requestPinnedSkipped,
    regulatory_locked_rows_skipped: regulatoryLockedSkipped,
  };
}
