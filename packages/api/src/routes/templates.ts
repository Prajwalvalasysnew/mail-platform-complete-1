import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { validateTemplate } from '@platform/shared';
import { requireScope } from '../plugins/scope.js';
import { tenantScoped } from '../lib/tenant.js';

const TemplateId=z.string().uuid();

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  subject: z.string().min(1).max(998),
  // Cap stored template bodies. Templates are rendered per-recipient, so an
  // unbounded body is a CPU/memory and billing-amplification vector.
  html_body: z.string().max(1_048_576, 'html_body exceeds 1MB limit').optional(),
  text_body: z.string().max(1_048_576, 'text_body exceeds 1MB limit').optional(),
  editor_document: z.record(z.unknown()).nullable().optional().refine(
    document => document == null || Buffer.byteLength(JSON.stringify(document), 'utf8') <= 1_048_576,
    'editor_document exceeds 1MB limit'
  ),
  expected_revision: z.number().int().positive().optional(),
}).refine((d) => d.html_body || d.text_body, { message: 'html_body or text_body required' });

export const templateRoutes: FastifyPluginAsync = async (app) => {
  app.get('/templates', { preHandler: requireScope('templates') }, async (req) => {
    const auth = req.auth!;
    const rows = await tenantScoped(req, (trx) =>
      trx
        .selectFrom('templates')
        .select(['id', 'name', 'subject', 'revision', 'created_at', 'updated_at'])
        .where('customer_id', '=', auth.customer_id)
        .orderBy('updated_at', 'desc')
        .execute()
    );
    return { templates: rows };
  });

  app.get('/templates/:id', { preHandler: requireScope('templates') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    if(!TemplateId.safeParse(id).success)return reply.code(400).send({error:'validation_failed'});
    const row = await tenantScoped(req, (trx) =>
      trx.selectFrom('templates').selectAll()
        .where('id', '=', id).where('customer_id', '=', auth.customer_id)
        .executeTakeFirst()
    );
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return row;
  });

  app.post('/templates', { preHandler: requireScope('templates'), bodyLimit: 3_500_000 }, async (req, reply) => {
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
      const row = await tenantScoped(req, async (trx) => {
        const created = await trx.insertInto('templates').values({
          customer_id: auth.customer_id,
          name: parsed.data.name,
          subject: parsed.data.subject,
          html_body: parsed.data.html_body ?? null,
          text_body: parsed.data.text_body ?? null,
          editor_document: parsed.data.editor_document ?? null,
        }).returningAll().executeTakeFirstOrThrow();
        await trx.insertInto('template_versions').values({
          customer_id: auth.customer_id, template_id: created.id, revision: created.revision,
          name: created.name, subject: created.subject, html_body: created.html_body,
          text_body: created.text_body, editor_document: created.editor_document,
        }).execute();
        return { id: created.id, name: created.name, subject: created.subject, revision: created.revision, created_at: created.created_at };
      });
      return reply.code(201).send({ ...row, variables: Array.from(declaredVars).sort() });
    } catch (err: any) {
      if (err.code === '23505') return reply.code(409).send({ error: 'name_exists' });
      throw err;
    }
  });

  app.put('/templates/:id', { preHandler: requireScope('templates'), bodyLimit: 3_500_000 }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    if(!TemplateId.safeParse(id).success)return reply.code(400).send({error:'validation_failed'});
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

    const res = await tenantScoped(req, async (trx) => {
      const existing = await trx.selectFrom('templates').select(['id', 'revision'])
        .where('id', '=', id).where('customer_id', '=', auth.customer_id).forUpdate().executeTakeFirst();
      if (!existing) return { kind: 'missing' as const };
      if (parsed.data.expected_revision != null && parsed.data.expected_revision !== existing.revision) {
        return { kind: 'conflict' as const, revision: existing.revision };
      }
      const updated = await trx.updateTable('templates').set({
        name: parsed.data.name,
        subject: parsed.data.subject,
        html_body: parsed.data.html_body ?? null,
        text_body: parsed.data.text_body ?? null,
        editor_document: parsed.data.editor_document ?? null,
        revision: existing.revision + 1,
      }).where('id', '=', id).where('customer_id', '=', auth.customer_id)
        .returningAll().executeTakeFirstOrThrow();
      await trx.insertInto('template_versions').values({
        customer_id: auth.customer_id, template_id: updated.id, revision: updated.revision,
        name: updated.name, subject: updated.subject, html_body: updated.html_body,
        text_body: updated.text_body, editor_document: updated.editor_document,
      }).execute();
      return { kind: 'updated' as const, id: updated.id, revision: updated.revision };
    }).catch((error: any) => {
      if (error.code === '23505') return { kind: 'duplicate' as const };
      throw error;
    });
    if (res.kind === 'missing') return reply.code(404).send({ error: 'not_found' });
    if (res.kind === 'conflict') return reply.code(409).send({ error: 'revision_conflict', revision: res.revision, message: 'This template was saved in another session. Reload before saving again.' });
    if (res.kind === 'duplicate') return reply.code(409).send({ error: 'name_exists' });
    return { id: res.id, revision: res.revision, variables: Array.from(declaredVars).sort() };
  });

  app.get('/templates/:id/versions', { preHandler: requireScope('templates') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if(!TemplateId.safeParse(id).success)return reply.code(400).send({error:'validation_failed'});
    const result = await tenantScoped(req, async trx => {
      const template = await trx.selectFrom('templates').select('id').where('id', '=', id)
        .where('customer_id', '=', req.auth!.customer_id).executeTakeFirst();
      if (!template) return null;
      const versions = await trx.selectFrom('template_versions')
        .select(['id', 'revision', 'name', 'subject', 'created_at'])
        .where('template_id', '=', id).where('customer_id', '=', req.auth!.customer_id)
        .orderBy('revision', 'desc').limit(100).execute();
      return { versions };
    });
    if (!result) return reply.code(404).send({ error: 'not_found' });
    return result;
  });

  app.get('/templates/:id/versions/:revision', { preHandler: requireScope('templates') }, async (req, reply) => {
    const { id, revision } = req.params as { id: string; revision: string };
    if(!TemplateId.safeParse(id).success)return reply.code(400).send({error:'validation_failed'});
    const parsed = z.coerce.number().int().positive().safeParse(revision);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed' });
    const version = await tenantScoped(req, trx => trx.selectFrom('template_versions').selectAll()
      .where('template_id', '=', id).where('customer_id', '=', req.auth!.customer_id)
      .where('revision', '=', parsed.data).executeTakeFirst());
    if (!version) return reply.code(404).send({ error: 'not_found' });
    return version;
  });

  app.delete('/templates/:id', { preHandler: requireScope('templates') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    if(!TemplateId.safeParse(id).success)return reply.code(400).send({error:'validation_failed'});
    await tenantScoped(req, (trx) =>
      trx.deleteFrom('templates').where('id', '=', id).where('customer_id', '=', auth.customer_id).execute()
    );
    return reply.code(204).send();
  });
};
