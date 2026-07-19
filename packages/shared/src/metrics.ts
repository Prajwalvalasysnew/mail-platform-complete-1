// Prometheus metrics. Each service imports this and exposes /metrics.
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const messagesAccepted = new Counter({
  name: 'mp_messages_accepted_total',
  help: 'Messages accepted by the API',
  labelNames: ['customer_tier'],
  registers: [registry],
});

export const messagesSent = new Counter({
  name: 'mp_messages_sent_total',
  help: 'Messages handed to the delivery transport',
  labelNames: ['transport', 'ip_pool'],
  registers: [registry],
});

export const messagesDelivered = new Counter({
  name: 'mp_messages_delivered_total',
  help: 'Messages confirmed delivered',
  registers: [registry],
});

export const messagesBounced = new Counter({
  name: 'mp_messages_bounced_total',
  help: 'Messages bounced',
  labelNames: ['type'], // soft | hard
  registers: [registry],
});

export const complaintsTotal = new Counter({
  name: 'mp_complaints_total',
  help: 'FBL complaints received',
  registers: [registry],
});

export const messagesBlocked = new Counter({
  name: 'mp_messages_blocked_total',
  help: 'Messages blocked by abuse scanning',
  labelNames: ['reason'],
  registers: [registry],
});

export const sendDuration = new Histogram({
  name: 'mp_send_duration_seconds',
  help: 'Time to hand a message to the transport',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: 'mp_queue_depth',
  help: 'Current queue depth',
  labelNames: ['queue'],
  registers: [registry],
});

export const webhookDeliveries = new Counter({
  name: 'mp_webhook_deliveries_total',
  help: 'Webhook delivery attempts',
  labelNames: ['outcome'], // success | failure | blocked
  registers: [registry],
});

export const webhookDeliveryDuration = new Histogram({
  name: 'mp_webhook_delivery_duration_ms',
  help: 'Webhook delivery round-trip time in milliseconds',
  buckets: [50, 100, 250, 500, 1000, 3000, 10000],
  registers: [registry],
});

export const deadLetterTotal = new Counter({
  name: 'mp_dead_letter_total',
  help: 'Jobs moved to the dead-letter queue after exhausting retries',
  labelNames: ['source_queue'],
  registers: [registry],
});

export const dsnParseTotal = new Counter({
  name: 'mp_dsn_parse_total',
  help: 'Inbound DSN/ARF parse attempts',
  labelNames: ['type', 'outcome'], // type: dsn|arf|unknown, outcome: parsed|failed|forged
  registers: [registry],
});

export const poolPaused = new Gauge({
  name: 'mp_pool_paused',
  help: 'Whether an IP pool is currently paused by the reputation guard (1=paused)',
  labelNames: ['pool'],
  registers: [registry],
});

export const bounceRateGauge = new Gauge({
  name: 'mp_pool_bounce_rate',
  help: 'Rolling 24h hard-bounce rate per pool',
  labelNames: ['pool'],
  registers: [registry],
});

export const complaintRateGauge = new Gauge({
  name: 'mp_pool_complaint_rate',
  help: 'Rolling 24h complaint rate per pool',
  labelNames: ['pool'],
  registers: [registry],
});

export const blocklistListings = new Gauge({
  name: 'mp_blocklist_listings',
  help: 'Number of sending IPs currently listed on a DNSBL',
  labelNames: ['provider'],
  registers: [registry],
});

export const backpressureRejections = new Counter({
  name: 'mp_backpressure_rejections_total',
  help: 'Requests rejected with 503 due to queue backpressure',
  registers: [registry],
});

export const meteringDrift = new Gauge({
  name: 'mp_metering_drift',
  help: 'Difference between metered and billed email quantity per reconciliation',
  registers: [registry],
});

export const apiKeyVerifyDuration = new Histogram({
  name: 'mp_api_key_verify_seconds',
  help: 'Time to verify an API key on the auth hot path',
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1],
  registers: [registry],
});

export const engagementEvents = new Counter({
  name: 'mp_engagement_events_total',
  help: 'Open/click events classified by bot detection',
  labelNames: ['event_type', 'verdict'], // opened|clicked  x  human|bot|suspicious
  registers: [registry],
});

export const billingStuckRequests = new Gauge({
  name: 'mp_billing_stuck_requests',
  help: 'Billing requests past their operator SLA (submitted to a provider but not yet applied/reconciled)',
  labelNames: ['kind'], // plan_change_submitted
  registers: [registry],
});

export const retentionHeldSkipped = new Gauge({
  name: 'mp_retention_held_rows_skipped',
  help: 'Rows past their retention cutoff preserved by an active legal hold (last sweep)',
  registers: [registry],
});

export const eventsDefaultPartitionRows = new Gauge({
  name: 'mp_events_default_partition_rows',
  help: 'Rows in the events default partition (should be 0; >0 means partition pre-creation fell behind)',
  registers: [registry],
});

export const messagesDefaultPartitionRows = new Gauge({
  name: 'mp_messages_default_partition_rows',
  help: 'Rows in the messages default partition (should be 0; >0 means partition pre-creation fell behind)',
  registers: [registry],
});

export const pgPoolConnections = new Gauge({
  name: 'mp_pg_pool_connections',
  help: 'Postgres pool connections by state (total/idle/waiting)',
  labelNames: ['state'],
  registers: [registry],
});

export const acceptToHandoffSeconds = new Histogram({
  name: 'mp_accept_to_handoff_seconds',
  help: 'Latency from API accept (queued_at) to transport handoff, by priority lane',
  labelNames: ['lane'], // p1 (critical/enterprise) | p5 | p10
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 300, 900, 3600],
  registers: [registry],
});

export const workflowRunsStarted = new Counter({
  name: 'mp_workflow_runs_started_total',
  help: 'Workflow runs started',
  labelNames: ['trigger_source'],
  registers: [registry],
});

export const workflowRunsFinished = new Counter({
  name: 'mp_workflow_runs_finished_total',
  help: 'Workflow runs reaching a terminal state',
  labelNames: ['status'], // completed | goal_met | exited | failed | canceled
  registers: [registry],
});

export const workflowStepsExecuted = new Counter({
  name: 'mp_workflow_steps_executed_total',
  help: 'Workflow steps executed',
  labelNames: ['step_type', 'outcome'],
  registers: [registry],
});

export const workflowSweepRecovered = new Counter({
  name: 'mp_workflow_sweep_recovered_total',
  help: 'Workflow runs re-armed by durability sweeps (lost Redis jobs)',
  labelNames: ['kind'], // overdue_wake | stuck_running
  registers: [registry],
});

export async function metricsText(): Promise<string> {
  // Sample pool utilization at scrape time so every service reports its own
  // pool without needing a background sampler.
  const { poolStats } = await import('./db.js');
  const stats = poolStats();
  pgPoolConnections.set({ state: 'total' }, stats.total);
  pgPoolConnections.set({ state: 'idle' }, stats.idle);
  pgPoolConnections.set({ state: 'waiting' }, stats.waiting);
  return registry.metrics();
}

/**
 * Authorize a /metrics scrape request.
 *
 * Prometheus metrics include per-customer operational data (send volumes, bounce
 * and complaint rates, queue depth) and must not be world-readable. When
 * METRICS_TOKEN is set, callers must present it via `Authorization: Bearer
 * <token>` or `?token=<token>`. When it is unset, we allow scrapes in
 * development/test for convenience but FAIL CLOSED in production — the same
 * posture as the billing webhook verifiers.
 *
 * Returns true if the request may read metrics.
 */
export function metricsAuthorized(opts: { authorization?: string; token?: string }): boolean {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) {
    // No token configured: allow outside production, deny in production.
    return process.env.NODE_ENV !== 'production';
  }
  let presented: string | undefined;
  if (opts.authorization) {
    const m = /^Bearer\s+(.+)$/i.exec(opts.authorization.trim());
    presented = m ? m[1] : opts.authorization.trim();
  } else if (opts.token) {
    presented = opts.token;
  }
  if (!presented) return false;
  // Constant-time comparison to avoid leaking the token via timing.
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return cryptoTimingSafeEqual(a, b);
}
