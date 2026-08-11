import { sql, type Kysely } from 'kysely';
import { db } from './db.js';
import { sendQueue, type SendJobData } from './queues.js';
import type { Database } from './schema.js';

export interface SendOutboxInsert {
  message_id: string;
  customer_id: string;
  priority: number;
  run_at?: Date | string | null;
}

export interface DrainSendOutboxOpts {
  limit?: number;
  messageIds?: string[];
  now?: Date;
}

type DbLike = Kysely<Database>;

export function sendOutboxJobId(messageId: string): string {
  return `send-${Buffer.from(messageId).toString('base64url')}`;
}

export async function createSendOutboxRows(
  rows: SendOutboxInsert[],
  executor: DbLike = db
): Promise<void> {
  if (rows.length === 0) return;
  await executor
    .insertInto('send_outbox')
    .values(
      rows.map((r) => ({
        message_id: r.message_id,
        customer_id: r.customer_id,
        priority: r.priority,
        run_at: r.run_at ?? new Date(),
      }))
    )
    .onConflict((oc) =>
      oc.column('message_id').doUpdateSet((eb) => ({
        status: 'pending',
        priority: eb.ref('excluded.priority'),
        run_at: eb.ref('excluded.run_at'),
        last_error: null,
        enqueued_at: null,
      }))
    )
    .execute();
}

/**
 * Fast path for rows the caller has just committed.
 *
 * The durable outbox row already protects the DB->Redis handoff. We can add
 * the deterministic BullMQ job directly and mark that known row enqueued in
 * one UPDATE, instead of opening a second transaction to select/lock/re-read
 * it. If either step races or fails, the row remains pending and the periodic
 * SKIP LOCKED drainer below safely retries it.
 */
export async function dispatchCreatedSendOutbox(
  rows: SendOutboxInsert[],
  options: { awaitStatusUpdate?: boolean } = {},
): Promise<number> {
  if (rows.length === 0) return 0;
  await sendQueue.addBulk(
    rows.map((row) => {
      const runAt = row.run_at ? new Date(row.run_at) : new Date();
      const delay = Math.max(0, runAt.getTime() - Date.now());
      return {
        name: 'send',
        data: {
          message_id: row.message_id,
          customer_id: row.customer_id,
          priority: row.priority,
        } satisfies SendJobData,
        opts: {
          priority: row.priority,
          delay,
          jobId: sendOutboxJobId(row.message_id),
        },
      };
    }),
  );

  const messageIds = rows.map((row) => row.message_id);
  const statusUpdate = db
    .updateTable('send_outbox')
    .set((eb) => ({
      attempts: eb('attempts', '+', 1),
      status: 'enqueued',
      enqueued_at: new Date(),
      last_error: null,
    }))
    .where('message_id', 'in', messageIds)
    .where('status', '=', 'pending')
    .execute();
  if (options.awaitStatusUpdate === false) {
    // Crash-safe: if this best-effort mark fails or the process dies, the row
    // remains pending. The periodic drainer re-adds the deterministic job id,
    // which BullMQ deduplicates, and then marks it enqueued.
    void statusUpdate.catch(() => {});
  } else {
    await statusUpdate;
  }
  return rows.length;
}

/**
 * Move pending durable-send rows into BullMQ. Rows are claimed with
 * FOR UPDATE SKIP LOCKED so multiple worker replicas can safely drain at once.
 */
export async function drainSendOutbox(opts: DrainSendOutboxOpts = {}): Promise<number> {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
  const now = opts.now ?? new Date();

  const claimed = await db.transaction().execute(async (trx) => {
    let q = trx
      .selectFrom('send_outbox')
      .select(['id', 'message_id', 'customer_id', 'priority', 'run_at'])
      .where('status', '=', 'pending')
      .where('run_at', '<=', now)
      .orderBy('run_at', 'asc')
      .orderBy('created_at', 'asc')
      .limit(limit)
      .forUpdate()
      .skipLocked();

    if (opts.messageIds?.length) {
      q = q.where('message_id', 'in', opts.messageIds);
    }

    const rows = await q.execute();
    if (rows.length === 0) return [];

    // Claim the rows *inside* the transaction: flip them out of 'pending' here,
    // not after commit. Otherwise the FOR UPDATE lock releases on commit while
    // the rows are still 'pending', and a concurrent drainer can re-claim the
    // same rows (double-incrementing attempts and skipping others). If the
    // BullMQ enqueue below fails, the catch resets them to 'pending'.
    await trx
      .updateTable('send_outbox')
      .set((eb) => ({
        attempts: eb('attempts', '+', 1),
        status: 'enqueued',
        enqueued_at: new Date(),
        last_error: null,
      }))
      .where('id', 'in', rows.map((r) => r.id))
      .execute();

    return rows;
  });

  if (claimed.length === 0) return 0;

  try {
    await sendQueue.addBulk(
      claimed.map((row) => {
        const delay = Math.max(0, new Date(row.run_at).getTime() - Date.now());
        return {
          name: 'send',
          data: {
            message_id: row.message_id,
            customer_id: row.customer_id,
            priority: row.priority,
          } satisfies SendJobData,
          opts: { priority: row.priority, delay, jobId: sendOutboxJobId(row.message_id) },
        };
      })
    );

    return claimed.length;
  } catch (err: any) {
    await db
      .updateTable('send_outbox')
      .set({
        status: 'pending',
        last_error: String(err?.message ?? err),
      })
      .where('id', 'in', claimed.map((r) => r.id))
      .execute();
    throw err;
  }
}

/**
 * Crash-recovery for the DB->Redis handoff gap: drainSendOutbox commits rows
 * as 'enqueued' *before* calling sendQueue.addBulk. If the process dies in
 * that window, the rows are stranded — they are no longer 'pending' (so the
 * drainer ignores them) and no BullMQ job exists to send them.
 *
 * This reclaims rows that have sat in 'enqueued' longer than `staleMinutes`
 * while their message is still 'queued' (i.e. no worker ever picked them up)
 * back to 'pending' so the next drain re-adds them. Re-adding is safe:
 * sendOutboxJobId() is deterministic (BullMQ dedupes an existing job id), and
 * the send worker's atomic queued->sending claim means even a genuine
 * duplicate job cannot double-deliver.
 */
export async function reclaimStaleSendOutbox(staleMinutes = 10): Promise<number> {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);
  const rows = await db
    .updateTable('send_outbox')
    .set({ status: 'pending', last_error: 'reclaimed: stale enqueued (crash between DB claim and Redis add?)' })
    .where('status', '=', 'enqueued')
    .where('enqueued_at', '<', cutoff)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('messages')
          .select('messages.message_id')
          .whereRef('messages.message_id', '=', 'send_outbox.message_id')
          .where('messages.status', '=', 'queued')
      )
    )
    .returning('id')
    .execute();
  return rows.length;
}

export async function countPendingSendOutbox(): Promise<number> {
  const row = await db
    .selectFrom('send_outbox')
    .select(sql<number>`count(*)`.as('count'))
    .where('status', '=', 'pending')
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}
