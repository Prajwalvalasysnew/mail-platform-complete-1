import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import crypto from 'node:crypto';
import { redis, closeDb, closeQueues, metricsText, metricsAuthorized, enforceConfig, db, sendQueue, openapiSpec, startTracing, stopTracing, rlsIsEnforced, privacyLoggerOptions } from '@platform/shared';

startTracing('mail-api');
import { authPlugin } from './plugins/auth.js';
import { errorEnvelope } from './plugins/error-envelope.js';
import { sendRoutes } from './routes/send.js';
import { domainRoutes } from './routes/domains.js';
import { suppressionRoutes } from './routes/suppressions.js';
import { messageRoutes } from './routes/messages.js';
import { customerRoutes } from './routes/customers.js';
import { profileRoutes } from './routes/profile.js';
import { webhookRoutes } from './routes/webhooks.js';
import { scimRoutes } from './routes/scim.js';
import { templateRoutes } from './routes/templates.js';
import { usageRoutes } from './routes/usage.js';
import { analyticsRoutes } from './routes/analytics.js';
import { exportRoutes } from './routes/exports.js';
import { billingRoutes } from './routes/billing.js';
import { privacyRoutes } from './routes/privacy.js';
import { adminRoutes } from './routes/admin.js';
import { accountRoutes } from './routes/account.js';
import { teamRoutes } from './routes/team.js';
import { keyRoutes } from './routes/keys.js';
import { accountWebhookRoutes } from './routes/account-webhooks.js';
import { accountDomainRoutes } from './routes/account-domains.js';
import { auditRoutes } from './routes/audit.js';
import { supportRoutes } from './routes/support.js';
import { accountBillingRoutes } from './routes/account-billing.js';
import { workflowRoutes } from './routes/workflows.js';
import { toolRoutes } from './routes/tools.js';
import { sendgridCompatRoutes } from './routes/sendgrid-compat.js';
import { subaccountRoutes } from './routes/subaccounts.js';
import { dmarcRoutes } from './routes/dmarc.js';

const PORT = Number(process.env.API_PORT ?? 3000);
const HOST = process.env.API_HOST ?? '0.0.0.0';

// Refuse to boot with default/insecure secrets in production.
enforceConfig();

const app = Fastify({
  logger: {
    ...privacyLoggerOptions(),
    transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
  },
  // Honor any X-Request-ID the client sends (up to 200 chars), generate a UUID
  // otherwise. Fastify binds this to req.id, which pino includes as "reqId" in
  // every log line for that request — no manual child-logger binding needed.
  genReqId: (req) => {
    const h = req.headers['x-request-id'];
    if (typeof h === 'string' && h.trim().length > 0 && h.trim().length <= 200) return h.trim();
    return crypto.randomUUID();
  },
  trustProxy: true,
  bodyLimit: 10 * 1024 * 1024,
  // Message IDs include the verified sender domain and can legitimately exceed
  // Fastify's 100-character default route-parameter limit. DNS names can be up
  // to 253 characters, so leave room for the random local part and encoding.
  routerOptions: { maxParamLength: 512 },
});

await app.register(errorEnvelope);
await app.register(sensible);

// CORS: lock to an explicit allowlist (CORS_ALLOWED_ORIGINS, comma-separated).
// For pure server-to-server API-key usage, CORS is irrelevant; we only reflect
// configured dashboard origins and never reflect arbitrary origins.
const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
await app.register(cors, {
  origin: corsOrigins.length > 0 ? corsOrigins : false,
  credentials: false,
});

// Layered rate limiting. A global per-key cap, plus a heavier per-endpoint cap
// on /v1/send (sending is far more expensive than listing). Returns
// Retry-After + X-RateLimit-* headers automatically.
await app.register(rateLimit, {
  global: true,
  max: Number(process.env.API_RATE_LIMIT_PER_MINUTE ?? 1000),
  timeWindow: '1 minute',
  redis,
  skipOnError: true,
  keyGenerator: (req) => (req as any).auth?.api_key_id ?? (req as any).auth?.customer_id ?? req.ip,
  addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
  errorResponseBuilder: (_req, ctx) => ({
    statusCode: 429,
    error: 'rate_limited',
    message: `Rate limit exceeded. Retry in ${Math.ceil(ctx.ttl / 1000)}s.`,
    retry_after: Math.ceil(ctx.ttl / 1000),
  }),
});

// Security headers on every response. Not a substitute for TLS termination
// at the ingress, but adds defense-in-depth for browser/SDK clients.
app.addHook('onSend', async (_req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('X-XSS-Protection', '0');  // modern browsers ignore it; 0 disables broken IE mode
  reply.header('Content-Security-Policy', "default-src 'none'");
  reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  reply.header('X-Permitted-Cross-Domain-Policies', 'none');
  reply.header('Cache-Control', 'no-store');
  if (process.env.NODE_ENV === 'production') {
    reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
});

// Liveness: process is up. Cheap, no dependencies.
app.get('/live', async () => ({ status: 'ok' }));

// Readiness / health: verify critical dependencies are reachable.
async function checkDependencies() {
  const checks: Record<string, { ok: boolean; error?: string }> = {};

  // Postgres
  try {
    await db.selectFrom('customers').select(db.fn.countAll().as('c')).limit(1).execute();
    checks.postgres = { ok: true };
  } catch (err: any) {
    checks.postgres = { ok: false, error: err?.message ?? 'unknown' };
  }

  // Redis
  try {
    const pong = await redis.ping();
    checks.redis = { ok: pong === 'PONG' };
  } catch (err: any) {
    checks.redis = { ok: false, error: err?.message ?? 'unknown' };
  }

  // Send queue reachable (BullMQ over Redis)
  try {
    await sendQueue.getJobCounts('waiting');
    checks.queue = { ok: true };
  } catch (err: any) {
    checks.queue = { ok: false, error: err?.message ?? 'unknown' };
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return { ok, checks };
}

app.get('/health', async (_req, reply) => {
  const result = await checkDependencies();
  reply.code(result.ok ? 200 : 503);
  return { status: result.ok ? 'ok' : 'degraded', ts: new Date().toISOString(), checks: result.checks };
});

app.get('/ready', async (_req, reply) => {
  const result = await checkDependencies();
  reply.code(result.ok ? 200 : 503);
  return { status: result.ok ? 'ready' : 'not_ready', checks: result.checks };
});

app.get('/metrics', async (req, reply) => {
  if (!metricsAuthorized({ authorization: req.headers.authorization, token: (req.query as any)?.token })) {
    return reply.code(401).header('WWW-Authenticate', 'Bearer').send('unauthorized');
  }
  reply.header('Content-Type', 'text/plain');
  return metricsText();
});

// Published OpenAPI spec for typed SDKs + contract tests.
app.get('/openapi.json', async () => openapiSpec);

// API versioning: advertise the deprecation policy via a Sunset header hook.
// (No version is currently deprecated; this is the mechanism for when one is.)
const SUNSET_DATE = process.env.V1_SUNSET_DATE; // RFC 1123 date, e.g. "Wed, 31 Dec 2025 23:59:59 GMT"
if (SUNSET_DATE) {
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/v1/')) {
      reply.header('Sunset', SUNSET_DATE);
      reply.header('Deprecation', 'true');
      reply.header('Link', '</docs/API.md>; rel="deprecation"');
    }
    return payload;
  });
}

// Billing webhook is public (verified by signature), registered before auth
await app.register(billingRoutes, { prefix: '/v1' });

// Customer signup is public
await app.register(customerRoutes, { prefix: '/v1' });

// Human auth plane (register/login/MFA/sessions) and teammate management.
// These authenticate via their own session-bearer tokens (mpu_...), not API
// keys, so they're registered outside the API-key auth scope.
await app.register(accountRoutes, { prefix: '/v1' });
await app.register(teamRoutes, { prefix: '/v1' });
await app.register(keyRoutes, { prefix: '/v1' });
await app.register(accountWebhookRoutes, { prefix: '/v1' });
await app.register(accountDomainRoutes, { prefix: '/v1' });
await app.register(auditRoutes, { prefix: '/v1' });
await app.register(supportRoutes, { prefix: '/v1' });
await app.register(accountBillingRoutes, { prefix: '/v1' });

// Admin plane: separate auth (admin session token), registered as its own scope.
await app.register(adminRoutes, { prefix: '/admin' });

// SCIM 2.0 provisioning plane: per-tenant bearer-token auth, own /scim/v2 base.
await app.register(scimRoutes);

// Authenticated routes
await app.register(async (instance) => {
  await instance.register(authPlugin);
  await instance.register(sendRoutes, { prefix: '/v1' });
  await instance.register(profileRoutes, { prefix: '/v1' });
  await instance.register(domainRoutes, { prefix: '/v1' });
  await instance.register(suppressionRoutes, { prefix: '/v1' });
  await instance.register(messageRoutes, { prefix: '/v1' });
  await instance.register(webhookRoutes, { prefix: '/v1' });
  await instance.register(templateRoutes, { prefix: '/v1' });
  await instance.register(usageRoutes, { prefix: '/v1' });
  await instance.register(analyticsRoutes, { prefix: '/v1' });
  await instance.register(privacyRoutes, { prefix: '/v1' });
  await instance.register(exportRoutes, { prefix: '/v1' });
  await instance.register(workflowRoutes, { prefix: '/v1' });
  await instance.register(toolRoutes, { prefix: '/v1' });
  await instance.register(subaccountRoutes, { prefix: '/v1' });
  await instance.register(dmarcRoutes, { prefix: '/v1' });
  // SendGrid v3 migration shim (absolute /v3 path; auth + all controls apply).
  await instance.register(sendgridCompatRoutes);
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await closeQueues();
    await closeDb();
    await stopTracing();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown error');
    process.exit(1);
  }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  // Tenant-isolation posture check: RLS is the second line of defense behind
  // application-level customer_id filters, but it silently does NOTHING if the
  // API connects as a superuser / BYPASSRLS role. In production, refuse to
  // boot in that state instead of running with imaginary protection.
  if (process.env.NODE_ENV === 'production') {
    const rlsOk = await rlsIsEnforced();
    if (!rlsOk) {
      app.log.fatal(
        'Refusing to start: the API database role or fail-closed RLS policy posture ' +
          'could not be verified. Connect the API with a dedicated non-superuser, ' +
          'non-BYPASSRLS role and apply migration 043 (workers/migrations must use a ' +
          'separate service role). Set RLS_ALLOW_BYPASS=true only to consciously accept this risk.'
      );
      if (process.env.RLS_ALLOW_BYPASS !== 'true') process.exit(1);
    }
  }
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`API listening on http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
