import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sql } from 'kysely';
import { addSuppression, addSuppressionsBulk, removeSuppression, scoreList, getConsentHistory } from '@platform/shared';
import { requireScope } from '../plugins/scope.js';
import { tenantScoped } from '../lib/tenant.js';

const UNSUB_REASONS = ['hard_bounce', 'complaint', 'unsubscribe', 'manual', 'invalid'] as const;

const AddSchema = z.object({
  email: z.string().email(),
  reason: z.enum(['hard_bounce', 'complaint', 'unsubscribe', 'manual', 'invalid']).default('manual'),
  notes: z.string().max(500).optional(),
});

const ImportSchema = z.object({
  emails: z.array(z.string()).min(1).max(100000),
  reason: z.enum(['hard_bounce', 'complaint', 'unsubscribe', 'manual', 'invalid']).default('manual'),
  // If false, a poor-quality list is rejected instead of imported.
  force: z.boolean().default(false),
});

export const suppressionRoutes: FastifyPluginAsync = async (app) => {
  // List
  app.get('/suppressions', { preHandler: requireScope('suppressions') }, async (req) => {
    const { limit = '100', offset = '0', reason } = req.query as Record<string, string>;

    const safeLimit = (() => {
      const n = parseInt(String(limit), 10);
      if (!Number.isFinite(n) || n <= 0) return 100;
      return Math.min(n, 1000);
    })();
    const safeOffset = (() => {
      const n = parseInt(String(offset), 10);
      if (!Number.isFinite(n) || n < 0) return 0;
      return n;
    })();

    const rows = await tenantScoped(req, async (trx) => {
      let q = trx
        .selectFrom('suppressions')
        .select(['email', 'reason', 'notes', 'created_at'])
        .where('customer_id', '=', req.auth!.customer_id);
      if (reason) q = q.where('reason', '=', reason as any);
      return q.orderBy('created_at', 'desc').limit(safeLimit).offset(safeOffset).execute();
    });
    return { suppressions: rows };
  });

  // Add (manual)
  app.post('/suppressions', { preHandler: requireScope('suppressions') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = AddSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    }
    await tenantScoped(req, (trx) =>
      addSuppression(auth.customer_id, parsed.data.email, parsed.data.reason, parsed.data.notes, trx)
    );
    return reply.code(201).send({ email: parsed.data.email });
  });

  // Remove
  app.delete('/suppressions/:email', { preHandler: requireScope('suppressions') }, async (req, reply) => {
    const auth = req.auth!;
    const { email } = req.params as { email: string };
    await tenantScoped(req, (trx) => removeSuppression(auth.customer_id, decodeURIComponent(email), trx));
    return reply.code(204).send();
  });

  // Consent history for a recipient (gap analysis #8: consent ledger).
  // Append-only audit trail of every suppress/unsuppress event, for
  // GDPR/CAN-SPAM proof of when and how consent changed.
  app.get('/suppressions/:email/consent-history', { preHandler: requireScope('suppressions') }, async (req) => {
    const auth = req.auth!;
    const { email } = req.params as { email: string };
    const { limit } = req.query as { limit?: string };
    const history = await tenantScoped(req, (trx) =>
      getConsentHistory(auth.customer_id, decodeURIComponent(email), trx, limit ? parseInt(limit, 10) : undefined)
    );
    return { email: decodeURIComponent(email).toLowerCase(), history };
  });

  // Bulk import with list-quality scoring. Rejects obviously dirty lists
  // (spam traps, high invalid/disposable share) unless force=true.
  app.post('/suppressions/import', { preHandler: requireScope('suppressions') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = ImportSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    }
    const quality = await scoreList(parsed.data.emails);
    if (quality.recommendation === 'reject' && !parsed.data.force) {
      return reply.code(422).send({
        error: 'list_quality_too_low',
        message: 'List failed quality scoring (spam traps or too many invalid/disposable addresses).',
        quality,
      });
    }
    // Import the valid addresses only.
    const valid = parsed.data.emails
      .map((e) => e.trim().toLowerCase())
      .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    const imported = await tenantScoped(req, (trx) =>
      addSuppressionsBulk(auth.customer_id, valid, parsed.data.reason, 'bulk import', trx)
    );
    return reply.code(200).send({ imported, quality });
  });

  // Export suppressions as CSV (streaming-safe for large lists).
  // Accepts optional ?reason= filter and ?since= (ISO date) for incremental exports.
  app.get('/suppressions/export', {
    preHandler: requireScope('suppressions'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = req.auth!;
    const { reason, since } = req.query as Record<string, string | undefined>;

    const rows = await tenantScoped(req, async (trx) => {
      let q = trx
        .selectFrom('suppressions')
        .select(['email', 'reason', 'notes', 'created_at'])
        .where('customer_id', '=', auth.customer_id)
        .orderBy('created_at', 'asc');
      if (reason) q = q.where('reason', '=', reason as any);
      if (since) {
        const sinceDate = new Date(since);
        if (!isNaN(sinceDate.getTime())) q = q.where(sql<boolean>`created_at >= ${sinceDate}::timestamptz`);
      }
      return q.execute();
    });

    const csvLines = ['email,reason,notes,created_at'];
    for (const r of rows) {
      const escaped = [
        r.email,
        r.reason,
        r.notes ? `"${String(r.notes).replace(/"/g, '""')}"` : '',
        r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      ].join(',');
      csvLines.push(escaped);
    }

    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="suppressions-${new Date().toISOString().slice(0, 10)}.csv"`);
    return reply.send(csvLines.join('\n'));
  });

  // ---- Unsubscribe groups ----
  // Note: unsubscribe_groups / unsubscribe_group_members are not currently
  // RLS-protected tables (see infra/migrations/025_unsubscribe_groups.sql),
  // but these handlers are wrapped in tenantScoped too for consistency and to
  // be ready if/when RLS coverage is extended to them.
  const GroupSchema = z.object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(500).optional(),
    is_default: z.boolean().optional(),
  });

  app.get('/unsubscribe-groups', { preHandler: requireScope('suppressions') }, async (req) => {
    const auth = req.auth!;
    const rows = await tenantScoped(req, (trx) =>
      trx
        .selectFrom('unsubscribe_groups')
        .select(['id', 'name', 'description', 'is_default', 'created_at'])
        .where('customer_id', '=', auth.customer_id)
        .orderBy('created_at', 'asc')
        .execute()
    );
    return { groups: rows };
  });

  app.post('/unsubscribe-groups', { preHandler: requireScope('suppressions') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = GroupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

    const group = await tenantScoped(req, async (trx) => {
      if (parsed.data.is_default) {
        // Clear any existing default to maintain the unique constraint.
        await trx.updateTable('unsubscribe_groups')
          .set({ is_default: false })
          .where('customer_id', '=', auth.customer_id)
          .where('is_default', '=', true)
          .execute();
      }

      return trx.insertInto('unsubscribe_groups')
        .values({ customer_id: auth.customer_id, name: parsed.data.name, description: parsed.data.description ?? null, is_default: parsed.data.is_default ?? false })
        .returning(['id', 'name', 'description', 'is_default', 'created_at'])
        .executeTakeFirstOrThrow();
    });
    return reply.code(201).send({ group });
  });

  app.patch('/unsubscribe-groups/:id', { preHandler: requireScope('suppressions') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const PatchSchema = GroupSchema.partial();
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

    const result = await tenantScoped(req, async (trx) => {
      const existing = await trx.selectFrom('unsubscribe_groups').select('id').where('id', '=', id).where('customer_id', '=', auth.customer_id).executeTakeFirst();
      if (!existing) return { notFound: true as const };

      if (parsed.data.is_default) {
        await trx.updateTable('unsubscribe_groups').set({ is_default: false }).where('customer_id', '=', auth.customer_id).where('is_default', '=', true).execute();
      }

      const set: Record<string, unknown> = { updated_at: new Date() };
      if (parsed.data.name !== undefined) set.name = parsed.data.name;
      if (parsed.data.description !== undefined) set.description = parsed.data.description;
      if (parsed.data.is_default !== undefined) set.is_default = parsed.data.is_default;

      const updated = await trx.updateTable('unsubscribe_groups').set(set).where('id', '=', id).where('customer_id', '=', auth.customer_id).returning(['id', 'name', 'description', 'is_default']).executeTakeFirst();
      return { notFound: false as const, group: updated };
    });

    if (result.notFound) return reply.code(404).send({ error: 'not_found' });
    return { group: result.group };
  });

  app.delete('/unsubscribe-groups/:id', { preHandler: requireScope('suppressions') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const deleted = await tenantScoped(req, async (trx) => {
      const res = await trx.deleteFrom('unsubscribe_groups').where('id', '=', id).where('customer_id', '=', auth.customer_id).executeTakeFirst();
      return Number(res.numDeletedRows ?? 0) > 0;
    });
    if (!deleted) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  // List members unsubscribed from a group
  app.get('/unsubscribe-groups/:id/members', { preHandler: requireScope('suppressions') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const { limit = '100', offset = '0' } = req.query as Record<string, string>;
    const safeLimit = Math.min(Math.max(1, parseInt(limit, 10) || 100), 1000);
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    const result = await tenantScoped(req, async (trx) => {
      const group = await trx.selectFrom('unsubscribe_groups').select('id').where('id', '=', id).where('customer_id', '=', auth.customer_id).executeTakeFirst();
      if (!group) return { notFound: true as const };
      const members = await trx.selectFrom('unsubscribe_group_members').select(['email', 'unsubscribed_at']).where('group_id', '=', id).orderBy('unsubscribed_at', 'desc').limit(safeLimit).offset(safeOffset).execute();
      return { notFound: false as const, members };
    });

    if (result.notFound) return reply.code(404).send({ error: 'not_found' });
    return { members: result.members };
  });

  const MembersSchema = z.object({ emails: z.array(z.string().email()).min(1).max(1000) });

  // Add unsubscribe members (e.g., from a list upload)
  app.post('/unsubscribe-groups/:id/members', { preHandler: requireScope('suppressions') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const parsed = MembersSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

    const result = await tenantScoped(req, async (trx) => {
      const group = await trx.selectFrom('unsubscribe_groups').select('id').where('id', '=', id).where('customer_id', '=', auth.customer_id).executeTakeFirst();
      if (!group) return { notFound: true as const };

      await trx.insertInto('unsubscribe_group_members')
        .values(parsed.data.emails.map((email) => ({ group_id: id, customer_id: auth.customer_id, email: email.toLowerCase() })))
        .onConflict((oc) => oc.columns(['group_id', 'email']).doNothing())
        .execute();
      return { notFound: false as const };
    });

    if (result.notFound) return reply.code(404).send({ error: 'not_found' });
    return reply.code(200).send({ added: parsed.data.emails.length });
  });

  // Remove a member from a group (re-subscribe)
  app.delete('/unsubscribe-groups/:id/members/:email', { preHandler: requireScope('suppressions') }, async (req, reply) => {
    const auth = req.auth!;
    const { id, email } = req.params as { id: string; email: string };
    const result = await tenantScoped(req, async (trx) => {
      const group = await trx.selectFrom('unsubscribe_groups').select('id').where('id', '=', id).where('customer_id', '=', auth.customer_id).executeTakeFirst();
      if (!group) return { notFound: true as const };
      await trx.deleteFrom('unsubscribe_group_members').where('group_id', '=', id).where('email', '=', decodeURIComponent(email).toLowerCase()).execute();
      return { notFound: false as const };
    });
    if (result.notFound) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });
};
