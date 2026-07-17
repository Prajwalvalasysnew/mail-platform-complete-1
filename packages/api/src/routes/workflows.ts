// Workflow automation API: builder CRUD, immutable version history, publish /
// pause lifecycle, external triggers, dry-run simulation, run monitoring, and
// step-level stats. All tenant-table access goes through tenantScoped() so the
// fail-closed RLS on workflow tables is active for every query.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  WorkflowError,
  createWorkflow,
  listWorkflows,
  getWorkflow,
  updateWorkflow,
  archiveWorkflow,
  publishWorkflow,
  setWorkflowStatus,
  listWorkflowVersions,
  getWorkflowVersion,
  restoreWorkflowVersion,
  listWorkflowRuns,
  getWorkflowRun,
  cancelWorkflowRun,
  getWorkflowStats,
  validateWorkflowDefinition,
  simulateWorkflow,
  triggerWorkflowRun,
  kickWorkflowRun,
  getWorkflowSigningSecret,
  invalidateWorkflowActivityCache,
  recordAuditSafe,
} from '@platform/shared';
import { requireScope } from '../plugins/scope.js';
import { tenantScoped } from '../lib/tenant.js';

const CreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  definition: z.unknown().optional(),
});

const UpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullish(),
  definition: z.unknown().optional(),
});

const PublishSchema = z.object({
  notes: z.string().max(2000).nullish(),
});

const TriggerSchema = z.object({
  subject_email: z.string().email(),
  context: z.record(z.unknown()).optional(),
});

const SimulateSchema = z.object({
  // Which definition to walk: an inline candidate, the current draft, or the
  // published version. Defaults to the draft (what the builder is editing).
  definition: z.unknown().optional(),
  source: z.enum(['draft', 'published']).default('draft'),
  subject_email: z.string().email().optional(),
  context: z.record(z.unknown()).optional(),
  trigger_payload: z.record(z.unknown()).optional(),
  event_outcomes: z.record(z.boolean()).optional(),
});

const ListQuerySchema = z.object({
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const RunsQuerySchema = z.object({
  status: z
    .enum(['running', 'waiting_delay', 'waiting_event', 'completed', 'goal_met', 'exited', 'failed', 'canceled'])
    .optional(),
  subject_email: z.string().email().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function sendWorkflowError(reply: any, err: unknown): boolean {
  if (!(err instanceof WorkflowError)) return false;
  const status =
    err.code === 'not_found' ? 404
    : err.code === 'name_exists' || err.code === 'archived' || err.code === 'invalid_state' ? 409
    : err.code === 'invalid_definition' ? 400
    : 422; // unknown_template, invalid_webhook_url, ...
  reply.code(status).send({ error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
  return true;
}

export const workflowRoutes: FastifyPluginAsync = async (app) => {
  const scope = requireScope('workflows');

  // ---- validation utility (no persistence) --------------------------------
  app.post('/workflows/validate', { preHandler: scope }, async (req) => {
    const body = (req.body ?? {}) as { definition?: unknown; strict?: boolean };
    const v = validateWorkflowDefinition(body.definition ?? {}, { strict: body.strict !== false });
    return { valid: v.valid, errors: v.errors, warnings: v.warnings };
  });

  // ---- webhook signature verification secret ------------------------------
  app.get('/workflows/signing-secret', { preHandler: scope }, async (req) => {
    const auth = req.auth!;
    return { secret: getWorkflowSigningSecret(auth.customer_id), algorithm: 'hmac-sha256', header: 'X-Workflow-Signature' };
  });

  // ---- runs (registered before /:id so 'runs' isn't captured as an id) ----
  app.get('/workflows/runs/:runId', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { runId } = req.params as { runId: string };
    const res = await tenantScoped(req, (trx) => getWorkflowRun(auth.customer_id, runId, trx));
    if (!res) return reply.code(404).send({ error: 'not_found' });
    return res;
  });

  app.post('/workflows/runs/:runId/cancel', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { runId } = req.params as { runId: string };
    const res = await tenantScoped(req, (trx) => cancelWorkflowRun(auth.customer_id, runId, trx));
    if (!res.canceled) return reply.code(409).send({ error: 'not_cancelable', message: 'Run not found or already finished.' });
    recordAuditSafe({
      customerId: auth.customer_id,
      apiKeyId: auth.api_key_id,
      actorType: 'api_key',
      action: 'workflow:run_canceled',
      resource: runId,
      ip: req.ip,
    });
    return { canceled: true };
  });

  // ---- collection ---------------------------------------------------------
  app.get('/workflows', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const q = ListQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'validation_failed', details: q.error.flatten() });
    return tenantScoped(req, (trx) => listWorkflows(auth.customer_id, q.data, trx));
  });

  app.post('/workflows', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      const res = await tenantScoped(req, (trx) =>
        createWorkflow(
          {
            customerId: auth.customer_id,
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            definition: parsed.data.definition,
          },
          trx
        )
      );
      recordAuditSafe({
        customerId: auth.customer_id,
        apiKeyId: auth.api_key_id,
        actorType: 'api_key',
        action: 'workflow:created',
        resource: res.id,
        ip: req.ip,
        metadata: { name: parsed.data.name },
      });
      return reply.code(201).send({ id: res.id, warnings: res.validation.warnings });
    } catch (err) {
      if (sendWorkflowError(reply, err)) return;
      throw err;
    }
  });

  app.get('/workflows/:id', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const wf = await tenantScoped(req, (trx) => getWorkflow(auth.customer_id, id, trx));
    if (!wf) return reply.code(404).send({ error: 'not_found' });
    return wf;
  });

  app.put('/workflows/:id', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      const res = await tenantScoped(req, (trx) =>
        updateWorkflow(auth.customer_id, id, {
          name: parsed.data.name,
          description: parsed.data.description,
          definition: parsed.data.definition,
        }, trx)
      );
      return { updated: res.updated, warnings: res.validation?.warnings ?? [] };
    } catch (err) {
      if (sendWorkflowError(reply, err)) return;
      throw err;
    }
  });

  app.delete('/workflows/:id', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const res = await tenantScoped(req, (trx) => archiveWorkflow(auth.customer_id, id, trx));
    if (!res.archived) return reply.code(404).send({ error: 'not_found' });
    await invalidateWorkflowActivityCache(auth.customer_id);
    recordAuditSafe({
      customerId: auth.customer_id,
      apiKeyId: auth.api_key_id,
      actorType: 'api_key',
      action: 'workflow:archived',
      resource: id,
      ip: req.ip,
      metadata: { canceled_runs: res.canceled_runs },
    });
    return { archived: true, canceled_runs: res.canceled_runs };
  });

  // ---- lifecycle ----------------------------------------------------------
  app.post('/workflows/:id/publish', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const parsed = PublishSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      const res = await tenantScoped(req, (trx) =>
        publishWorkflow({ customerId: auth.customer_id, id, notes: parsed.data.notes ?? null }, trx)
      );
      await invalidateWorkflowActivityCache(auth.customer_id);
      recordAuditSafe({
        customerId: auth.customer_id,
        apiKeyId: auth.api_key_id,
        actorType: 'api_key',
        action: 'workflow:published',
        resource: id,
        ip: req.ip,
        metadata: { version: res.version },
      });
      return { published: true, version: res.version, warnings: res.warnings };
    } catch (err) {
      if (sendWorkflowError(reply, err)) return;
      throw err;
    }
  });

  for (const action of ['pause', 'resume'] as const) {
    app.post(`/workflows/:id/${action}`, { preHandler: scope }, async (req, reply) => {
      const auth = req.auth!;
      const { id } = req.params as { id: string };
      try {
        const res = await tenantScoped(req, (trx) => setWorkflowStatus(auth.customer_id, id, action, trx));
        await invalidateWorkflowActivityCache(auth.customer_id);
        recordAuditSafe({
          customerId: auth.customer_id,
          apiKeyId: auth.api_key_id,
          actorType: 'api_key',
          action: `workflow:${action}d`,
          resource: id,
          ip: req.ip,
        });
        return { status: res.status };
      } catch (err) {
        if (sendWorkflowError(reply, err)) return;
        throw err;
      }
    });
  }

  // ---- versions -----------------------------------------------------------
  app.get('/workflows/:id/versions', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    try {
      const versions = await tenantScoped(req, (trx) => listWorkflowVersions(auth.customer_id, id, trx));
      return { versions };
    } catch (err) {
      if (sendWorkflowError(reply, err)) return;
      throw err;
    }
  });

  app.get('/workflows/:id/versions/:version', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { id, version } = req.params as { id: string; version: string };
    const v = Number(version);
    if (!Number.isInteger(v) || v < 1) return reply.code(400).send({ error: 'invalid_version' });
    const row = await tenantScoped(req, (trx) => getWorkflowVersion(auth.customer_id, id, v, trx));
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return row;
  });

  app.post('/workflows/:id/versions/:version/restore', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { id, version } = req.params as { id: string; version: string };
    const v = Number(version);
    if (!Number.isInteger(v) || v < 1) return reply.code(400).send({ error: 'invalid_version' });
    try {
      await tenantScoped(req, (trx) => restoreWorkflowVersion(auth.customer_id, id, v, trx));
      recordAuditSafe({
        customerId: auth.customer_id,
        apiKeyId: auth.api_key_id,
        actorType: 'api_key',
        action: 'workflow:version_restored',
        resource: id,
        ip: req.ip,
        metadata: { version: v },
      });
      return { restored: true, version: v };
    } catch (err) {
      if (sendWorkflowError(reply, err)) return;
      throw err;
    }
  });

  // ---- external trigger ---------------------------------------------------
  app.post(
    '/workflows/:id/trigger',
    {
      config: {
        rateLimit: {
          max: Number(process.env.WORKFLOW_TRIGGER_RATE_LIMIT_PER_MINUTE ?? 600),
          timeWindow: '1 minute',
        },
      },
      preHandler: scope,
    },
    async (req, reply) => {
      const auth = req.auth!;
      const { id } = req.params as { id: string };
      const parsed = TriggerSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

      const res = await tenantScoped(req, (trx) =>
        triggerWorkflowRun(
          {
            customerId: auth.customer_id,
            workflowId: id,
            subjectEmail: parsed.data.subject_email,
            source: 'api',
            context: parsed.data.context,
          },
          trx
        )
      );
      if (!res.started) {
        const status = res.skipped_reason === 'workflow_not_active' ? 404 : 409;
        return reply.code(status).send({ error: 'not_started', reason: res.skipped_reason });
      }
      // Enqueued only after the tenant transaction committed (the worker
      // could otherwise race commit visibility).
      await kickWorkflowRun(res.run_id!, auth.customer_id);
      return reply.code(202).send({ started: true, run_id: res.run_id });
    }
  );

  // ---- simulation ---------------------------------------------------------
  app.post('/workflows/:id/simulate', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const parsed = SimulateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });

    let rawDef: unknown = parsed.data.definition;
    if (rawDef === undefined) {
      const wf = await tenantScoped(req, (trx) => getWorkflow(auth.customer_id, id, trx));
      if (!wf) return reply.code(404).send({ error: 'not_found' });
      rawDef = parsed.data.source === 'published' ? wf.published_definition : wf.draft_definition;
      if (!rawDef) return reply.code(409).send({ error: 'not_published', message: 'No published version to simulate.' });
    }

    const v = validateWorkflowDefinition(rawDef, { strict: true });
    if (!v.valid || !v.definition) {
      return reply.code(400).send({ error: 'invalid_definition', details: v.errors });
    }
    const result = simulateWorkflow(v.definition, {
      subject_email: parsed.data.subject_email,
      context: parsed.data.context,
      trigger_payload: parsed.data.trigger_payload,
      event_outcomes: parsed.data.event_outcomes,
    });
    return { simulation: result, warnings: v.warnings };
  });

  // ---- runs + stats per workflow ------------------------------------------
  app.get('/workflows/:id/runs', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    const q = RunsQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'validation_failed', details: q.error.flatten() });
    return tenantScoped(req, (trx) =>
      listWorkflowRuns(auth.customer_id, { workflowId: id, status: q.data.status, subjectEmail: q.data.subject_email, limit: q.data.limit, offset: q.data.offset }, trx)
    );
  });

  app.get('/workflows/:id/stats', { preHandler: scope }, async (req, reply) => {
    const auth = req.auth!;
    const { id } = req.params as { id: string };
    try {
      return await tenantScoped(req, (trx) => getWorkflowStats(auth.customer_id, id, trx));
    } catch (err) {
      if (sendWorkflowError(reply, err)) return;
      throw err;
    }
  });
};
