// Retention / cleanup jobs.
//
// Purges old data to keep the hot tables lean:
//   - inline message bodies older than RETENTION_BODY_DAYS (default 90)
//   - offloaded body objects where every referencing message is past retention
//   - events rows older than RETENTION_EVENT_DAYS (default 90)
//   - audit_log rows older than RETENTION_AUDIT_DAYS (default 365)
//   - resolved/rejected review_queue rows older than RETENTION_REVIEW_QUEUE_DAYS (default 30)
//
// All cutoffs default from env vars and can be overridden per call — useful for
// admin-triggered manual runs and for E2E tests (pass 0 to target recent rows).

import { db } from './db.js';
import { getBodyStore } from './storage.js';

export interface RetentionOptions {
  /** Days to keep message bodies. Default: RETENTION_BODY_DAYS env or 90. */
  messageBodyRetentionDays?: number;
  /** Days to keep event rows. Default: RETENTION_EVENT_DAYS env or 90. */
  eventRetentionDays?: number;
  /** Days to keep audit_log rows. Default: RETENTION_AUDIT_DAYS env or 365. */
  auditRetentionDays?: number;
  /** Days to keep resolved/rejected review_queue rows. Default: RETENTION_REVIEW_QUEUE_DAYS env or 30. */
  reviewQueueRetentionDays?: number;
}

export interface RetentionResult {
  messages_body_purged: number;
  events_purged: number;
  audit_purged: number;
  review_queue_purged: number;
}

const TERMINAL_STATUSES = ['delivered', 'hard_bounced', 'failed', 'suppressed'] as const;

export async function runRetention(opts: RetentionOptions = {}): Promise<RetentionResult> {
  const {
    messageBodyRetentionDays = Number(process.env.RETENTION_BODY_DAYS ?? 90),
    eventRetentionDays = Number(process.env.RETENTION_EVENT_DAYS ?? 90),
    auditRetentionDays = Number(process.env.RETENTION_AUDIT_DAYS ?? 365),
    reviewQueueRetentionDays = Number(process.env.RETENTION_REVIEW_QUEUE_DAYS ?? 30),
  } = opts;

  const bodyCutoff = new Date(Date.now() - messageBodyRetentionDays * 86_400_000);
  const eventCutoff = new Date(Date.now() - eventRetentionDays * 86_400_000);
  const auditCutoff = new Date(Date.now() - auditRetentionDays * 86_400_000);
  const reviewCutoff = new Date(Date.now() - reviewQueueRetentionDays * 86_400_000);

  // --- 1. Purge inline bodies -------------------------------------------
  const inlineResult = await db
    .updateTable('messages')
    .set({ html_body: null, text_body: null })
    .where('body_storage', '=', 'inline')
    .where('status', 'in', TERMINAL_STATUSES)
    .where('queued_at', '<', bodyCutoff as any)
    .where((eb) => eb.or([eb('html_body', 'is not', null), eb('text_body', 'is not', null)]))
    .executeTakeFirst();
  let messagesBodyPurged = Number(inlineResult?.numUpdatedRows ?? 0);

  // --- 2. Purge offloaded bodies ----------------------------------------
  // Only delete an object when EVERY message referencing that key is past
  // retention. First collect keys still live (referenced by a non-expired or
  // non-terminal message), then delete the rest.
  const liveKeyRows = await db
    .selectFrom('messages')
    .select('body_object_key')
    .where('body_storage', '!=', 'inline')
    .where('body_object_key', 'is not', null)
    .where((eb) =>
      eb.or([
        eb('status', 'not in', TERMINAL_STATUSES),
        eb('queued_at', '>=', bodyCutoff as any),
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
    if (!key || liveKeys.has(key)) continue;
    await store.delete(key);
    const cleared = await db
      .updateTable('messages')
      .set({ body_object_key: null })
      .where('body_object_key', '=', key)
      .executeTakeFirst();
    messagesBodyPurged += Number(cleared?.numUpdatedRows ?? 0);
  }

  // --- 3. Purge old events -----------------------------------------------
  const eventsResult = await db
    .deleteFrom('events')
    .where('occurred_at', '<', eventCutoff as any)
    .executeTakeFirst();
  const eventsPurged = Number(eventsResult?.numDeletedRows ?? 0);

  // --- 4. Purge old audit log --------------------------------------------
  const auditResult = await db
    .deleteFrom('audit_log')
    .where('occurred_at', '<', auditCutoff as any)
    .executeTakeFirst();
  const auditPurged = Number(auditResult?.numDeletedRows ?? 0);

  // --- 5. Purge resolved/rejected review queue entries ------------------
  const reviewResult = await db
    .deleteFrom('review_queue')
    .where('status', 'in', ['approved', 'rejected'])
    .where('created_at', '<', reviewCutoff as any)
    .executeTakeFirst();
  const reviewQueuePurged = Number(reviewResult?.numDeletedRows ?? 0);

  return {
    messages_body_purged: messagesBodyPurged,
    events_purged: eventsPurged,
    audit_purged: auditPurged,
    review_queue_purged: reviewQueuePurged,
  };
}
