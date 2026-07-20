// DMARC aggregate-report monitoring. Scope: domains.
//
// Customers point their rua= record at the address returned by
// GET /v1/dmarc/reporting-address; receivers (Gmail/Yahoo/M365) mail their
// daily aggregate reports there, the inbound path resolves the token and
// calls ingestDmarcReport. Customers can also POST reports directly (upload
// or forward) to /v1/dmarc/reports. The summary/sources endpoints turn the
// stored data into the "who is sending as your domain" view.

import type { FastifyPluginAsync } from 'fastify';
import {
  DmarcReportError,
  ensureDmarcReportToken,
  ingestDmarcReport,
  dmarcSummary,
  dmarcSources,
} from '@platform/shared';
import { requireScope } from '../plugins/scope.js';
import { tenantScoped } from '../lib/tenant.js';

export const dmarcRoutes: FastifyPluginAsync = async (app) => {
  const scope = requireScope('domains');

  // Aggregate reports arrive as raw XML, gzip, or zip. Parse those bodies
  // straight to a Buffer (encapsulated to this plugin so other routes keep
  // their JSON parsing). simpleParser-style decompression happens downstream.
  for (const ct of ['application/gzip', 'application/zip', 'application/xml', 'text/xml', 'application/octet-stream']) {
    app.addContentTypeParser(ct, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  }

  // The rua= address to publish in DNS.
  app.get('/dmarc/reporting-address', { preHandler: scope }, async (req) => {
    const auth = req.auth!;
    const { token, rua_address } = await ensureDmarcReportToken(auth.customer_id);
    return {
      rua_address,
      dns_hint: `v=DMARC1; p=none; rua=mailto:${rua_address}`,
      note: 'Publish this rua address in your _dmarc TXT record to start receiving aggregate reports. Begin at p=none, watch the sources, then move to quarantine/reject.',
      token_last4: token.slice(-4),
    };
  });

  // Direct report upload (raw XML, .xml.gz, or .zip). Content is the raw body.
  app.post(
    '/dmarc/reports',
    {
      config: {
        rateLimit: {
          max: Number(process.env.DMARC_INGEST_RATE_LIMIT_PER_MINUTE ?? 120),
          timeWindow: '1 minute',
        },
      },
      preHandler: scope,
      // Accept binary report bodies untouched.
      bodyLimit: Number(process.env.DMARC_MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024),
    },
    async (req, reply) => {
      const auth = req.auth!;
      const raw = req.body;
      const buf = Buffer.isBuffer(raw)
        ? raw
        : typeof raw === 'string'
          ? Buffer.from(raw)
          : raw && typeof raw === 'object'
            ? Buffer.from(JSON.stringify(raw))
            : Buffer.alloc(0);
      if (buf.length === 0) return reply.code(400).send({ error: 'empty_report', message: 'Request body is empty.' });
      try {
        const result = await tenantScoped(req, (trx) => ingestDmarcReport(auth.customer_id, buf, trx));
        return reply.code(result.ingested ? 201 : 200).send(result);
      } catch (err) {
        if (err instanceof DmarcReportError) {
          return reply.code(422).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    }
  );

  app.get('/dmarc/summary', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const q = req.query as { domain?: string; days?: string };
    const days = q.days ? Number(q.days) : 30;
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return reply.code(400).send({ error: 'validation_failed', message: 'days must be an integer 1-365' });
    }
    return tenantScoped(req, (trx) => dmarcSummary(auth.customer_id, { domain: q.domain, days }, trx));
  });

  app.get('/dmarc/sources', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const q = req.query as { domain?: string; days?: string; limit?: string };
    const days = q.days ? Number(q.days) : 30;
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return reply.code(400).send({ error: 'validation_failed', message: 'days must be an integer 1-365' });
    }
    const sources = await tenantScoped(req, (trx) =>
      dmarcSources(auth.customer_id, { domain: q.domain, days, limit: q.limit ? Number(q.limit) : 100 }, trx)
    );
    return { sources };
  });
};
