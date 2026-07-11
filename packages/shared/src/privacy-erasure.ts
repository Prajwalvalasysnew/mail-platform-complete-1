import { db } from './db.js';
import { getBodyStore } from './storage.js';
import { deleteClickhouseMessageEvents } from './clickhouse.js';
import { purgeQueuedMessageData } from './queues.js';

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
