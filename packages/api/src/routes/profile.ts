import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '@platform/shared';
import { requireScope } from '../plugins/scope.js';

/**
 * Customer profile read/update.
 *
 * These handlers depend on `req.auth` (populated by the API-key auth plugin) via
 * requireScope('messages'). They were previously defined in customers.ts, which
 * is mounted OUTSIDE the auth scope (because it also hosts the public /signup
 * and /verify-email routes). The auth plugin therefore never ran for /profile,
 * so req.auth was undefined and every call 401'd — making it impossible for a
 * customer to set their CAN-SPAM physical_address, which in turn made every live
 * send fail with `physical_address_required`. Splitting them into their own
 * plugin lets server.ts register them inside the authenticated scope.
 */
export const profileRoutes: FastifyPluginAsync = async (app) => {
  // GET /v1/profile — returns the caller's customer record including physical_address.
  app.get('/profile', { preHandler: requireScope('messages') }, async (req) => {
    const auth = req.auth!;
    const customer = await db
      .selectFrom('customers')
      .select([
        'id', 'email', 'name', 'physical_address', 'tier', 'daily_quota',
        'monthly_quota', 'billing_status', 'status', 'kyc_level', 'created_at',
      ])
      .where('id', '=', auth.customer_id)
      .executeTakeFirstOrThrow();
    return { customer };
  });

  // PATCH /v1/profile — update mutable customer settings.
  const UpdateProfileSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    physical_address: z.string().min(5).max(500).optional().nullable(),
  });
  app.patch('/profile', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = UpdateProfileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const updates: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if ('physical_address' in parsed.data) updates.physical_address = parsed.data.physical_address ?? null;
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'no_fields_provided' });
    await db.updateTable('customers').set(updates as any).where('id', '=', auth.customer_id).execute();
    return { ok: true };
  });
};
