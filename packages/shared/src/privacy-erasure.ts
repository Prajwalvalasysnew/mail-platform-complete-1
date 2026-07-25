import { db } from './db.js';
import { getBodyStore } from './storage.js';
import { deleteClickhouseMessageEvents, clickhouseEnabled } from './clickhouse.js';
import { purgeQueuedMessageData } from './queues.js';
import { erasedRecipientPseudonym, pseudonymizeErasedRecipient } from './privacy-pseudonym.js';

export interface PrivacyErasureRetryResult {
  claimed: number;
  completed: number;
  failed: number;
  requestsCompleted: number;
  requestsFailed: number;
}

/** Fast worker gate preventing stale jobs from processing an erased message. */
export async function isMessagePrivacyErased(messageId: string, customerId?: string): Promise<boolean> {
  let query = db.selectFrom('privacy_message_tombstones').select('message_id')
    .where('message_id', '=', messageId);
  if (customerId) query = query.where('customer_id', '=', customerId);
  return !!(await query.executeTakeFirst());
}

/** Retry durable body-object erasures. SKIP LOCKED makes concurrent workers safe. */
export async function retryPendingBodyErasures(options: {
  limit?: number;
  maxAttempts?: number;
} = {}): Promise<PrivacyErasureRetryResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const maxAttempts = Math.max(1, options.maxAttempts ?? 10);
  const store = getBodyStore();
  const claimed = await db.transaction().execute(async (trx) => {
    const rows = await trx.selectFrom('deletion_object_items')
      .innerJoin('deletion_requests', 'deletion_requests.id', 'deletion_object_items.deletion_request_id')
      .selectAll('deletion_object_items')
      .select('deletion_requests.customer_id')
      .where('deletion_object_items.status', 'in', ['pending', 'failed'])
      .where('deletion_object_items.attempts', '<', maxAttempts)
      .orderBy('deletion_object_items.updated_at', 'asc').limit(limit).forUpdate().skipLocked().execute();
    for (const row of rows) {
      await trx.updateTable('deletion_object_items').set({
        status: 'pending', attempts: row.attempts + 1, last_error: null, updated_at: new Date(),
      }).where('id', '=', row.id).execute();
    }
    return rows;
  });

  let completed = 0;
  let failed = 0;
  const requestIds = new Set<string>();
  for (const item of claimed) {
    requestIds.add(item.deletion_request_id);
    try {
      if (item.storage_kind === 'clickhouse') {
        await deleteClickhouseMessageEvents(item.customer_id, item.object_key);
      } else if (item.storage_kind === 'bullmq') {
        const result = await purgeQueuedMessageData(item.object_key);
        if (result.active > 0) throw new Error(`bullmq_active_jobs:${result.active}`);
      } else if (item.storage_kind !== store.kind) {
        throw new Error(`body_store_kind_mismatch:${item.storage_kind}:${store.kind}`);
      } else {
        await store.delete(item.object_key);
      }
      await db.updateTable('deletion_object_items').set({
        status: 'completed', completed_at: new Date(), last_error: null, updated_at: new Date(),
      }).where('id', '=', item.id).execute();
      completed++;
    } catch (error) {
      await db.updateTable('deletion_object_items').set({
        status: 'failed',
        last_error: error instanceof Error ? error.message.slice(0, 2000) : 'unknown_object_delete_error',
        updated_at: new Date(),
      }).where('id', '=', item.id).execute();
      failed++;
    }
  }

  let requestsCompleted = 0;
  let requestsFailed = 0;
  for (const requestId of requestIds) {
    const remaining = await db.selectFrom('deletion_object_items').select(['status', 'attempts'])
      .where('deletion_request_id', '=', requestId).where('status', '!=', 'completed').execute();
    const status = remaining.length === 0 ? 'completed'
      : remaining.every((row) => row.attempts >= maxAttempts) ? 'failed' : 'pending';
    await db.updateTable('deletion_requests').set({ status }).where('id', '=', requestId).execute();
    if (status === 'completed') requestsCompleted++;
    if (status === 'failed') requestsFailed++;
  }
  return { claimed: claimed.length, completed, failed, requestsCompleted, requestsFailed };
}

// ─── Restore-time re-deletion (mandatory privacy regression test 6) ──────────
//
// Online erasure does not rewrite backup images. A restore from a backup taken
// BEFORE an erasure therefore brings the erased rows back — and without a
// re-deletion step the platform silently resurrects data a data subject
// already had removed, which is the failure the compliance plan calls out
// ("a backup restore followed by tombstone replay does not resurrect usable
// erased data").
//
// privacy_message_tombstones is the durable record of what was erased. It
// deliberately holds no recipient address — retaining the identifier would
// defeat the erasure — so replay recovers the address from the RESTORED
// message rows themselves, uses it to re-run the identifier scrub, and then
// destroys those rows again. The recovered address is verified against the
// pseudonym already recorded on the deletion request before it is used, so a
// restored row can only drive a scrub for the recipient it actually belongs to.
//
// Run this after ANY restore, before the restored node serves traffic.

export interface TombstoneReplayResult {
  /** Tombstoned messages found alive again after the restore. */
  resurrected_messages: number;
  messages_purged: number;
  events_purged: number;
  tracked_links_purged: number;
  send_outbox_purged: number;
  /** Distinct recipients whose surviving identifier rows were re-scrubbed. */
  recipients_repseudonymized: number;
  /** Object/analytics/queue deletions re-queued for the restored messages. */
  object_items_requeued: number;
  /** Restored rows whose address did not match the recorded pseudonym. */
  mismatched_skipped: number;
}

export async function replayPrivacyTombstones(
  options: { limit?: number; customerId?: string } = {},
): Promise<TombstoneReplayResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));
  const result: TombstoneReplayResult = {
    resurrected_messages: 0,
    messages_purged: 0,
    events_purged: 0,
    tracked_links_purged: 0,
    send_outbox_purged: 0,
    recipients_repseudonymized: 0,
    object_items_requeued: 0,
    mismatched_skipped: 0,
  };

  // Messages that are tombstoned yet present again: the restore signature.
  // `customerId` scopes the replay to a single tenant, for the common case of
  // restoring one tenant's data rather than the whole cluster.
  let query = db
    .selectFrom('privacy_message_tombstones as t')
    .innerJoin('messages as m', (join) =>
      join.onRef('m.message_id', '=', 't.message_id').onRef('m.customer_id', '=', 't.customer_id'))
    .select([
      't.customer_id', 't.message_id', 't.deletion_request_id',
      'm.to_address', 'm.body_storage', 'm.body_object_key',
    ])
    .limit(limit);
  if (options.customerId) query = query.where('t.customer_id', '=', options.customerId);
  const resurrected = await query.execute();

  result.resurrected_messages = resurrected.length;
  if (resurrected.length === 0) return result;

  // The pseudonym on each deletion request is the authority for which
  // recipient that request erased. A restored address that does not hash to it
  // is not this request's subject and is left alone for an operator to review.
  const requestIds = [...new Set(resurrected.map((r) => r.deletion_request_id))];
  const requests = await db
    .selectFrom('deletion_requests')
    .select(['id', 'recipient'])
    .where('id', 'in', requestIds)
    .execute();
  const pseudonymByRequest = new Map(requests.map((r) => [r.id, r.recipient]));

  const verified = resurrected.filter((row) => {
    const expected = pseudonymByRequest.get(row.deletion_request_id);
    if (!expected) return false;
    return erasedRecipientPseudonym(row.customer_id, row.to_address) === expected;
  });
  result.mismatched_skipped = resurrected.length - verified.length;
  if (verified.length === 0) return result;

  const messageIds = verified.map((r) => r.message_id);
  const storageKind = getBodyStore().kind;

  await db.transaction().execute(async (trx) => {
    const ev = await trx.deleteFrom('events').where('message_id', 'in', messageIds).executeTakeFirst();
    result.events_purged = Number(ev.numDeletedRows ?? 0);

    const links = await trx.deleteFrom('tracked_links').where('message_id', 'in', messageIds).executeTakeFirst();
    result.tracked_links_purged = Number(links.numDeletedRows ?? 0);

    const outbox = await trx.deleteFrom('send_outbox').where('message_id', 'in', messageIds).executeTakeFirst();
    result.send_outbox_purged = Number(outbox.numDeletedRows ?? 0);

    const msgs = await trx.deleteFrom('messages').where('message_id', 'in', messageIds).executeTakeFirst();
    result.messages_purged = Number(msgs.numDeletedRows ?? 0);

    // Re-scrub the identifier rows that survive erasure by design (consent
    // ledger, prior deletion requests, unsubscribe-group membership). A
    // restore can have brought back the plaintext address in any of them.
    const seen = new Set<string>();
    for (const row of verified) {
      const key = `${row.customer_id}\n${row.to_address.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await pseudonymizeErasedRecipient(row.customer_id, row.to_address, trx);
      result.recipients_repseudonymized++;
    }

    // Re-queue the out-of-database deletions. The retry worker owns the actual
    // removal, so a restored body object, analytics row, or queued job is
    // cleaned up through the same audited path as the original erasure.
    const items: Array<{ deletion_request_id: string; object_key: string; storage_kind: string }> = [];
    for (const row of verified) {
      if (row.body_storage !== 'inline' && row.body_object_key) {
        items.push({ deletion_request_id: row.deletion_request_id, object_key: row.body_object_key, storage_kind: storageKind });
      }
      items.push({ deletion_request_id: row.deletion_request_id, object_key: row.message_id, storage_kind: 'bullmq' });
      if (clickhouseEnabled()) {
        items.push({ deletion_request_id: row.deletion_request_id, object_key: row.message_id, storage_kind: 'clickhouse' });
      }
    }
    if (items.length > 0) {
      // The original erasure already created these rows and the retry worker
      // marked them completed. A restore makes them outstanding work again, so
      // reset the existing row to pending rather than inserting a duplicate —
      // (deletion_request_id, storage_kind, object_key) is unique, and reusing
      // the row keeps one audit trail per object instead of forking it.
      await trx.insertInto('deletion_object_items').values(items)
        .onConflict((oc) => oc
          .constraint('deletion_object_items_request_store_key_unique')
          .doUpdateSet({ status: 'pending', attempts: 0, last_error: null, completed_at: null, updated_at: new Date() }))
        .execute();
      result.object_items_requeued = items.length;
    }

    // The affected requests have outstanding work again.
    await trx.updateTable('deletion_requests').set({ status: 'pending' })
      .where('id', 'in', [...new Set(verified.map((r) => r.deletion_request_id))]).execute();
  });

  return result;
}
