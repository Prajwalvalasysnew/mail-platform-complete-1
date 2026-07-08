import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';

// Standardizes error responses into a single envelope and echoes the request
// correlation ID (set by server.ts genReqId) back in every response header and
// body so clients can quote it in support tickets.
//
// req.id is set by Fastify via genReqId before any hook runs; pino includes it
// as "reqId" in every log line automatically — no child-logger wiring needed.
//
// Envelope (loosely RFC 9457 problem+json shaped):
//   { "error": "<stable_code>", "message": "<human readable>", "request_id": "...", "details"?: ... }

const errorEnvelopeImpl: FastifyPluginAsync = async (app) => {
  // Echo the resolved request id back to the caller on every response.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // Map thrown errors to the envelope. Preserves Fastify/sensible httpErrors
  // (statusCode + code) and Zod-style validation errors.
  app.setErrorHandler((err: any, req, reply) => {
    const statusCode = (err as any).statusCode ?? 500;

    // Fastify built-in validation errors
    if ((err as any).validation) {
      req.log.info({ err }, 'request validation failed');
      return reply.code(400).send({
        error: 'validation_failed',
        message: err.message,
        request_id: req.id,
        details: (err as any).validation,
      });
    }

    const code =
      (err as any).code && typeof (err as any).code === 'string'
        ? (err as any).code
        : statusCode >= 500
          ? 'internal_error'
          : 'request_error';

    if (statusCode >= 500) {
      req.log.error({ err }, 'unhandled error');
    } else {
      req.log.warn({ err }, 'request error');
    }

    return reply.code(statusCode).send({
      error: code,
      // Never leak internal error text to clients on 5xx.
      message: statusCode >= 500 ? 'An unexpected error occurred.' : err.message,
      request_id: req.id,
    });
  });

  // Consistent 404 envelope.
  app.setNotFoundHandler((req, reply) => {
    return reply.code(404).send({
      error: 'not_found',
      message: `Route ${req.method} ${req.url} not found`,
      request_id: req.id,
    });
  });
};

export const errorEnvelope = fp(errorEnvelopeImpl, { name: 'error-envelope' });
