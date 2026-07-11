import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  listDomains,
  getDomainWithDnsRecords,
  addDomain,
  verifyDomain,
  deleteDomain,
  recordAuditSafe,
  DomainError,
} from '@platform/shared';
import { requireCapability } from '../plugins/session-auth.js';
import { tenantScoped } from '../lib/tenant.js';

// Dashboard (human-session) sending-domain management for the active org, gated
// by the domains:manage capability (owner / admin / developer). Shares the
// org-scoped domain service with the API-key route, and adds a detail endpoint
// that re-surfaces the DNS records to publish for an unverified domain.
export const accountDomainRoutes: FastifyPluginAsync = async (app) => {
  const manage = requireCapability('domains:manage');

  app.get('/account/domains', { preHandler: manage }, async (req) => {
    return { domains: await tenantScoped(req, (trx) => listDomains(req.user!.current_customer_id!, trx)) };
  });

  app.get('/account/domains/:id', { preHandler: manage }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const domain = await tenantScoped(req, (trx) => getDomainWithDnsRecords(req.user!.current_customer_id!, id, trx));
    if (!domain) return reply.code(404).send({ error: 'not_found' });
    return domain;
  });

  const AddSchema = z.object({
    domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'Invalid domain'),
    dkim_selector: z.string().regex(/^[a-z0-9-]+$/i).default('default'),
  });
  app.post('/account/domains', { preHandler: manage }, async (req, reply) => {
    const parsed = AddSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const orgId = req.user!.current_customer_id!;
    try {
      const added = await addDomain({ customerId: orgId, domain: parsed.data.domain, dkimSelector: parsed.data.dkim_selector });
      recordAuditSafe({ customerId: orgId, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'domain.added', resource: added.id, metadata: { domain: added.domain }, ip: req.ip });
      return reply.code(201).send(added);
    } catch (err) {
      if (err instanceof DomainError && err.code === 'domain_exists') {
        return reply.code(409).send({ error: 'domain_exists', domain_id: err.domainId });
      }
      throw err;
    }
  });

  app.post('/account/domains/:id/verify', { preHandler: manage }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = req.user!.current_customer_id!;
    const result = await verifyDomain(orgId, id);
    if (!result) return reply.code(404).send({ error: 'not_found' });
    recordAuditSafe({ customerId: orgId, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'domain.verify_attempted', resource: id, metadata: { verified: result.verified, results: result.results }, ip: req.ip });
    return result;
  });

  app.delete('/account/domains/:id', { preHandler: manage }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = req.user!.current_customer_id!;
    const ok = await tenantScoped(req, (trx) => deleteDomain(orgId, id, trx));
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    recordAuditSafe({ customerId: orgId, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'domain.deleted', resource: id, ip: req.ip });
    return { ok: true };
  });
};
