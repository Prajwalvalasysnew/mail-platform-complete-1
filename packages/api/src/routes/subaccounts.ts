// Sub-account management (reseller/franchise tenancy). Scope: subaccounts.
//
// Acting AS a child happens two ways:
//   1. mint the child its own API key (POST /v1/subaccounts/:id/keys) and
//      hand it to the client system — full isolation, revocable per child;
//   2. send with the parent key + `X-On-Behalf-Of: <subaccount_id>` header
//      (single-credential resellers) — see the auth plugin.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  SubaccountError,
  createSubaccount,
  listSubaccounts,
  assertChildOf,
  updateSubaccount,
  subaccountUsageRollup,
  pushTemplateToSubaccounts,
  createCustomerApiKey,
  listCustomerApiKeys,
  revokeCustomerApiKey,
  ApiKeyError,
  recordAuditSafe,
} from '@platform/shared';
import { requireScope } from '../plugins/scope.js';

function sendSubaccountError(reply: any, err: unknown): boolean {
  if (err instanceof SubaccountError) {
    const status =
      err.code === 'not_a_subaccount' || err.code === 'template_not_found' ? 404
      : err.code === 'subaccount_limit_reached' || err.code === 'email_exists' || err.code === 'subaccounts_cannot_nest' ? 409
      : err.code === 'no_fields' ? 400
      : 403; // parent_not_active
    reply.code(status).send({ error: err.code, message: err.message });
    return true;
  }
  if (err instanceof ApiKeyError) {
    reply.code(400).send({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

export const subaccountRoutes: FastifyPluginAsync = async (app) => {
  const scope = requireScope('subaccounts');

  app.get('/subaccounts', { preHandler: scope }, async (req) => {
    const auth = req.auth!;
    return { subaccounts: await listSubaccounts(auth.customer_id) };
  });

  const CreateSchema = z.object({
    name: z.string().min(1).max(200),
    email: z.string().email().optional(),
    daily_quota: z.number().int().min(1).optional(),
    monthly_quota: z.number().int().min(1).optional(),
  });
  app.post('/subaccounts', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      const sub = await createSubaccount({
        parentId: auth.customer_id,
        name: parsed.data.name,
        email: parsed.data.email,
        dailyQuota: parsed.data.daily_quota,
        monthlyQuota: parsed.data.monthly_quota,
      });
      recordAuditSafe({
        customerId: auth.customer_id,
        apiKeyId: auth.api_key_id,
        actorType: 'api_key',
        action: 'subaccount:created',
        resource: sub.id,
        ip: req.ip,
        metadata: { name: sub.name },
      });
      return reply.code(201).send({ subaccount: sub });
    } catch (err) {
      if (sendSubaccountError(reply, err)) return;
      throw err;
    }
  });

  app.get('/subaccounts/usage', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const days = Number((req.query as any)?.days ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      return reply.code(400).send({ error: 'validation_failed', message: 'days must be an integer 1-90' });
    }
    return subaccountUsageRollup(auth.customer_id, days);
  });

  app.get('/subaccounts/:id', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    try {
      return { subaccount: await assertChildOf(auth.customer_id, id) };
    } catch (err) {
      if (sendSubaccountError(reply, err)) return;
      throw err;
    }
  });

  const UpdateSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    status: z.enum(['active', 'suspended']).optional(),
    daily_quota: z.number().int().min(1).optional(),
    monthly_quota: z.number().int().min(1).optional(),
  });
  app.patch('/subaccounts/:id', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      const sub = await updateSubaccount(auth.customer_id, id, {
        name: parsed.data.name,
        status: parsed.data.status,
        dailyQuota: parsed.data.daily_quota,
        monthlyQuota: parsed.data.monthly_quota,
      });
      recordAuditSafe({
        customerId: auth.customer_id,
        apiKeyId: auth.api_key_id,
        actorType: 'api_key',
        action: 'subaccount:updated',
        resource: id,
        ip: req.ip,
        metadata: parsed.data as any,
      });
      return { subaccount: sub };
    } catch (err) {
      if (sendSubaccountError(reply, err)) return;
      throw err;
    }
  });

  // ---- child credentials ---------------------------------------------------
  const KeySchema = z.object({
    name: z.string().min(1).max(200),
    scopes: z.array(z.string()).min(1).optional(),
    expires_in_days: z.number().int().min(1).max(3650).optional(),
  });
  app.post('/subaccounts/:id/keys', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const parsed = KeySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      await assertChildOf(auth.customer_id, id);
      const key = await createCustomerApiKey({
        customerId: id,
        name: parsed.data.name,
        scopes: parsed.data.scopes ?? ['send', 'smtp'],
        expiresInDays: parsed.data.expires_in_days ?? null,
      });
      recordAuditSafe({
        customerId: auth.customer_id,
        apiKeyId: auth.api_key_id,
        actorType: 'api_key',
        action: 'subaccount:key_created',
        resource: id,
        ip: req.ip,
        metadata: { key_id: key.id, scopes: key.scopes },
      });
      return reply.code(201).send(key);
    } catch (err) {
      if (sendSubaccountError(reply, err)) return;
      throw err;
    }
  });

  app.get('/subaccounts/:id/keys', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    try {
      await assertChildOf(auth.customer_id, id);
      return { keys: await listCustomerApiKeys(id) };
    } catch (err) {
      if (sendSubaccountError(reply, err)) return;
      throw err;
    }
  });

  app.delete('/subaccounts/:id/keys/:keyId', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { id, keyId } = req.params as { id: string; keyId: string };
    try {
      await assertChildOf(auth.customer_id, id);
      const ok = await revokeCustomerApiKey(id, keyId);
      if (!ok) return reply.code(404).send({ error: 'not_found' });
      return reply.code(204).send();
    } catch (err) {
      if (sendSubaccountError(reply, err)) return;
      throw err;
    }
  });

  // ---- template push (franchise model) ------------------------------------
  const PushSchema = z.object({
    template_id: z.string().uuid(),
    subaccount_ids: z.union([z.literal('all'), z.array(z.string().uuid()).min(1).max(100)]),
  });
  app.post('/subaccounts/templates/push', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = PushSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      const result = await pushTemplateToSubaccounts(auth.customer_id, parsed.data.template_id, parsed.data.subaccount_ids);
      recordAuditSafe({
        customerId: auth.customer_id,
        apiKeyId: auth.api_key_id,
        actorType: 'api_key',
        action: 'subaccount:template_pushed',
        resource: parsed.data.template_id,
        ip: req.ip,
        metadata: { pushed: result.pushed.length },
      });
      return result;
    } catch (err) {
      if (sendSubaccountError(reply, err)) return;
      throw err;
    }
  });
};
