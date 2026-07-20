// End-to-end test harness.
//
// Boots the *real* Fastify API (same route modules used in production) and the
// real BullMQ send worker against a live Postgres + Redis, then drives the full
// pipeline over HTTP via Fastify's `inject`.
//
// All direct database access goes through @platform/shared's `testkit`, so every
// Kysely query object lives in shared's compiled realm.

import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { startSendWorker } from '@platform/worker/send-worker.js';
import { db, redis, sendQueue, metricsText } from '@platform/shared';

export {
  seedCustomer,
  seedVerifiedDomain,
  seedUnverifiedDomain,
  seedSuppression,
  getMessageStatus,
  getMessageRow,
  getEventTypes,
  getUsageSent,
  getTrackedLinkUrls,
  countMessagesTo,
  waitForStatus,
  resetQuota,
  resetPoolWarmup,
  seedMessages,
  getPoolAction,
  clearPoolMessages,
  seedDeliveredMessage,
  seedQueuedMessage,
  seedMessageEvent,
  seedAdminSession,
  getEngagement,
  getLatestEvent,
  type SeededCustomer,
} from '@platform/shared';

import { authPlugin } from '@platform/api/plugins/auth.js';
import { errorEnvelope } from '@platform/api/plugins/error-envelope.js';
import { sendRoutes } from '@platform/api/routes/send.js';
import { domainRoutes } from '@platform/api/routes/domains.js';
import { suppressionRoutes } from '@platform/api/routes/suppressions.js';
import { messageRoutes } from '@platform/api/routes/messages.js';
import { customerRoutes } from '@platform/api/routes/customers.js';
import { profileRoutes } from '@platform/api/routes/profile.js';
import { templateRoutes } from '@platform/api/routes/templates.js';
import { usageRoutes } from '@platform/api/routes/usage.js';
import { privacyRoutes } from '@platform/api/routes/privacy.js';
import { webhookRoutes } from '@platform/api/routes/webhooks.js';
import { adminRoutes } from '@platform/api/routes/admin.js';
import { scimRoutes } from '@platform/api/routes/scim.js';
import { accountRoutes } from '@platform/api/routes/account.js';
import { teamRoutes } from '@platform/api/routes/team.js';
import { keyRoutes } from '@platform/api/routes/keys.js';
import { accountWebhookRoutes } from '@platform/api/routes/account-webhooks.js';
import { accountDomainRoutes } from '@platform/api/routes/account-domains.js';
import { auditRoutes } from '@platform/api/routes/audit.js';
import { supportRoutes } from '@platform/api/routes/support.js';
import { accountBillingRoutes } from '@platform/api/routes/account-billing.js';
import { billingRoutes } from '@platform/api/routes/billing.js';
import { exportRoutes } from '@platform/api/routes/exports.js';
import { analyticsRoutes } from '@platform/api/routes/analytics.js';
import { workflowRoutes } from '@platform/api/routes/workflows.js';
import { toolRoutes } from '@platform/api/routes/tools.js';
import { sendgridCompatRoutes } from '@platform/api/routes/sendgrid-compat.js';
import { subaccountRoutes } from '@platform/api/routes/subaccounts.js';
import { dmarcRoutes } from '@platform/api/routes/dmarc.js';

export interface Harness {
  app: FastifyInstance;
  worker: ReturnType<typeof startSendWorker>;
  close(): Promise<void>;
}

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 10 * 1024 * 1024 });
  await app.register(errorEnvelope);
  await app.register(sensible);

  app.get('/live', async () => ({ status: 'ok' }));

  // Health / readiness probes — same logic as server.ts so integration tests
  // can exercise these endpoints without hitting the production server.
  async function checkDeps() {
    const checks: Record<string, { ok: boolean; error?: string }> = {};
    try { await db.selectFrom('customers').select(db.fn.countAll().as('c')).limit(1).execute(); checks.postgres = { ok: true }; }
    catch (err: any) { checks.postgres = { ok: false, error: err?.message }; }
    try { const pong = await redis.ping(); checks.redis = { ok: pong === 'PONG' }; }
    catch (err: any) { checks.redis = { ok: false, error: err?.message }; }
    try { await sendQueue.getJobCounts('waiting'); checks.queue = { ok: true }; }
    catch (err: any) { checks.queue = { ok: false, error: err?.message }; }
    return { ok: Object.values(checks).every((c) => c.ok), checks };
  }
  app.get('/health', async (_req, reply) => {
    const r = await checkDeps();
    reply.code(r.ok ? 200 : 503);
    return { status: r.ok ? 'ok' : 'degraded', ts: new Date().toISOString(), checks: r.checks };
  });
  app.get('/ready', async (_req, reply) => {
    const r = await checkDeps();
    reply.code(r.ok ? 200 : 503);
    return { status: r.ok ? 'ready' : 'not_ready', checks: r.checks };
  });
  app.get('/metrics', async (req, reply) => {
    const { metricsAuthorized } = await import('@platform/shared');
    if (!metricsAuthorized({ authorization: req.headers.authorization, token: (req.query as any)?.token })) {
      return reply.code(401).header('WWW-Authenticate', 'Bearer').send('unauthorized');
    }
    reply.header('Content-Type', 'text/plain');
    return metricsText();
  });

  // Mirror server.ts: security headers on every response.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-XSS-Protection', '0');
    reply.header('Content-Security-Policy', "default-src 'none'");
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    reply.header('X-Permitted-Cross-Domain-Policies', 'none');
    reply.header('Cache-Control', 'no-store');
    if (process.env.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }
  });

  await app.register(billingRoutes, { prefix: '/v1' });
  await app.register(customerRoutes, { prefix: '/v1' });
  await app.register(adminRoutes, { prefix: '/admin' });
  await app.register(scimRoutes);
  await app.register(accountRoutes, { prefix: '/v1' });
  await app.register(teamRoutes, { prefix: '/v1' });
  await app.register(keyRoutes, { prefix: '/v1' });
  await app.register(accountWebhookRoutes, { prefix: '/v1' });
  await app.register(accountDomainRoutes, { prefix: '/v1' });
  await app.register(auditRoutes, { prefix: '/v1' });
  await app.register(supportRoutes, { prefix: '/v1' });
  await app.register(accountBillingRoutes, { prefix: '/v1' });

  await app.register(async (instance) => {
    await instance.register(authPlugin);
    await instance.register(sendRoutes, { prefix: '/v1' });
    await instance.register(profileRoutes, { prefix: '/v1' });
    await instance.register(domainRoutes, { prefix: '/v1' });
    await instance.register(suppressionRoutes, { prefix: '/v1' });
    await instance.register(messageRoutes, { prefix: '/v1' });
    await instance.register(analyticsRoutes, { prefix: '/v1' });
    await instance.register(templateRoutes, { prefix: '/v1' });
    await instance.register(usageRoutes, { prefix: '/v1' });
    await instance.register(privacyRoutes, { prefix: '/v1' });
    await instance.register(webhookRoutes, { prefix: '/v1' });
    await instance.register(exportRoutes, { prefix: '/v1' });
    await instance.register(workflowRoutes, { prefix: '/v1' });
    await instance.register(toolRoutes, { prefix: '/v1' });
    await instance.register(subaccountRoutes, { prefix: '/v1' });
    await instance.register(dmarcRoutes, { prefix: '/v1' });
    await instance.register(sendgridCompatRoutes);
  });

  await app.ready();
  return app;
}

export async function startHarness(): Promise<Harness> {
  const app = await buildTestApp();
  const silent: any = {
    info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {},
    child() { return silent; },
  };
  const worker = startSendWorker(silent);
  await worker.waitUntilReady();
  return {
    app,
    worker,
    async close() {
      await worker.close();
      await app.close();
    },
  };
}
