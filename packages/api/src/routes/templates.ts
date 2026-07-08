import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { validateTemplate } from '@platform/shared';
import { requireScope } from '../plugins/scope.js';
import { tenantScoped } from '../lib/tenant.js';

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  subject: z.string().min(1).max(998),
  // Cap stored template bodies. Templates are rendered per-recipient, so an
  // unbounded body is a CPU/memory and billing-amplification vector.
  html_body: z.string().max(1_048_576, 'html_body exceeds 1MB limit').optional(),
  text_body: z.string().max(1_048_576, 'text_body exceeds 1MB limit').optional(),
}).refine((d) => d.html_body || d.text_body, { message: 'html_body or text_body required' });

export const templateRoutes: FastifyPluginAsync = async (app) => {
  app.get('/templates', { preHandler: requireScope('templates') }, async (req) => {
    const auth = req.auth!;
    const rows = await tenantScoped(req, (trx) =>
      trx
        .selectFrom('templates')
        .select(['id', 'name', 'subject', 'created_at', 'updated_at'])
        .where('customer_id', '=', auth.customer_id)
        .orderBy('updated_at', 'desc')
        .execute()
    );
    return { templates: rows };
  });

  app.get('/templates/:id', { preHandler: requireScope('templates') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const row = await tenantScoped(req, (trx) =>
      trx.selectFrom('templates').selectAll()
        .where('id', '=', id).where('customer_id', '=', auth.customer_id)
        .executeTakeFirst()
    );
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return row;
  });

  app.post('/templates', { preHandler: requireScope('templates') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

    // Validate Handlebars compiles, and collect the union of variables
    // referenced across subject/html/text so the response can tell the caller
    // exactly which {{variables}} this template expects.
    const declaredVars = new Set<string>();
    for (const field of ['subject', 'html_body', 'text_body'] as const) {
      const src = parsed.data[field];
      if (src) {
        const v = validateTemplate(src);
        if (!v.valid) return reply.code(400).send({ error: 'invalid_template', field, message: v.error });
        for (const name of v.variables ?? []) declaredVars.add(name);
      }
    }

    try {
      const row = await tenantScoped(req, (trx) =>
        trx.insertInto('templates').values({
          customer_id: auth.customer_id,
          name: parsed.data.name,
          subject: parsed.data.subject,
          html_body: parsed.data.html_body ?? null,
          text_body: parsed.data.text_body ?? null,
        }).returning(['id', 'name', 'subject', 'created_at']).executeTakeFirstOrThrow()
      );
      return reply.code(201).send({ ...row, variables: Array.from(declaredVars).sort() });
    } catch (err: any) {
      if (err.code === '23505') return reply.code(409).send({ error: 'name_exists' });
      throw err;
    }
  });

  app.put('/templates/:id', { preHandler: requireScope('templates') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

    // Validate Handlebars compiles (same as POST) — an update with bad syntax
    // would otherwise be saved and crash /v1/send at render time.
    const declaredVars = new Set<string>();
    for (const field of ['subject', 'html_body', 'text_body'] as const) {
      const src = parsed.data[field];
      if (src) {
        const v = validateTemplate(src);
        if (!v.valid) return reply.code(400).send({ error: 'invalid_template', field, message: v.error });
        for (const name of v.variables ?? []) declaredVars.add(name);
      }
    }

    const res = await tenantScoped(req, (trx) =>
      trx.updateTable('templates').set({
        name: parsed.data.name,
        subject: parsed.data.subject,
        html_body: parsed.data.html_body ?? null,
        text_body: parsed.data.text_body ?? null,
      }).where('id', '=', id).where('customer_id', '=', auth.customer_id)
        .returning(['id']).executeTakeFirst()
    );
    if (!res) return reply.code(404).send({ error: 'not_found' });
    return { id: res.id, variables: Array.from(declaredVars).sort() };
  });

  app.delete('/templates/:id', { preHandler: requireScope('templates') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    await tenantScoped(req, (trx) =>
      trx.deleteFrom('templates').where('id', '=', id).where('customer_id', '=', auth.customer_id).execute()
    );
    return reply.code(204).send();
  });
};
