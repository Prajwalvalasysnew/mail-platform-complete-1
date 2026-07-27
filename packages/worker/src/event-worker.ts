import { Worker } from 'bullmq';
import type { Logger } from 'pino';
import {
  db,
  redisOptions,
  webhooksQueue,
  addSuppression,
  recordSoftBounce,
  clearSoftBounce,
  recordIpSends,
  recordDeliveryTlsOutcome,
  writeClickhouseEvent,
  deadLetter,
  deadLetterTotal,
  messagesDelivered,
  messagesBounced,
  complaintsTotal,
  engagementEvents,
  QUEUE_PREFIX,
  type EventJobData,
  isMessagePrivacyErased,
  dispatchWorkflowEvent,
  WORKFLOW_EVENT_TYPES,
} from '@platform/shared';

// Either the shared Kysely instance or a transaction from it. Keyed off the
// imported `db` (not a fresh `kysely` import) to avoid the cjs/esm dual-package
// type identity clash between this package and @platform/shared.
type DbLike = typeof db;

// Status lifecycle precedence. A message status may only ADVANCE — once it has
// reached a higher-precedence state, a later (often out-of-order or duplicate)
// provider event must not pull it back. Terminal failure states
// (hard_bounced/complaint-driven suppression) and `delivered` outrank the
// transient pipeline states. `delivered` and `soft_bounced` sit below the hard
// terminals so a delayed delivery can't erase a hard bounce, but above the
// in-flight states so a duplicate `accepted` can't erase a delivery.
const STATUS_PRECEDENCE: Record<string, number> = {
  queued: 0,
  held: 0,
  sending: 1,
  accepted: 2,
  soft_bounced: 3,
  delivered: 4,
  suppressed: 5,
  failed: 5,
  hard_bounced: 6,
};

// Build a SQL expression that maps the row's current status string to its
// numeric precedence, using the expression builder's CASE so we stay within the
// shared Kysely instance (no raw `sql` import, avoiding the dual-package clash).
function statusRankExpr(eb: any, statusRef: any) {
  let c = eb.case();
  for (const [name, rank] of Object.entries(STATUS_PRECEDENCE)) {
    c = c.when(statusRef, '=', name).then(rank);
  }
  return c.else(0).end();
}

async function bumpUsage(
  customerId: string,
  field: 'delivered' | 'bounced' | 'complained',
  executor: DbLike = db
) {
  const today = new Date().toISOString().slice(0, 10);
  await executor
    .insertInto('usage_daily')
    .values({ customer_id: customerId, usage_date: today, [field]: 1 } as any)
    .onConflict((oc) =>
      oc.columns(['customer_id', 'usage_date']).doUpdateSet((eb) => ({
        [field]: eb(`usage_daily.${field}` as any, '+', 1),
      }) as any)
    )
    .execute();
}

export function startEventWorker(logger: Logger) {
  const worker = new Worker<EventJobData>(
    `${QUEUE_PREFIX}events`,
    async (job) => {
      const ev = job.data;
      const log = logger.child({ message_id: ev.message_id, event_type: ev.event_type });

      // Resolve customer_id if not given
      let customerId = ev.customer_id;
      if (!customerId) {
        const msg = await db
          .selectFrom('messages')
          .select('customer_id')
          .where('message_id', '=', ev.message_id)
          .executeTakeFirst();
        if (!msg) {
          log.warn('message not found, dropping event');
          return;
        }
        customerId = msg.customer_id;
      }
      if (await isMessagePrivacyErased(ev.message_id, customerId)) {
        log.info('privacy tombstone present - dropping stale event job');
        return;
      }
      // Idempotency key: a producer-supplied UUID, stable across a job's
      // retries and globally unique, so a retry after a partial failure can
      // neither re-insert the event nor double-count usage. Events without a
      // key (e.g. opens/clicks, which are naturally multi-occurrence and don't
      // affect usage) insert normally — NULL keys are distinct in the unique
      // index. We deliberately do NOT key on the BullMQ job id: its per-queue
      // counter resets on a Redis flush/failover, which would make a new event
      // collide with an unrelated old one and be silently dropped.
      const eventKey = ev.event_key ?? null;
      const usageField: 'delivered' | 'bounced' | 'complained' | null =
        ev.event_type === 'delivered' ? 'delivered'
        : ev.event_type === 'hard_bounce' ? 'bounced'
        : ev.event_type === 'complaint' ? 'complained'
        : null;

      const { eventRow, isFreshInsert } = await db.transaction().execute(async (trx) => {
        // Dedup via the unpartitioned event_keys claim table (the partitioned
        // events table cannot carry a global UNIQUE(event_key) index). The
        // claim, the event insert, and the usage bump commit atomically, so
        // the exactly-once semantics are identical to the old ON CONFLICT
        // (event_key) on the events table itself.
        if (eventKey) {
          const claimed = await trx
            .insertInto('event_keys')
            .values({ event_key: eventKey })
            .onConflict((oc) => oc.column('event_key').doNothing())
            .returning('event_key')
            .executeTakeFirst();

          if (!claimed) {
            // An earlier attempt already claimed this event_key. We must NOT
            // double-count usage, but we must NOT stop here either — status
            // update / suppression / webhook fanout are all safe to re-run
            // (status update is precedence-guarded, addSuppression is an
            // upsert, and webhook delivery uses a deterministic jobId keyed
            // off the event row id), and skipping them on retry was the bug:
            // if the worker crashed *after* the insert transaction committed
            // on a prior attempt but *before* those steps ran, the event
            // would be permanently stuck with no status update, no
            // suppression, and no webhook.
            const existing = await trx
              .selectFrom('event_keys')
              .select('event_id')
              .where('event_key', '=', eventKey)
              .executeTakeFirst();
            if (!existing || existing.event_id == null) {
              // Claim row without an event id can't be produced by a
              // committed prior attempt (claim + insert are one transaction);
              // treat as already handled and bail out safely.
              return { eventRow: null, isFreshInsert: false };
            }
            return { eventRow: { id: existing.event_id }, isFreshInsert: false };
          }
        }

        const inserted = await trx
          .insertInto('events')
          .values({
            message_id: ev.message_id,
            customer_id: customerId,
            event_type: ev.event_type,
            payload: {
              ...(ev.payload ?? {}),
              ...(ev.bot_verdict ? { bot_reasons: ev.bot_reasons ?? [] } : {}),
            },
            ip: ev.ip ?? null,
            user_agent: ev.user_agent ?? null,
            bot_verdict: ev.bot_verdict ?? null,
            bot_score: typeof ev.bot_score === 'number' ? ev.bot_score : null,
            event_key: eventKey,
          } as any)
          .returning('id')
          .executeTakeFirstOrThrow();

        if (eventKey) {
          await trx
            .updateTable('event_keys')
            .set({ event_id: Number(inserted.id) })
            .where('event_key', '=', eventKey)
            .execute();
        }

        // Fresh row: exactly-once usage accounting happens here, inside the
        // same transaction as the insert.
        if (usageField) await bumpUsage(customerId, usageField, trx);
        return { eventRow: inserted, isFreshInsert: true };
      });

      if (!eventRow) {
        log.info({ event_key: eventKey }, 'duplicate event job — idempotent skip');
        return;
      }
      const inserted = eventRow;
      if (!isFreshInsert) {
        log.info({ event_key: eventKey }, 'duplicate event job — resuming side effects (usage already counted)');
      }

      // Dual-write to ClickHouse (event firehose / analytics). Best-effort:
      // Postgres above is the source of truth; a CH outage never fails the job.
      await writeClickhouseEvent({
        event_id: Number(inserted.id), // dedup key shared with the reconciler
        message_id: ev.message_id,
        customer_id: customerId,
        event_type: ev.event_type,
        occurred_at: ev.occurred_at ?? new Date().toISOString(),
        ip: ev.ip ?? null,
        payload: ev.payload ?? {},
      });

      // Update message status / timestamps based on event type
      const updates: Record<string, unknown> = {};
      const recipientToSuppress: string | null = await (async () => {
        if (['hard_bounce', 'complaint'].includes(ev.event_type)) {
          const msg = await db
            .selectFrom('messages')
            .select('to_address')
            .where('message_id', '=', ev.message_id)
            .executeTakeFirst();
          return msg?.to_address ?? null;
        }
        return null;
      })();

      switch (ev.event_type) {
        case 'delivered':
          updates.status = 'delivered';
          updates.delivered_at = new Date();
          messagesDelivered.inc();
          // Advance per-IP warmup counter so the daily ramp stays accurate.
          if (ev.payload?.src_ip && typeof ev.payload.src_ip === 'string') {
            await recordIpSends(ev.payload.src_ip, 1).catch(() => {});
          }
          // A successful delivery clears any accumulated soft-bounce streak.
          {
            const m = await db.selectFrom('messages').select('to_address').where('message_id', '=', ev.message_id).executeTakeFirst();
            if (m) {
              await clearSoftBounce(customerId, m.to_address);
              // BASE-08: record whether this hop was actually TLS-secured, so
              // the send worker can refuse the NEXT TLS-required message to a
              // domain observed accepting mail in the clear. Best-effort: this
              // is a security signal, not a precondition for recording the
              // delivery itself.
              await recordDeliveryTlsOutcome(m.to_address, ev.payload?.tls_secured as boolean | null | undefined)
                .catch(() => {});
            }
          }
          break;
        case 'soft_bounce':
          updates.status = 'soft_bounced';
          updates.bounced_at = new Date();
          messagesBounced.inc({ type: 'soft' });
          // Escalate to a hard suppression after repeated soft bounces.
          {
            const m = await db.selectFrom('messages').select('to_address').where('message_id', '=', ev.message_id).executeTakeFirst();
            if (m) {
              const escalated = await recordSoftBounce(customerId, m.to_address);
              if (escalated) log.info({ email: m.to_address }, 'soft-bounce escalated to suppression');
            }
          }
          break;
        case 'hard_bounce':
          updates.status = 'hard_bounced';
          updates.bounced_at = new Date();
          messagesBounced.inc({ type: 'hard' });
          break;
        case 'complaint':
          complaintsTotal.inc();
          break;
        case 'opened':
          // Raw first-open (any source) preserves prior behavior.
          updates.opened_at = new Date();
          engagementEvents.inc({ event_type: 'opened', verdict: ev.bot_verdict ?? 'human' });
          // Human-confirmed open feeds engagement metrics; machines (Apple MPP,
          // scanners, image proxies) are recorded but excluded here.
          if (ev.bot_verdict === 'human') {
            updates.human_opened_at = new Date();
          } else {
            updates.machine_opened_at = new Date();
            log.info({ verdict: ev.bot_verdict, score: ev.bot_score, reasons: ev.bot_reasons }, 'machine open filtered from engagement');
          }
          break;
        case 'clicked':
          updates.first_clicked_at = new Date();
          engagementEvents.inc({ event_type: 'clicked', verdict: ev.bot_verdict ?? 'human' });
          if (ev.bot_verdict === 'human') {
            updates.human_clicked_at = new Date();
          } else {
            log.info({ verdict: ev.bot_verdict, score: ev.bot_score, reasons: ev.bot_reasons }, 'machine click filtered from engagement');
          }
          break;
      }

      if (Object.keys(updates).length > 0) {
        // human_opened_at / human_clicked_at should capture the *first* human
        // event, so COALESCE to avoid overwriting an earlier one on repeats.
        const setExpr: any = { ...updates };
        await db
          .updateTable('messages')
          .set((eb: any) => {
            const out: any = { ...setExpr };
            if ('human_opened_at' in setExpr) {
              out.human_opened_at = eb.fn.coalesce('messages.human_opened_at', eb.val(setExpr.human_opened_at));
            }
            if ('human_clicked_at' in setExpr) {
              out.human_clicked_at = eb.fn.coalesce('messages.human_clicked_at', eb.val(setExpr.human_clicked_at));
            }
            // first_clicked_at is, by name, the first click — COALESCE so repeat
            // clicks don't keep pushing the timestamp forward.
            if ('first_clicked_at' in setExpr) {
              out.first_clicked_at = eb.fn.coalesce('messages.first_clicked_at', eb.val(setExpr.first_clicked_at));
            }
            // Status precedence guard. Provider events can arrive out of order (a
            // delayed `delivered` webhook landing after a `hard_bounce`, a
            // duplicate `accepted` after `delivered`, etc.). Status must only
            // ever *advance*, never downgrade — otherwise a stale event would
            // overwrite a more-terminal state and corrupt reporting/suppression.
            // We keep the new status only if its precedence >= the current row's;
            // timestamps above are always recorded regardless of ordering.
            if ('status' in setExpr) {
              const incoming = setExpr.status as string;
              const incomingRank = STATUS_PRECEDENCE[incoming] ?? 0;
              // CASE WHEN rank(current) > rank(incoming) THEN current ELSE incoming END
              out.status = eb
                .case()
                .when(statusRankExpr(eb, eb.ref('messages.status')), '>', incomingRank)
                .then(eb.ref('messages.status'))
                .else(eb.val(incoming))
                .end();
            }
            return out;
          })
          .where('message_id', '=', ev.message_id)
          .execute();
      }

      // Suppress on hard bounce / complaint
      if (recipientToSuppress) {
        await addSuppression(
          customerId,
          recipientToSuppress,
          ev.event_type === 'complaint' ? 'complaint' : 'hard_bounce',
          `Auto-added from ${ev.event_type}`
        );
        log.info({ email: recipientToSuppress }, 'added to suppression list');
      }

      // Fan out to webhooks subscribed to this event type
      const webhooks = await db
        .selectFrom('webhooks')
        .select(['id', 'events'])
        .where('customer_id', '=', customerId)
        .where('enabled', '=', true)
        .execute();

      for (const wh of webhooks) {
        if (!wh.events.includes(ev.event_type)) continue;
        await webhooksQueue.add(
          'deliver',
          {
            webhook_id: wh.id,
            event_id: inserted.id,
            event_type: ev.event_type,
            payload: {
              message_id: ev.message_id,
              event_type: ev.event_type,
              occurred_at: new Date().toISOString(),
              ...(ev.payload ?? {}),
            },
          },
          // Deterministic per (webhook, event row) so a re-run never enqueues a
          // duplicate delivery for the same event.
          { jobId: `wh:${wh.id}:${inserted.id}` }
        );
      }

      // Workflow automation dispatch: engagement events can start runs
      // (event triggers), resume wait_for_event steps, and mark goals. All
      // downstream transitions are idempotent against workflow_runs rows, so
      // a job retry re-running this block is safe.
      if ((WORKFLOW_EVENT_TYPES as readonly string[]).includes(ev.event_type)) {
        const msg = await db
          .selectFrom('messages')
          .select('to_address')
          .where('message_id', '=', ev.message_id)
          .executeTakeFirst();
        if (msg) {
          const dispatched = await dispatchWorkflowEvent({
            customerId,
            eventType: ev.event_type,
            subjectEmail: msg.to_address,
            messageId: ev.message_id,
            payload: ev.payload ?? {},
          });
          if (dispatched.started_runs.length || dispatched.resumed_runs.length || dispatched.goals_met.length) {
            log.info(
              {
                started: dispatched.started_runs.length,
                resumed: dispatched.resumed_runs.length,
                goals: dispatched.goals_met.length,
              },
              'workflow dispatch for event'
            );
          }
        }
      }
    },
    {
      connection: redisOptions,
      concurrency: 25,
    }
  );

  // Dead-letter event jobs that exhaust their retries so a poison event is
  // observable rather than silently dropped (parity with the send worker).
  worker.on('failed', async (job, err) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts?.attempts ?? 1;
    if (job && attemptsMade >= maxAttempts) {
      logger.error({ job_id: job.id, message_id: job.data?.message_id, event_type: job.data?.event_type, err: err.message, attemptsMade }, 'event job exhausted retries — dead-lettering');
      try {
        await deadLetter('events', job, err.message);
        deadLetterTotal.inc({ source_queue: 'events' });
      } catch (dlErr: any) {
        logger.error({ err: dlErr?.message }, 'failed to dead-letter event job');
      }
    } else {
      logger.warn({ job_id: job?.id, err: err.message, attemptsMade }, 'event job failed (will retry)');
    }
  });

  return worker;
}
