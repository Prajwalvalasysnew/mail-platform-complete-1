// SMTP gateway service entrypoint.
//
// Listens on SMTP_GATEWAY_PORT (default 587) for authenticated customer
// submissions and feeds them into the platform send pipeline. TLS: provide
// SMTP_TLS_KEY_FILE / SMTP_TLS_CERT_FILE to enable STARTTLS (and require it
// for AUTH); without certs the gateway refuses to boot in production unless
// SMTP_ALLOW_INSECURE_AUTH=true is set explicitly (plaintext credentials on
// the wire are never an accident we allow silently).

import { readFileSync } from 'node:fs';
import http from 'node:http';
import { SMTPServer, type SMTPServerSession } from 'smtp-server';
import { pino } from 'pino';
import {
  closeDb,
  closeQueues,
  enforceConfig,
  metricsText,
  metricsAuthorized,
  privacyLoggerOptions,
  smtpGatewayActiveConnections,
  smtpGatewayThrottled,
} from '@platform/shared';
import {
  authenticateSmtp,
  assertVerifiedSender,
  acceptSmtpMessage,
  consumeSmtpRateLimit,
  enforceSmtpCustomerRate,
  SmtpReject,
  type SmtpAuthContext,
} from './gateway.js';

const logger = pino(privacyLoggerOptions());
enforceConfig(logger);

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const PORT = positiveIntEnv('SMTP_GATEWAY_PORT', 587);
const HOST = process.env.SMTP_GATEWAY_HOST ?? '0.0.0.0';
const MAX_SIZE = positiveIntEnv('SMTP_MAX_MESSAGE_BYTES', 15 * 1024 * 1024);
const MAX_CLIENTS = positiveIntEnv('SMTP_MAX_CLIENTS', 1000);
const MAX_RECIPIENTS = positiveIntEnv('SMTP_MAX_RECIPIENTS', 100);
const MAX_MESSAGES_PER_CONNECTION = positiveIntEnv('SMTP_MAX_MESSAGES_PER_CONNECTION', 100);
const IP_CONNECTIONS_PER_MINUTE = positiveIntEnv('SMTP_IP_CONNECTIONS_PER_MINUTE', 120);
const SOCKET_TIMEOUT_MS = positiveIntEnv('SMTP_SOCKET_TIMEOUT_MS', 5 * 60_000);
const CLOSE_TIMEOUT_MS = positiveIntEnv('SMTP_CLOSE_TIMEOUT_MS', 10_000);

const keyFile = process.env.SMTP_TLS_KEY_FILE;
const certFile = process.env.SMTP_TLS_CERT_FILE;
const hasTls = !!(keyFile && certFile);

if (!hasTls && process.env.NODE_ENV === 'production' && process.env.SMTP_ALLOW_INSECURE_AUTH !== 'true') {
  logger.fatal('SMTP gateway refuses to start without TLS certs in production (set SMTP_TLS_KEY_FILE/SMTP_TLS_CERT_FILE, or SMTP_ALLOW_INSECURE_AUTH=true to consciously accept plaintext auth).');
  process.exit(1);
}

export interface SmtpServerLimitOverrides {
  maxClients?: number;
  maxRecipients?: number;
  maxMessagesPerConnection?: number;
  ipConnectionsPerMinute?: number;
  socketTimeoutMs?: number;
  closeTimeoutMs?: number;
}

export function buildSmtpServer(overrides: SmtpServerLimitOverrides = {}): SMTPServer {
  const limits = {
    maxClients: overrides.maxClients ?? MAX_CLIENTS,
    maxRecipients: overrides.maxRecipients ?? MAX_RECIPIENTS,
    maxMessagesPerConnection: overrides.maxMessagesPerConnection ?? MAX_MESSAGES_PER_CONNECTION,
    ipConnectionsPerMinute: overrides.ipConnectionsPerMinute ?? IP_CONNECTIONS_PER_MINUTE,
    socketTimeoutMs: overrides.socketTimeoutMs ?? SOCKET_TIMEOUT_MS,
    closeTimeoutMs: overrides.closeTimeoutMs ?? CLOSE_TIMEOUT_MS,
  };
  const messagesBySession = new WeakMap<object, number>();
  return new SMTPServer({
    name: process.env.SMTP_GATEWAY_HOSTNAME ?? undefined,
    banner: 'Mail Platform SMTP relay',
    size: MAX_SIZE,
    maxClients: limits.maxClients,
    socketTimeout: limits.socketTimeoutMs,
    closeTimeout: limits.closeTimeoutMs,
    authMethods: ['PLAIN', 'LOGIN'],
    // Without TLS configured we still allow AUTH (dev/test; prod is gated above).
    allowInsecureAuth: true,
    disabledCommands: hasTls ? [] : ['STARTTLS'],
    ...(hasTls
      ? { key: readFileSync(keyFile!), cert: readFileSync(certFile!) }
      : {}),

    async onConnect(session, callback) {
      try {
        const allowed = await consumeSmtpRateLimit(
          'ipconn',
          session.remoteAddress ?? 'unknown',
          limits.ipConnectionsPerMinute,
        );
        if (!allowed) {
          smtpGatewayThrottled.inc({ reason: 'ip_connection_rate' });
          return callback(Object.assign(new Error('Too many SMTP connections from this address. Retry shortly.'), { responseCode: 421 }));
        }
        messagesBySession.set(session, 0);
        smtpGatewayActiveConnections.inc();
        callback();
      } catch (err) {
        // Authentication and quota also depend on Redis, but a transient
        // limiter failure should not turn every incoming connection into an
        // outage. maxClients and socketTimeout still provide local protection.
        smtpGatewayThrottled.inc({ reason: 'limiter_unavailable' });
        logger.warn({ err }, 'SMTP IP connection limiter unavailable; allowing connection under local caps');
        messagesBySession.set(session, 0);
        smtpGatewayActiveConnections.inc();
        callback();
      }
    },

    onClose(session) {
      if (messagesBySession.delete(session)) smtpGatewayActiveConnections.dec();
    },

    async onAuth(auth, session, callback) {
      try {
        const ctx = await authenticateSmtp(auth.password ?? '', session.remoteAddress ?? 'unknown');
        callback(null, { user: ctx as unknown as string });
      } catch (err: any) {
        callback(err);
      }
    },

    async onMailFrom(address, session, callback) {
      const ctx = session.user as unknown as SmtpAuthContext | undefined;
      if (!ctx) return callback(Object.assign(new Error('Authentication required'), { responseCode: 530 }));
      try {
        // Normalized verified sender is re-derived in onData from the envelope.
        await assertVerifiedSender(ctx, address.address);
        callback();
      } catch (err: any) {
        callback(err);
      }
    },

    onRcptTo(_address, session, callback) {
      if (session.envelope.rcptTo.length >= limits.maxRecipients) {
        smtpGatewayThrottled.inc({ reason: 'recipient_cap' });
        return callback(Object.assign(new Error(`Too many recipients (max ${limits.maxRecipients} per message)`), { responseCode: 452 }));
      }
      callback();
    },

    async onData(stream, session: SMTPServerSession, callback) {
      const ctx = session.user as unknown as SmtpAuthContext | undefined;
      if (!ctx) return callback(Object.assign(new Error('Authentication required'), { responseCode: 530 }));

      const messageCount = (messagesBySession.get(session) ?? 0) + 1;
      messagesBySession.set(session, messageCount);
      if (messageCount > limits.maxMessagesPerConnection) {
        smtpGatewayThrottled.inc({ reason: 'connection_message_cap' });
        stream.resume();
        return callback(Object.assign(new Error(`Too many messages on one connection (max ${limits.maxMessagesPerConnection})`), { responseCode: 421 }));
      }
      try {
        await enforceSmtpCustomerRate(ctx);
      } catch (err: any) {
        if (!(err instanceof SmtpReject)) smtpGatewayThrottled.inc({ reason: 'limiter_unavailable' });
        stream.resume();
        return callback(Object.assign(new Error(err.message), { responseCode: err.responseCode ?? 451 }));
      }

      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', async () => {
        try {
          if (stream.sizeExceeded) {
            return callback(Object.assign(new Error('Message exceeds size limit'), { responseCode: 552 }));
          }
          const envelopeFrom = session.envelope.mailFrom && session.envelope.mailFrom.address.toLowerCase();
          if (!envelopeFrom) {
            return callback(Object.assign(new Error('Missing MAIL FROM'), { responseCode: 503 }));
          }
          const recipients = session.envelope.rcptTo.map((r) => r.address);
          const result = await acceptSmtpMessage(ctx, envelopeFrom, recipients, Buffer.concat(chunks));
          callback(null, `250 2.0.0 Accepted ${result.accepted} recipient(s)${result.suppressed ? `, ${result.suppressed} suppressed` : ''}${result.message_ids[0] ? ` id=${result.message_ids[0]}` : ''}`);
        } catch (err: any) {
          if (err instanceof SmtpReject) {
            return callback(Object.assign(new Error(err.message), { responseCode: err.responseCode }));
          }
          logger.error({ err }, 'smtp accept failed');
          callback(Object.assign(new Error('Temporary internal error, try again later'), { responseCode: 451 }));
        }
      });
    },
  });
}

// Boot only when run as a service (tests import buildSmtpServer instead).
if (process.env.SMTP_GATEWAY_AUTOSTART !== 'false') {
  const server = buildSmtpServer();
  server.on('error', (err) => logger.error({ err }, 'smtp server error'));
  server.listen(PORT, HOST, () => logger.info(`SMTP gateway listening on ${HOST}:${PORT} (tls=${hasTls})`));

  // Prometheus metrics endpoint (same auth as the other services).
  const metricsPort = Number(process.env.SMTP_GATEWAY_METRICS_PORT ?? 9102);
  const metricsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://smtp-gateway.local');
    if (url.pathname === '/metrics') {
      const authorization = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
      if (!metricsAuthorized({ authorization, token: url.searchParams.get('token') ?? undefined })) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
        return res.end('unauthorized');
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(await metricsText());
    }
    if (url.pathname === '/health' || url.pathname === '/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    res.writeHead(404);
    res.end();
  });
  metricsServer.listen(metricsPort, () => logger.info(`SMTP gateway metrics on :${metricsPort}/metrics`));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down smtp gateway');
    metricsServer.close();
    server.close(async () => {
      await closeQueues();
      await closeDb();
      process.exit(0);
    });
    // Hard exit if lingering connections block close.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
