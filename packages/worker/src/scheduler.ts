import type { Logger } from 'pino';
import { sql } from 'kysely';
import {
  db,
  redis,
  evaluatePoolHealth,
  monitorAllBlocklists,
  advanceIpWarmup,
  advanceWarmupStages,
  retireOldKeys,
  reconcileClickhouse,
  clickhouseEnabled,
  sweepIdempotencyKeys,
  reconcileMetering,
  drainSendOutbox,
  reclaimStaleSendOutbox,
  clearExpiredWebhookRotationSecrets,
  withSchedulerLock,
  poolPaused,
  bounceRateGauge,
  complaintRateGauge,
  blocklistListings,
  meteringDrift,
  runRetention,
  assertPublicHttpUrl,
  ingestPostmaster,
  updateVolumeBaseline,
  eventsQueue,
  retryPendingBodyErasures,
  runDunningSweep,
  expirePlanChangeRequests,
  reconcileSubmittedPlanChanges,
  applyScheduledDowngrades,
  countStuckPlanChanges,
  billingStuckRequests,
  checkpointAllAuditChains,
  expireElevations,
} from '@platform/shared';

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<void>;
  last?: number;
}

/**
 * Lightweight in-process scheduler for periodic operational jobs. In a larger
 * deployment these would be separate cron pods (and the functions are pure, so
 * they can be invoked from anywhere), but co-locating them here keeps the
 * skeleton runnable with one worker process.
 */
export function startScheduler(logger: Logger): { stop: () => void } {
  const HOUR = 3600_000;
  const MIN = 60_000;

  const jobs: Job[] = [
    {
      name: 'send_outbox_drain',
      // 30s polling: if the API's best-effort drain fails (Redis blip, crash),
      // pending outbox rows are picked up within 30s rather than 60s.
      everyMs: 30_000,
      run: async () => {
        // First rescue rows stranded 'enqueued' by a crash between the DB
        // claim and the Redis add (they'd otherwise never be drained again).
        const reclaimed = await reclaimStaleSendOutbox(
          Number(process.env.SEND_OUTBOX_RECLAIM_STALE_MINUTES ?? 10)
        );
        if (reclaimed) logger.warn({ reclaimed }, 'reclaimed stale enqueued send-outbox rows');
        const n = await drainSendOutbox({ limit: Number(process.env.SEND_OUTBOX_DRAIN_LIMIT ?? 2000) });
        if (n) logger.info({ enqueued: n }, 'drained send outbox');
      },
    },
    {
      name: 'webhook_secret_rotation_cleanup',
      everyMs: HOUR,
      run: async () => {
        const cleared = await clearExpiredWebhookRotationSecrets();
        if (cleared) logger.info({ cleared }, 'cleared expired webhook previous_secret grace windows');
      },
    },
    {
      name: 'reputation_guard',
      everyMs: 5 * MIN,
      run: async () => {
        const pools = await evaluatePoolHealth();
        for (const p of pools) {
          const prevPausedRaw = await redis.get(`pool:prev_action:${p.pool}`);
          const prevAction = prevPausedRaw ?? 'ok';

          poolPaused.set({ pool: p.pool }, p.action === 'pause' ? 1 : 0);
          bounceRateGauge.set({ pool: p.pool }, p.bounce_rate);
          complaintRateGauge.set({ pool: p.pool }, p.complaint_rate);

          if (p.action !== 'ok') {
            logger.warn({ pool: p.pool, action: p.action, reasons: p.reasons }, 'reputation guard action');
          } else if (prevAction !== 'ok') {
            // Pool has recovered — log the transition explicitly.
            logger.info({ pool: p.pool, prev_action: prevAction, bounce_rate: p.bounce_rate, complaint_rate: p.complaint_rate }, 'reputation guard: pool recovered to ok');
            await eventsQueue.add('pool_recovered', { pool: p.pool, prev_action: prevAction, bounce_rate: p.bounce_rate, complaint_rate: p.complaint_rate } as any);
          }

          // Track previous action so we can detect recovery on the next tick.
          await redis.set(`pool:prev_action:${p.pool}`, p.action, 'EX', 3600 * 2);
        }
      },
    },
    {
      name: 'blocklist_monitor',
      everyMs: 6 * HOUR,
      run: async () => {
        const listings = await monitorAllBlocklists();
        const byProvider: Record<string, number> = {};
        for (const l of listings) byProvider[l.provider] = (byProvider[l.provider] ?? 0) + 1;
        for (const [provider, count] of Object.entries(byProvider)) {
          blocklistListings.set({ provider }, count);
          logger.error({ provider, count }, 'sending IP(s) listed on DNSBL — see runbook BLOCKLIST');
        }
        if (listings.length === 0) logger.info('blocklist scan clean');
      },
    },
    {
      name: 'warmup_advance',
      everyMs: 6 * HOUR,
      run: async () => {
        const ips = await advanceIpWarmup();
        await advanceWarmupStages();
        if (ips.length) logger.info({ advanced: ips }, 'IP warmup stages advanced');
      },
    },
    {
      name: 'dkim_retire',
      everyMs: 12 * HOUR,
      run: async () => {
        const n = await retireOldKeys();
        if (n) logger.info({ retired: n }, 'retired old DKIM selectors');
      },
    },
    {
      // Analytics durability (gap analysis #13): backfill any events not yet in
      // ClickHouse (dropped by a best-effort live write during an outage/crash).
      // Postgres `events` is the source of truth; this ships events past the
      // watermark and advances it only on confirmed insert.
      name: 'clickhouse_reconcile',
      everyMs: 5 * 60_000,
      run: async () => {
        if (!clickhouseEnabled()) return;
        const res = await reconcileClickhouse();
        if (res.shipped > 0) logger.info({ shipped: res.shipped, batches: res.batches, to: res.toEventId }, 'clickhouse reconcile shipped events');
        if (res.failed) logger.warn('clickhouse reconcile hit an insert failure; will retry next run');
      },
    },
    {
      name: 'privacy_erasure_retry',
      everyMs: 5 * MIN,
      run: async () => {
        const result = await retryPendingBodyErasures({
          limit: Number(process.env.PRIVACY_ERASURE_RETRY_LIMIT ?? 100),
          maxAttempts: Number(process.env.PRIVACY_ERASURE_MAX_ATTEMPTS ?? 10),
        });
        if (result.claimed) logger.info({ result }, 'privacy body erasure retry completed');
        if (result.failed || result.requestsFailed) {
          logger.error({ result }, 'privacy body erasure retry still has failures');
        }
      },
    },
    {
      name: 'idempotency_sweep',
      everyMs: 6 * HOUR,
      run: async () => {
        const n = await sweepIdempotencyKeys();
        if (n) logger.info({ deleted: n }, 'swept expired idempotency keys');
      },
    },
    {
      name: 'metering_reconcile',
      everyMs: 12 * HOUR,
      run: async () => {
        const drift = await reconcileMetering();
        meteringDrift.set(drift.totalDrift);
        if (drift.totalDrift !== 0) {
          logger.warn({ drift }, 'metering drift detected — revenue leakage risk');
          // Persist to audit_log so ops can query it and set up alerts.
          await db.insertInto('audit_log').values({
            action: 'billing:reconciliation_drift',
            metadata: { total_drift: drift.totalDrift, by_customer: drift.byCustomer } as any,
            actor_type: 'system',
          } as any).execute();
          // Fire external alert webhook if configured.
          const alertUrl = process.env.BILLING_ALERT_WEBHOOK_URL;
          if (alertUrl) {
            try {
              assertPublicHttpUrl(alertUrl);
              await fetch(alertUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event: 'billing.reconciliation_drift', ...drift }),
              });
            } catch (err) {
              logger.error({ err, alertUrl }, 'billing alert webhook delivery failed');
            }
          }
        } else {
          logger.info('metering reconciliation clean — no drift');
        }
      },
    },
    {
      name: 'billing_dunning_sweep',
      everyMs: HOUR,
      run: async () => {
        const result = await runDunningSweep();
        if (result.sent || result.restricted) logger.warn({ result }, 'billing dunning actions applied');
        if (result.failed) logger.error({ result }, 'billing dunning notification failures');
      },
    },
    {
      name: 'billing_plan_change_expiry',
      everyMs: HOUR,
      run: async () => {
        const expired = await expirePlanChangeRequests();
        if (expired) logger.info({ expired }, 'expired stale billing plan-change previews');
      },
    },
    {
      name: 'billing_plan_change_reconcile',
      everyMs: 5 * MIN,
      run: async () => {
        const result = await reconcileSubmittedPlanChanges();
        if (result.applied) logger.info({ result }, 'reconciled provider-confirmed plan changes');
        if (result.failed || result.unsupported) logger.warn({ result }, 'plan-change reconciliation needs attention');
      },
    },
    {
      // Apply period-end downgrades once their scheduled effective date has
      // arrived. Runs every 10 minutes so an at-boundary downgrade takes effect
      // promptly after the period rolls over.
      name: 'billing_scheduled_downgrade_apply',
      everyMs: 10 * MIN,
      run: async () => {
        const result = await applyScheduledDowngrades();
        if (result.applied) logger.info({ result }, 'applied scheduled period-end downgrades');
        if (result.failed || result.unsupported) logger.warn({ result }, 'scheduled downgrade application needs attention');
      },
    },
    {
      // Operator SLA: surface plan-change requests that were submitted to the
      // provider but have not been applied/reconciled within the SLA window.
      // Publishes a gauge for Prometheus (BillingPlanChangeStuck alert) so a
      // human is paged instead of the request silently lingering forever.
      name: 'billing_plan_change_sla',
      everyMs: 5 * MIN,
      run: async () => {
        const slaMinutes = Number(process.env.BILLING_PLAN_CHANGE_SLA_MINUTES ?? 60);
        const stuck = await countStuckPlanChanges(slaMinutes);
        billingStuckRequests.set({ kind: 'plan_change_submitted' }, stuck);
        if (stuck) logger.error({ stuck, slaMinutes }, 'billing plan-change requests breached operator SLA');
      },
    },
    {
      // Expire elapsed JIT admin elevations (defence in depth — the effective
      // role lookup already filters on expires_at, this closes out the rows).
      name: 'admin_elevation_expiry',
      everyMs: 5 * MIN,
      run: async () => {
        const expired = await expireElevations();
        if (expired) logger.info({ expired }, 'expired admin elevations');
      },
    },
    {
      // Sign each audit chain's head and export the signed root to the WORM
      // sink, so a later DB rewrite is detectable against an external record.
      name: 'audit_checkpoint',
      everyMs: HOUR,
      run: async () => {
        const result = await checkpointAllAuditChains();
        if (result.signed) logger.info({ result }, 'signed audit chain checkpoints');
      },
    },
    {
      name: 'daily_retention',
      everyMs: 24 * HOUR,
      run: async () => {
        const result = await runRetention();
        logger.info({ result }, 'daily retention sweep complete');
      },
    },
    {
      name: 'postmaster_ingest',
      everyMs: 24 * HOUR,
      run: async () => {
        if (!process.env.GOOGLE_POSTMASTER_SA_KEY_JSON && !process.env.SNDS_API_KEY) {
          logger.debug('postmaster_ingest skipped: no credentials configured');
          return;
        }
        const result = await ingestPostmaster();
        logger.info({ result }, 'postmaster/SNDS ingestion complete');
      },
    },
    {
      name: 'volume_baseline_update',
      everyMs: HOUR,
      run: async () => {
        // Refresh rolling EMA baselines for all customers with recent activity
        // (last 2 days). Without this, vol:baseline stays 0 forever and anomaly
        // detection is permanently disabled.
        const active = await db
          .selectFrom('usage_daily')
          .select('customer_id')
          .distinct()
          .where(sql<boolean>`usage_date >= (CURRENT_DATE - 2)`)
          .execute();
        let updated = 0;
        for (const { customer_id } of active) {
          await updateVolumeBaseline(customer_id);
          updated++;
        }
        if (updated) logger.info({ updated }, 'volume baselines refreshed');
      },
    },
    {
      name: 'stale_send_recovery',
      // Every 10 minutes. A worker crash leaves the row at status='sending';
      // without this job it strands there forever. We reset it to 'queued' so
      // BullMQ retries pick it up on the next drain cycle.
      //
      // We key off `sending_at` (stamped by the send worker the moment it enters
      // the 'sending' state), NOT a trigger-managed updated_at — the latter
      // would be reset by the recovery UPDATE itself and by unrelated mutations,
      // so a stuck row would never look stale. We also defensively handle a NULL
      // sending_at (a 'sending' row that predates this column / was set without
      // the stamp) by treating it as stale, so nothing strands silently.
      everyMs: 10 * MIN,
      run: async () => {
        const recovered = await db
          .updateTable('messages')
          .set({ status: 'queued', failure_reason: 'stale_sending_reset', sending_at: null })
          .where('status', '=', 'sending')
          .where((eb) =>
            eb.or([
              eb('sending_at', 'is', null),
              sql<boolean>`messages.sending_at < NOW() - INTERVAL '10 minutes'`,
            ]),
          )
          .returning(['message_id', 'customer_id'])
          .execute();
        if (!recovered.length) return;
        logger.warn({ count: recovered.length, ids: recovered.map((r) => r.message_id) }, 'reset stale sending messages to queued');
        // Fire an event so the outbox drain re-queues them on the next tick.
        for (const r of recovered) {
          await eventsQueue.add('stale_send_recovered', {
            message_id: r.message_id,
            customer_id: r.customer_id,
            event_type: 'failed',
            payload: { reason: 'stale_sending_reset' },
          });
        }
      },
    },
    {
      name: 'review_queue_timeout',
      everyMs: HOUR,
      run: async () => {
        // Auto-reject messages that have been held in review for more than 24h
        // without admin action. Avoids silent build-up of stale held messages.
        const stale = await db
          .selectFrom('review_queue')
          .select(['id', 'message_id', 'customer_id'])
          .where('status', '=', 'pending')
          .where(sql<boolean>`created_at < NOW() - INTERVAL '24 hours'`)
          .execute();
        if (!stale.length) return;
        for (const item of stale) {
          await db.updateTable('messages')
            .set({ status: 'failed', failure_reason: 'review_timeout' })
            .where('message_id', '=', item.message_id)
            .execute();
          await db.updateTable('review_queue')
            .set({ status: 'rejected', reviewed_at: new Date() })
            .where('id', '=', item.id)
            .execute();
          await eventsQueue.add('review_rejected', {
            message_id: item.message_id,
            customer_id: item.customer_id,
            event_type: 'failed',
            payload: { reason: 'review_timeout' },
          });
        }
        logger.warn({ count: stale.length }, 'auto-rejected stale review queue items');
      },
    },
  ];

  const tick = async () => {
    const now = Date.now();
    for (const job of jobs) {
      if (job.last && now - job.last < job.everyMs) continue;
      job.last = now;
      try {
        const lock = await withSchedulerLock(job.name, job.run);
        if (!lock.ran) {
          logger.debug({ job: job.name }, 'scheduled job skipped; another replica owns lock');
        }
      } catch (err) {
        logger.error({ err, job: job.name }, 'scheduled job failed');
      }
    }
  };

  // Run on a 30-second heartbeat; each job self-throttles by everyMs.
  const interval = setInterval(() => void tick(), 30_000);
  // Kick a first pass shortly after boot (let DB/Redis settle).
  const kickoff = setTimeout(() => void tick(), 15_000);

  return {
    stop: () => {
      clearInterval(interval);
      clearTimeout(kickoff);
    },
  };
}

// keep db import referenced for tree-shaking safety in some bundlers
void db;
