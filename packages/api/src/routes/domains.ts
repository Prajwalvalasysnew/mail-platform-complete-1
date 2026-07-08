import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { listDomains, addDomain, verifyDomain, deleteDomain, DomainError } from '@platform/shared';
import { requireScope } from '../plugins/scope.js';

const AddDomainSchema = z.object({
  domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'Invalid domain'),
  dkim_selector: z.string().regex(/^[a-z0-9-]+$/i).default('default'),
});

export const domainRoutes: FastifyPluginAsync = async (app) => {
  app.get('/domains', { preHandler: requireScope('domains') }, async (req) => {
    return { domains: await listDomains(req.auth!.customer_id) };
  });

  app.post('/domains', { preHandler: requireScope('domains') }, async (req, reply) => {
    const parsed = AddDomainSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    }
    try {
      const added = await addDomain({ customerId: req.auth!.customer_id, domain: parsed.data.domain, dkimSelector: parsed.data.dkim_selector });
      return reply.code(201).send({ id: added.id, domain: added.domain, dns_records: added.dns_records });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'domain_exists') {
        return reply.code(409).send({ error: 'domain_exists', domain_id: err.domainId });
      }
      throw err;
    }
  });

  app.post('/domains/:id/verify', { preHandler: requireScope('domains') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await verifyDomain(req.auth!.customer_id, id);
    if (!result) return reply.code(404).send({ error: 'not_found' });
    return result;
  });

  app.delete('/domains/:id', { preHandler: requireScope('domains') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deleteDomain(req.auth!.customer_id, id);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });
};
