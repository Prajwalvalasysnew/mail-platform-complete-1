import http from 'node:http';
import { pino } from 'pino';
import {
  closeDb,
  closeQueues,
  metricsText,
  metricsAuthorized,
  queueDepth,
  sendQueue,
  eventsQueue,
  webhooksQueue,
  enforceConfig,
  startTracing,
  stopTracing,
  redis,
  privacyLoggerOptions,
  preloadMasterKey,
} from '@platform/shared';
import { startSendWorker } from './send-worker.js';
import { startEventWorker } from './event-worker.js';
import { startWebhookWorker } from './webhook-worker.js';
import { startExportsWorker } from './exports-worker.js';
import { startWorkflowWorker } from './workflow-worker.js';
import { startScheduler } from './scheduler.js';

const logger = pino(privacyLoggerOptions());

// Global error handlers: keep the process alive on unhandled promise rejections
// (BullMQ handles job-level errors; crashing the worker loses in-flight state).
// uncaughtException leaves the process in undefined state, so exit there.
process.on('unhandledRejection', (reason) => {
  logger.error({ type: 'unhandledRejection', reason }, 'unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ type: 'uncaughtException', err }, 'uncaught exception — exiting');
  process.exit(1);
});

// Refuse to boot with default/insecure secrets in production.
enforceConfig(logger);
const keyPosture = await preloadMasterKey();
logger.info({ kms_provider: keyPosture.provider }, 'master encryption key preloaded');
startTracing('mail-worker');

const sendWorker = startSendWorker(logger);
const eventWorker = startEventWorker(logger);
const webhookWorker = startWebhookWorker(logger);
const exportsWorker = startExportsWorker(logger);
const workflowWorker = startWorkflowWorker(logger);
const scheduler = startScheduler(logger);

logger.info('Workers started: send, events, webhooks, exports, workflow (+ scheduler)');

let isShuttingDown = false;

// Expose /metrics for Prometheus
const metricsPort = Number(process.env.WORKER_METRICS_PORT ?? 9100);
const metricsServer = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url ?? '/', 'http://worker.local');
    if (parsedUrl.pathname === '/metrics') {
      const authorization = Array.isArray(req.headers.authorization)
        ? req.headers.authorization[0]
        : req.headers.authorization;
      const token = parsedUrl.searchParams.get('token') ?? undefined;
      if (!metricsAuthorized({ authorization, token })) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Content-Type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
      // Update queue depth gauges
      try {
        for (const [name, q] of [['send', sendQueue], ['events', eventsQueue], ['webhooks', webhooksQueue]] as const) {
          const counts = await q.getJobCounts('waiting', 'active', 'delayed');
          queueDepth.set({ queue: name }, (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0));
        }
      } catch (err) {
        logger.error({ err }, 'failed to update queue depth gauges');
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(await metricsText());
    } else if (req.url === '/health' || req.url === '/ready') {
      const checks: Record<string, { ok: boolean; error?: string }> = {};
      try { const pong = await redis.ping(); checks.redis = { ok: pong === 'PONG' }; }
      catch (err: any) { checks.redis = { ok: false, error: err?.message ?? 'unknown' }; }
      try { await sendQueue.getJobCounts('waiting'); checks.queue = { ok: true }; }
      catch (err: any) { checks.queue = { ok: false, error: err?.message ?? 'unknown' }; }
      // Signal load balancers to stop sending traffic as soon as shutdown begins.
      const shutting = isShuttingDown;
      const ok = !shutting && Object.values(checks).every((c) => c.ok);
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ok ? 'ok' : shutting ? 'shutting_down' : 'degraded', checks }));
    } else {
      res.writeHead(404);
      res.end();
    }
  } catch (err) {
    logger.error({ err }, 'metrics server error');
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    } catch {
      // ignore secondary errors
    }
  }
});
metricsServer.listen(metricsPort, () => logger.info(`Worker metrics on :${metricsPort}/metrics`));

// Daily warmup + reputation + reconciliation jobs run via the scheduler above.

const DRAIN_TIMEOUT_MS = Number(process.env.WORKER_DRAIN_TIMEOUT_MS ?? 30_000);

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down workers');
  // Signal health endpoint immediately so load balancers stop routing here.
  isShuttingDown = true;
  scheduler.stop();
  metricsServer.close();

  // Pause workers so no new jobs are picked up, then wait for in-flight
  // jobs to drain. A hard timeout prevents stalled jobs from blocking
  // the shutdown indefinitely (e.g. during a rolling deploy).
  await Promise.allSettled([
    sendWorker.pause(),
    eventWorker.pause(),
    webhookWorker.pause(),
    exportsWorker.pause(),
    workflowWorker.pause(),
  ]);

  const drainStart = Date.now();
  logger.info({ timeout_ms: DRAIN_TIMEOUT_MS }, 'draining in-flight jobs');

  let forceExitTimer: ReturnType<typeof setTimeout> | undefined;
  const forceExit = new Promise<void>((resolve) => {
    forceExitTimer = setTimeout(() => {
      logger.warn({ elapsed_ms: Date.now() - drainStart }, 'drain timeout exceeded — forcing exit');
      resolve();
    }, DRAIN_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      Promise.all([sendWorker.close(), eventWorker.close(), webhookWorker.close(), exportsWorker.close(), workflowWorker.close()]),
      forceExit,
    ]);
    if (forceExitTimer) clearTimeout(forceExitTimer);
    logger.info({ elapsed_ms: Date.now() - drainStart }, 'drain complete');
  } catch (err) {
    logger.error({ err }, 'error during worker drain');
  }

  await closeQueues();
  await closeDb();
  await stopTracing();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
