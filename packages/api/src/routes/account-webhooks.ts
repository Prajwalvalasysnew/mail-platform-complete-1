import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  rotateWebhookSecret,
  recordAuditSafe,
  WebhookError,
  WEBHOOK_EVENT_TYPES,
} from '@platform/shared';
import { requireCapability } from '../plugins/session-auth.js';
import { tenantScoped } from '../lib/tenant.js';

// Dashboard (human-session) webhook management for the active org, gated by the
// settings:manage capability (owner / admin). Shares the same org-scoped
// service as the API-key webhook route, plus enable/disable and secret
// rotation that a console needs.
export const accountWebhookRoutes: FastifyPluginAsync = async (app) => {
  const manage = requireCapability('settings:manage');

  function onError(err: unknown, reply: any): boolean {
    if (err instanceof WebhookError) {
      reply.code(400).send({ error: err.code, message: err.message });
      return true;
    }
    return false;
  }

  app.get('/account/webhooks', { preHandler: manage }, async (req) => {
    return { webhooks: await tenantScoped(req, (trx) => listWebhooks(req.user!.current_customer_id!, trx)) };
  });

  const CreateSchema = z.object({
    url: z.string().url(),
    events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
  });
  app.post('/account/webhooks', { preHandler: manage }, async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const orgId = req.user!.current_customer_id!;
    try {
      // Keep DNS validation outside the transaction; createWebhook opens its
      // short tenant-scoped transaction after the SSRF check succeeds.
      const row = await createWebhook({ customerId: orgId, url: parsed.data.url, events: parsed.data.events });
      recordAuditSafe({ customerId: orgId, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'webhook.created', resource: row.id, metadata: { url: row.url, events: row.events }, ip: req.ip });
      return reply.code(201).send(row);
    } catch (err) {
      if (onError(err, reply)) return;
      throw err;
    }
  });

  const UpdateSchema = z.object({
    url: z.string().url().optional(),
    events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).optional(),
    enabled: z.boolean().optional(),
  });
  app.patch('/account/webhooks/:id', { preHandler: manage }, async (req, reply) => {
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const { id } = req.params as { id: string };
    const orgId = req.user!.current_customer_id!;
    try {
      // updateWebhook may validate a new URL with DNS, so it owns a short
      // tenant transaction after that network operation.
      const row = await updateWebhook(orgId, id, parsed.data);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      recordAuditSafe({ customerId: orgId, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'webhook.updated', resource: id, metadata: parsed.data, ip: req.ip });
      return row;
    } catch (err) {
      if (onError(err, reply)) return;
      throw err;
    }
  });

  app.post('/account/webhooks/:id/rotate-secret', { preHandler: manage }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = req.user!.current_customer_id!;
    const row = await tenantScoped(req, (trx) => rotateWebhookSecret(orgId, id, trx));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    recordAuditSafe({ customerId: orgId, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'webhook.secret_rotated', resource: id, ip: req.ip });
    return reply.code(201).send({
      ...row,
      note: `Your endpoint's signature verifier should accept both "secret" and "previous_secret" until previous_secret_expires_at (${row.previous_secret_expires_at ? new Date(row.previous_secret_expires_at).toISOString() : 'n/a'}), then drop the old one.`,
    });
  });

  app.delete('/account/webhooks/:id', { preHandler: manage }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = req.user!.current_customer_id!;
    const ok = await tenantScoped(req, (trx) => deleteWebhook(orgId, id, trx));
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    recordAuditSafe({ customerId: orgId, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email, action: 'webhook.deleted', resource: id, ip: req.ip });
    return { ok: true };
  });
};
