// Self-serve data exports (DATABASE_10_10_PLAN Phase 2.2).
//
// POST /v1/exports queues an async NDJSON export of the tenant's events or
// message metadata for a date range; GET endpoints report status and stream
// the artifact back. The range is clamped to the tenant's plan retention
// window, and artifacts expire via RETENTION_EXPORT_DAYS.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { createDataExport, readExportPayload, ExportValidationError } from '@platform/shared';
import { requireScope } from '../plugins/scope.js';
import { tenantScoped } from '../lib/tenant.js';

const CreateExportSchema = z.object({
  kind: z.enum(['events', 'messages']),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

const PUBLIC_FIELDS = [
  'id', 'kind', 'range_from', 'range_to', 'status', 'row_count',
  'size_bytes', 'truncated', 'error', 'created_at', 'started_at', 'completed_at',
] as const;

export const exportRoutes: FastifyPluginAsync = async (app) => {
  app.post('/exports', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = CreateExportSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    }
    try {
      const row = await tenantScoped(req, (trx) =>
        createDataExport(
          {
            customerId: auth.customer_id,
            kind: parsed.data.kind,
            from: new Date(parsed.data.from),
            to: new Date(parsed.data.to),
          },
          trx,
        ),
      );
      const publicRow = Object.fromEntries(PUBLIC_FIELDS.map((f) => [f, (row as any)[f]]));
      return reply.code(202).send({ export: publicRow });
    } catch (err) {
      if (err instanceof ExportValidationError) {
        return reply.code(400).send({ error: 'validation_failed', message: err.message });
      }
      throw err;
    }
  });

  app.get('/exports', { preHandler: requireScope('messages') }, async (req) => {
    const auth = req.auth!;
    const rows = await tenantScoped(req, (trx) =>
      trx
        .selectFrom('data_exports')
        .select([...PUBLIC_FIELDS])
        .where('customer_id', '=', auth.customer_id)
        .orderBy('created_at', 'desc')
        .limit(100)
        .execute(),
    );
    return { exports: rows };
  });

  app.get('/exports/:id', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const row = await tenantScoped(req, (trx) =>
      trx
        .selectFrom('data_exports')
        .select([...PUBLIC_FIELDS])
        .where('id', '=', id)
        .where('customer_id', '=', auth.customer_id)
        .executeTakeFirst(),
    ).catch(() => undefined); // malformed uuid → not found
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { export: row };
  });

  app.get('/exports/:id/download', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const row = await tenantScoped(req, (trx) =>
      trx
        .selectFrom('data_exports')
        .selectAll()
        .where('id', '=', id)
        .where('customer_id', '=', auth.customer_id)
        .executeTakeFirst(),
    ).catch(() => undefined);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.status !== 'completed') {
      return reply.code(409).send({ error: 'not_ready', status: row.status });
    }
    const payload = await readExportPayload(row as any);
    return reply
      .header('content-type', 'application/x-ndjson')
      .header('content-disposition', `attachment; filename="export-${row.kind}-${id}.ndjson"`)
      .send(payload);
  });
};
