import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  listCustomerApiKeys,
  createCustomerApiKey,
  revokeCustomerApiKey,
  rotateCustomerApiKey,
  recordAuditSafe,
  ApiKeyError,
  API_KEY_SCOPES,
} from '@platform/shared';
import { requireCapability } from '../plugins/session-auth.js';

// Customer-facing API key management, scoped to the caller's active org and
// gated by the apikeys:manage capability (owner / admin / developer). Distinct
// from the admin key endpoints, which act across customers.
export const keyRoutes: FastifyPluginAsync = async (app) => {
  const manage = requireCapability('apikeys:manage');

  function handleKeyError(err: unknown, reply: any): boolean {
    if (err instanceof ApiKeyError) {
      reply.code(400).send({ error: err.code, message: err.message });
      return true;
    }
    return false;
  }

  // List keys (metadata only — never the hash or plaintext).
  app.get('/account/api-keys', { preHandler: manage }, async (req) => {
    const orgId = req.user!.current_customer_id!;
    return { keys: await listCustomerApiKeys(orgId) };
  });

  // Create a key. The plaintext is returned exactly once.
  const CreateSchema = z.object({
    name: z.string().min(1).max(100),
    key_type: z.enum(['secret', 'publishable', 'test']).optional(),
    scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).optional(),
    expires_in_days: z.number().int().min(1).max(3650).optional(),
  });
  app.post('/account/api-keys', { preHandler: manage }, async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const orgId = req.user!.current_customer_id!;
    try {
      const created = await createCustomerApiKey({
        customerId: orgId,
        name: parsed.data.name,
        keyType: parsed.data.key_type,
        scopes: parsed.data.scopes,
        expiresInDays: parsed.data.expires_in_days,
      });
      recordAuditSafe({
        customerId: orgId, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email,
        action: 'apikey.created', resource: created.id,
        metadata: { name: created.name, key_type: created.key_type, scopes: created.scopes }, ip: req.ip,
      });
      return reply.code(201).send({ ...created, note: 'Save this API key — it will not be shown again.' });
    } catch (err) {
      if (handleKeyError(err, reply)) return;
      throw err;
    }
  });

  // Rotate a key: mint a replacement, expire the old one after an overlap window.
  app.post('/account/api-keys/:id/rotate', { preHandler: manage }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = req.user!.current_customer_id!;
    try {
      const rotated = await rotateCustomerApiKey(orgId, id);
      if (!rotated) return reply.code(404).send({ error: 'not_found' });
      recordAuditSafe({
        customerId: orgId, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email,
        action: 'apikey.rotated', resource: rotated.rotated_from_id,
        metadata: { new_key_id: rotated.id, overlap_hours: rotated.old_key_expires_in_hours }, ip: req.ip,
      });
      return reply.code(201).send({ ...rotated, note: 'Old key stays valid during the overlap window. Save the new key now.' });
    } catch (err) {
      if (handleKeyError(err, reply)) return;
      throw err;
    }
  });

  // Revoke a key (idempotent).
  app.delete('/account/api-keys/:id', { preHandler: manage }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const orgId = req.user!.current_customer_id!;
    const ok = await revokeCustomerApiKey(orgId, id);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    recordAuditSafe({
      customerId: orgId, actorType: 'user', actorId: req.user!.user_id, actorLabel: req.user!.email,
      action: 'apikey.revoked', resource: id, ip: req.ip,
    });
    return { ok: true };
  });
};
