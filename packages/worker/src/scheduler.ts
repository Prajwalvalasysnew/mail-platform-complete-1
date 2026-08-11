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
  drainStalePendingExports,
  clearExpiredWebhookRotationSecrets,
  withSchedulerLock,
  poolPaused,
  bounceRateGauge,
  complaintRateGauge,
  blocklistListings,
  meteringDrift,
  runRetentionWithEvidence,
  collectMonthlyControlEvidence,
  retentionHeldSkipped,
  ensureEventPartitions,
  sweepExpiredEventPartitions,
  countDefaultPartitionRows,
  eventsDefaultPartitionRows,
  ensureMessagePartitions,
  sweepExpiredMessagePartitions,
  countMessageDefaultPartitionRows,
  messagesDefaultPartitionRows,
  assertPublicHttpUrl,
  ingestPostmaster,
  updateVolumeBaseline,
  eventsQueue,
  retryPendingBodyErasures,
  sweepSenderHealth,
  runDunningSweep,
  expirePlanChangeRequests,
  reconcileSubmittedPlanChanges,
  applyScheduledDowngrades,
  countStuckPlanChanges,
  billingStuckRequests,
  checkpointAllAuditChains,
  expireElevations,
  sweepOverdueWorkflowRuns,
  recoverStuckWorkflowRuns,
  sweepFinishedWorkflowRuns,
  runUnsubscribeMonitor,
} from '@platform/shared';

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<void>;
  last?: number;
}

// Auditable scheduler inventory. Keep this explicit so release tests and
// operational documentation can prove that every periodic control is still
// present. startScheduler validates the runtime list against it on boot.
export const SCHEDULER_JOB_NAMES = [
  'send_outbox_drain',
  'export_drain',
  'webhook_secret_rotation_cleanup',
  'reputation_guard',
  'blocklist_monitor',
  'warmup_advance',
  'dkim_retire',
  'clickhouse_reconcile',
  'privacy_erasure_retry',
  'canspam_unsubscribe_monitor',
  'idempotency_sweep',
  'metering_reconcile',
  'sender_health_sweep',
  'billing_dunning_sweep',
  'billing_plan_change_expiry',
  'billing_plan_change_reconcile',
  'billing_scheduled_downgrade_apply',
  'billing_plan_change_sla',
  'admin_elevation_expiry',
  'audit_checkpoint',
  'partition_maintenance',
  'daily_retention',
  'control_evidence_collection',
  'postmaster_ingest',
  'volume_baseline_update',
  'stale_send_recovery',
  'workflow_run_sweep',
  'workflow_run_retention',
  'review_queue_timeout',
] as const;

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
      // Rescue export rows whose enqueue never reached Redis (blip/crash).
      name: 'export_drain',
      everyMs: 5 * MIN,
      run: async () => {
        const n = await drainStalePendingExports();
        if (n) logger.info({ enqueued: n }, 're-enqueued stale pending exports');
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
      // CANSPAM-05: synthetic unsubscribe monitoring. Validates sampled
      // commercial-message unsubscribe chains across the 30-day window,
      // exercises the real one-click suppression write with a synthetic
      // recipient, and cross-checks opt-outs against enforced suppressions.
      // 6-hourly, so a broken unsubscribe path is caught same-day and the
      // evidence trail shows multiple daily checks.
      name: 'canspam_unsubscribe_monitor',
      everyMs: 6 * HOUR,
      run: async () => {
        const result = await runUnsubscribeMonitor();
        if (result.failures > 0 || result.slaViolations > 0) {
          logger.error({ result }, 'CAN-SPAM unsubscribe monitor FAILURES — opt-out path may be broken');
        } else {
          logger.info({ result }, 'CAN-SPAM unsubscribe monitor clean');
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
      // CANSPAM-08: per-sender complaint/bounce monitoring with automated
      // holds. Daily rather than hourly — the rates are computed over a
      // rolling multi-day window, so sweeping more often would re-derive the
      // same verdict and add nothing but reviewer noise.
      name: 'sender_health_sweep',
      everyMs: 24 * HOUR,
      run: async () => {
        const result = await sweepSenderHealth();
        if (result.held) logger.warn({ result }, 'CANSPAM-08: senders placed on hold pending review');
        else if (result.watch) logger.info({ result }, 'CANSPAM-08: senders over the warning threshold');
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
      // Export complete audit segments and signed chain heads to the
      // independently administered WORM sink. Keep the exposure window short:
      // production defaults to five minutes and may lower it further.
      name: 'audit_checkpoint',
      everyMs: Number(process.env.AUDIT_WORM_EXPORT_INTERVAL_MS ?? 5 * MIN),
      run: async () => {
        const result = await checkpointAllAuditChains();
        if (result.signed) logger.info({ result }, 'signed audit chain checkpoints');
      },
    },
    {
      // Monthly-partitioned events table upkeep: pre-create partitions a few
      // months ahead, drop months fully past retention (hold-aware; O(1)
      // instead of row deletes), and alert if rows ever land in the default
      // partition (means pre-creation fell behind).
      name: 'partition_maintenance',
      everyMs: 6 * HOUR,
      run: async () => {
        const monthsAhead = Number(process.env.EVENT_PARTITION_MONTHS_AHEAD ?? 3);
        const created = [
          ...(await ensureEventPartitions(monthsAhead)),
          ...(await ensureMessagePartitions(monthsAhead)),
        ];
        if (created.length) logger.info({ created }, 'created future partitions');

        for (const [table, sweep] of [
          ['events', await sweepExpiredEventPartitions()],
          ['messages', await sweepExpiredMessagePartitions()],
        ] as const) {
          if (sweep.dropped.length) logger.info({ table, dropped: sweep.dropped }, 'dropped expired partitions');
          if (sweep.held.length) {
            logger.warn({ table, held: sweep.held }, 'expired partitions kept: rows under active legal hold');
          }
        }

        const eventDefaultRows = await countDefaultPartitionRows();
        const messageDefaultRows = await countMessageDefaultPartitionRows();
        eventsDefaultPartitionRows.set(eventDefaultRows);
        messagesDefaultPartitionRows.set(messageDefaultRows);
        if (eventDefaultRows > 0 || messageDefaultRows > 0) {
          logger.error(
            { eventDefaultRows, messageDefaultRows },
            'default partition has rows — partition pre-creation fell behind',
          );
        }
      },
    },
    {
      name: 'daily_retention',
      everyMs: 24 * HOUR,
      run: async () => {
        // ...WithEvidence records the run in retention_runs (SOC2-06). The
        // failure mode this guards is silence: a sweep that stops running
        // looks exactly like a sweep with nothing to do, while data
        // accumulates past its window.
        const result = await runRetentionWithEvidence();
        retentionHeldSkipped.set(result.held_rows_skipped);
        if (result.held_rows_skipped > 0) {
          logger.warn({ held_rows_skipped: result.held_rows_skipped }, 'retention preserved rows under active legal hold');
        }
        logger.info({ result }, 'daily retention sweep complete');
      },
    },
    {
      // SOC2-06: collect control evidence for the previous complete calendar
      // month. Ticks daily but writes at most once per month — the helper
      // returns null when the period is already on file, so a nightly tick
      // does not overwrite a reviewer's sign-off.
      name: 'control_evidence_collection',
      everyMs: 24 * HOUR,
      run: async () => {
        const collected = await collectMonthlyControlEvidence();
        if (!collected) return;
        const gaps = collected.evidence.filter((e) => e.completeness !== 'complete');
        if (gaps.length) {
          // A 'missing' verdict means a control produced no evidence at all,
          // which is the finding an auditor opens with.
          logger.warn(
            { gaps: gaps.map((g) => ({ control: g.control_id, completeness: g.completeness, notes: g.notes })) },
            'SOC2-06: control evidence collected with gaps',
          );
        } else {
          logger.info({ controls: collected.evidence.length }, 'SOC2-06: control evidence collected clean');
        }
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
      // Workflow durability sweeps. BullMQ jobs are the fast path for run
      // wakeups; workflow_runs.wake_at is the durable truth. This re-arms
      // waiting runs whose delayed Redis job was lost (flush/failover) and
      // re-enqueues 'running' runs stranded between a DB transition and the
      // Redis add — the workflow analog of send_outbox drain/reclaim.
      name: 'workflow_run_sweep',
      everyMs: MIN,
      run: async () => {
        const rearmed = await sweepOverdueWorkflowRuns();
        if (rearmed) logger.warn({ rearmed }, 're-armed overdue workflow runs (lost wake jobs)');
        const recovered = await recoverStuckWorkflowRuns();
        if (recovered) logger.warn({ recovered }, 're-enqueued stuck running workflow runs');
      },
    },
    {
      // Age out finished workflow runs past the retention window; aggregate
      // reporting lives on in workflow_step_stats, which is never swept.
      name: 'workflow_run_retention',
      everyMs: 24 * HOUR,
      run: async () => {
        const purged = await sweepFinishedWorkflowRuns();
        if (purged) logger.info({ purged }, 'workflow run retention sweep complete');
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

  const runtimeNames = jobs.map((job) => job.name);
  if (
    runtimeNames.length !== SCHEDULER_JOB_NAMES.length ||
    runtimeNames.some((name, index) => name !== SCHEDULER_JOB_NAMES[index])
  ) {
    throw new Error(
      `Scheduler inventory drift: expected ${SCHEDULER_JOB_NAMES.join(',')}; got ${runtimeNames.join(',')}`,
    );
  }

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
