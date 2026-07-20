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
} from '@platform/shared';
import { authenticateSmtp, assertVerifiedSender, acceptSmtpMessage, SmtpReject, type SmtpAuthContext } from './gateway.js';

const logger = pino(privacyLoggerOptions());
enforceConfig(logger);

const PORT = Number(process.env.SMTP_GATEWAY_PORT ?? 587);
const HOST = process.env.SMTP_GATEWAY_HOST ?? '0.0.0.0';
const MAX_SIZE = Number(process.env.SMTP_MAX_MESSAGE_BYTES ?? 15 * 1024 * 1024);

const keyFile = process.env.SMTP_TLS_KEY_FILE;
const certFile = process.env.SMTP_TLS_CERT_FILE;
const hasTls = !!(keyFile && certFile);

if (!hasTls && process.env.NODE_ENV === 'production' && process.env.SMTP_ALLOW_INSECURE_AUTH !== 'true') {
  logger.fatal('SMTP gateway refuses to start without TLS certs in production (set SMTP_TLS_KEY_FILE/SMTP_TLS_CERT_FILE, or SMTP_ALLOW_INSECURE_AUTH=true to consciously accept plaintext auth).');
  process.exit(1);
}

export function buildSmtpServer(): SMTPServer {
  return new SMTPServer({
    name: process.env.SMTP_GATEWAY_HOSTNAME ?? undefined,
    banner: 'Mail Platform SMTP relay',
    size: MAX_SIZE,
    authMethods: ['PLAIN', 'LOGIN'],
    // Without TLS configured we still allow AUTH (dev/test; prod is gated above).
    allowInsecureAuth: true,
    disabledCommands: hasTls ? [] : ['STARTTLS'],
    ...(hasTls
      ? { key: readFileSync(keyFile!), cert: readFileSync(certFile!) }
      : {}),

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

    async onData(stream, session: SMTPServerSession, callback) {
      const ctx = session.user as unknown as SmtpAuthContext | undefined;
      if (!ctx) return callback(Object.assign(new Error('Authentication required'), { responseCode: 530 }));

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
