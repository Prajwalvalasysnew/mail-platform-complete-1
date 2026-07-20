// Diagnostic tooling: the domain deliverability scanner. Read-only DNS
// analysis (no tenant data touched), so it needs auth + rate limiting but no
// tenant transaction.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { scanDomain, isScannableDomain } from '@platform/shared';
import { requireScope } from '../plugins/scope.js';

const ScanSchema = z.object({
  domain: z.string().min(4).max(253),
  // DNSBL round-trips dominate scan latency; callers that only want the
  // record analysis can skip them.
  check_blocklists: z.boolean().optional(),
});

export const toolRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/tools/domain-scan',
    {
      config: {
        // DNS fan-out per scan is ~25 queries; cap per key accordingly.
        rateLimit: {
          max: Number(process.env.DOMAIN_SCAN_RATE_LIMIT_PER_MINUTE ?? 30),
          timeWindow: '1 minute',
        },
      },
      preHandler: requireScope('domains'),
    },
    async (req, reply) => {
      const parsed = ScanSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
      }
      const domain = parsed.data.domain.trim().toLowerCase();
      if (!isScannableDomain(domain)) {
        return reply.code(400).send({
          error: 'invalid_domain',
          message: 'Provide a public, fully-qualified domain name (no IPs or internal names).',
        });
      }
      const report = await scanDomain(domain, { checkBlocklists: parsed.data.check_blocklists !== false });
      return report;
    }
  );
};
