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
//   - audit_log rows older than RETENTION_AUDIT_DAYS (default 365) — archived
//     to audit_log_archive, never destroyed, so legal holds do not gate this
//   - resolved/rejected review_queue rows older than RETENTION_REVIEW_QUEUE_DAYS (default 30)
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
  audit_purged: number;
  review_queue_purged: number;
  /** Rows matching a retention cutoff but preserved by an active legal hold. */
  held_rows_skipped: number;
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
const noHoldOnMessage = sql<boolean>`NOT ${holdOnMessage}`;

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
    batchSize = Number(process.env.RETENTION_BATCH_SIZE ?? 10_000),
  } = opts;

  const bodyCutoff = new Date(Date.now() - messageBodyRetentionDays * 86_400_000);
  const eventCutoff = new Date(Date.now() - eventRetentionDays * 86_400_000);
  const messageCutoff = new Date(Date.now() - messageRetentionDays * 86_400_000);
  const auditCutoff = new Date(Date.now() - auditRetentionDays * 86_400_000);
  const reviewCutoff = new Date(Date.now() - reviewQueueRetentionDays * 86_400_000);
  const webhookLogCutoff = new Date(Date.now() - webhookLogRetentionDays * 86_400_000);
  const blocklistCutoff = new Date(Date.now() - blocklistRetentionDays * 86_400_000);
  const outboxCutoff = new Date(Date.now() - outboxRetentionDays * 86_400_000);

  let heldSkipped = 0;

  // --- 1. Purge inline bodies (batched, hold-aware) ----------------------
  const messagesBodyPurgedInline = await drainBatches(batchSize, async (limit) => {
    const res = await sql<{ count: string }>`
      WITH batch AS (
        SELECT id FROM messages
        WHERE body_storage = 'inline'
          AND status IN (${sql.join([...TERMINAL_STATUSES])})
          AND queued_at < ${bodyCutoff}
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

  // Count inline bodies preserved solely because of a hold (visibility).
  const heldInline = await sql<{ count: string }>`
    SELECT COUNT(*)::text AS count FROM messages
    WHERE body_storage = 'inline'
      AND status IN (${sql.join([...TERMINAL_STATUSES])})
      AND queued_at < ${bodyCutoff}
      AND (html_body IS NOT NULL OR text_body IS NOT NULL)
      AND ${holdOnMessage}
  `.execute(db);
  heldSkipped += Number(heldInline.rows[0]?.count ?? 0);

  // --- 2. Purge offloaded bodies (hold-aware) ----------------------------
  // Only delete an object when EVERY message referencing that key is past
  // retention AND none of them is under an active legal hold. First collect
  // keys still live (referenced by a non-expired, non-terminal, or held
  // message), then delete the rest.
  const liveKeyRows = await db
    .selectFrom('messages')
    .select('body_object_key')
    .where('body_storage', '!=', 'inline')
    .where('body_object_key', 'is not', null)
    .where((eb) =>
      eb.or([
        eb('status', 'not in', TERMINAL_STATUSES),
        eb('queued_at', '>=', bodyCutoff as any),
        holdOnMessage,
      ]),
    )
    .groupBy('body_object_key')
    .execute();
  const liveKeys = new Set(liveKeyRows.map((r) => r.body_object_key).filter(Boolean));

  const expiredObjectRows = await db
    .selectFrom('messages')
    .select('body_object_key')
    .where('body_storage', '!=', 'inline')
    .where('body_object_key', 'is not', null)
    .where('status', 'in', TERMINAL_STATUSES)
    .where('queued_at', '<', bodyCutoff as any)
    .groupBy('body_object_key')
    .execute();

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
      WITH batch AS (
        SELECT e.id FROM events e
        LEFT JOIN messages ON messages.message_id = e.message_id
        WHERE e.occurred_at < ${eventCutoff}
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
    SELECT COUNT(*)::text AS count FROM events e
    LEFT JOIN messages ON messages.message_id = e.message_id
    WHERE e.occurred_at < ${eventCutoff}
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
    audit_purged: auditPurged,
    review_queue_purged: reviewQueuePurged,
    held_rows_skipped: heldSkipped,
  };
}
