// Workflow management service, org-scoped. Shared by the API-key routes
// (requireScope('workflows')) so route handlers stay thin; every query
// filters by customer_id and accepts a tenant executor so API callers keep
// fail-closed RLS coverage (same convention as webhooks.ts).
//
// Lifecycle: draft -> (publish) -> active <-> paused -> archived.
// The draft_definition is the working copy the builder edits; publishing
// snapshots it into workflow_versions (immutable, append-only "Version
// history") and denormalizes the trigger + re-entry settings onto the
// workflow row for the event dispatcher's hot path.

import { sql } from 'kysely';
import { db } from './db.js';
import type { TenantExecutor } from './tenant-context.js';
import { withTenant } from './tenant-context.js';
import { resolveAndAssertPublicUrl, SsrfError } from './ssrf.js';
import {
  validateWorkflowDefinition,
  type DefinitionValidation,
  type WorkflowDefinition,
} from './workflow-definition.js';

export class WorkflowError extends Error {
  constructor(public code: string, message?: string, public details?: unknown) {
    super(message ?? code);
    this.name = 'WorkflowError';
  }
}

function runForTenant<T>(
  customerId: string,
  executor: TenantExecutor | undefined,
  fn: (trx: TenantExecutor) => Promise<T>
): Promise<T> {
  return executor ? fn(executor) : withTenant(customerId, fn);
}

const WORKFLOW_COLS = [
  'id', 'name', 'description', 'status', 'published_version', 'published_version_id',
  'trigger_type', 'trigger_event_type', 'allow_reentry', 'reentry_cooldown_seconds',
  'created_at', 'updated_at',
] as const;

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string | null;
  status: string;
  published_version: number | null;
  trigger_type: string | null;
  trigger_event_type: string | null;
  created_at: Date;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createWorkflow(
  input: {
    customerId: string;
    name: string;
    description?: string | null;
    definition?: unknown;
    createdByUserId?: string | null;
  },
  executor?: TenantExecutor
): Promise<{ id: string; validation: DefinitionValidation }> {
  const validation = validateWorkflowDefinition(input.definition ?? emptyDefinition(), { strict: false });
  if (!validation.valid) throw new WorkflowError('invalid_definition', 'Definition failed validation', validation.errors);

  try {
    const row = await runForTenant(input.customerId, executor, (trx) =>
      trx
        .insertInto('workflows')
        .values({
          customer_id: input.customerId,
          name: input.name,
          description: input.description ?? null,
          draft_definition: validation.definition as unknown as Record<string, unknown>,
          created_by_user_id: input.createdByUserId ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    );
    return { id: row.id, validation };
  } catch (err: any) {
    if (err?.code === '23505') throw new WorkflowError('name_exists', `A workflow named '${input.name}' already exists`);
    throw err;
  }
}

export async function listWorkflows(
  customerId: string,
  opts: { status?: string; limit?: number; offset?: number } = {},
  executor?: TenantExecutor
): Promise<{ workflows: Array<WorkflowSummary & { active_runs: number; total_runs: number }>; total: number }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const offset = Math.max(0, opts.offset ?? 0);
  return runForTenant(customerId, executor, async (trx) => {
    let q = trx.selectFrom('workflows').where('customer_id', '=', customerId);
    if (opts.status) q = q.where('status', '=', opts.status as any);

    const [rows, totalRow] = await Promise.all([
      q.select([...WORKFLOW_COLS]).orderBy('updated_at', 'desc').limit(limit).offset(offset).execute(),
      q.select(sql<number>`count(*)`.as('c')).executeTakeFirst(),
    ]);

    // Run counts for the list view, one grouped query for the page's ids.
    const ids = rows.map((r) => r.id);
    const counts = ids.length
      ? await trx
          .selectFrom('workflow_runs')
          .select([
            'workflow_id',
            sql<number>`count(*)`.as('total'),
            sql<number>`count(*) FILTER (WHERE status IN ('running','waiting_delay','waiting_event'))`.as('active'),
          ])
          .where('customer_id', '=', customerId)
          .where('workflow_id', 'in', ids)
          .groupBy('workflow_id')
          .execute()
      : [];
    const byId = new Map(counts.map((c) => [c.workflow_id, c]));

    return {
      workflows: rows.map((r) => ({
        ...(r as unknown as WorkflowSummary),
        active_runs: Number(byId.get(r.id)?.active ?? 0),
        total_runs: Number(byId.get(r.id)?.total ?? 0),
      })),
      total: Number(totalRow?.c ?? 0),
    };
  });
}

export async function getWorkflow(
  customerId: string,
  id: string,
  executor?: TenantExecutor
): Promise<(WorkflowSummary & { draft_definition: unknown; published_definition: unknown | null }) | null> {
  return runForTenant(customerId, executor, async (trx) => {
    const row = await trx
      .selectFrom('workflows')
      .select([...WORKFLOW_COLS, 'draft_definition'])
      .where('id', '=', id)
      .where('customer_id', '=', customerId)
      .executeTakeFirst();
    if (!row) return null;

    let published: unknown = null;
    if (row.published_version_id) {
      const v = await trx
        .selectFrom('workflow_versions')
        .select('definition')
        .where('id', '=', row.published_version_id)
        .where('customer_id', '=', customerId)
        .executeTakeFirst();
      published = v?.definition ?? null;
    }
    return { ...(row as any), published_definition: published };
  });
}

export async function updateWorkflow(
  customerId: string,
  id: string,
  patch: { name?: string; description?: string | null; definition?: unknown },
  executor?: TenantExecutor
): Promise<{ updated: boolean; validation?: DefinitionValidation }> {
  const set: Record<string, unknown> = {};
  let validation: DefinitionValidation | undefined;

  if (patch.definition !== undefined) {
    validation = validateWorkflowDefinition(patch.definition, { strict: false });
    if (!validation.valid) throw new WorkflowError('invalid_definition', 'Definition failed validation', validation.errors);
    set.draft_definition = validation.definition;
  }
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (Object.keys(set).length === 0) return { updated: false, validation };

  try {
    const res = await runForTenant(customerId, executor, (trx) =>
      trx
        .updateTable('workflows')
        .set(set as any)
        .where('id', '=', id)
        .where('customer_id', '=', customerId)
        .where('status', '!=', 'archived')
        .returning('id')
        .executeTakeFirst()
    );
    if (!res) throw new WorkflowError('not_found', 'Workflow not found (or archived)');
    return { updated: true, validation };
  } catch (err: any) {
    if (err?.code === '23505') throw new WorkflowError('name_exists', 'A workflow with that name already exists');
    throw err;
  }
}

/**
 * Archive a workflow: stops new entries immediately and cancels in-flight
 * runs. History (versions, finished runs, step logs) is retained.
 */
export async function archiveWorkflow(
  customerId: string,
  id: string,
  executor?: TenantExecutor
): Promise<{ archived: boolean; canceled_runs: number }> {
  return runForTenant(customerId, executor, async (trx) => {
    const res = await trx
      .updateTable('workflows')
      .set({ status: 'archived' })
      .where('id', '=', id)
      .where('customer_id', '=', customerId)
      .where('status', '!=', 'archived')
      .returning('id')
      .executeTakeFirst();
    if (!res) return { archived: false, canceled_runs: 0 };

    const canceled = await trx
      .updateTable('workflow_runs')
      .set({ status: 'canceled', finished_at: new Date(), wake_at: null, waiting_event_types: null })
      .where('workflow_id', '=', id)
      .where('customer_id', '=', customerId)
      .where('status', 'in', ['running', 'waiting_delay', 'waiting_event'])
      .returning('id')
      .execute();
    return { archived: true, canceled_runs: canceled.length };
  });
}

// ---------------------------------------------------------------------------
// Publish / lifecycle
// ---------------------------------------------------------------------------

function emptyDefinition(): WorkflowDefinition {
  return {
    trigger: { type: 'api' },
    entry_step_id: null,
    steps: [],
    settings: { allow_reentry: false, reentry_cooldown_seconds: 0 },
  };
}

/**
 * Publish the draft definition: strict-validate, verify referenced resources
 * (templates belong to the tenant, webhook URLs pass the SSRF gate), snapshot
 * an immutable version, denormalize trigger + re-entry settings, activate.
 */
export async function publishWorkflow(
  input: { customerId: string; id: string; notes?: string | null; publishedByUserId?: string | null },
  executor?: TenantExecutor
): Promise<{ version: number; version_id: string; warnings: DefinitionValidation['warnings'] }> {
  const { customerId, id } = input;

  const wf = await runForTenant(customerId, executor, (trx) =>
    trx
      .selectFrom('workflows')
      .select(['id', 'status', 'draft_definition'])
      .where('id', '=', id)
      .where('customer_id', '=', customerId)
      .executeTakeFirst()
  );
  if (!wf) throw new WorkflowError('not_found', 'Workflow not found');
  if (wf.status === 'archived') throw new WorkflowError('archived', 'Archived workflows cannot be published');

  const validation = validateWorkflowDefinition(wf.draft_definition, { strict: true });
  if (!validation.valid || !validation.definition) {
    throw new WorkflowError('invalid_definition', 'Definition failed strict validation', validation.errors);
  }
  const def = validation.definition;

  // Referenced templates must exist in this tenant — a published version must
  // never fail at send time on a dangling template id.
  const templateIds = [...new Set(def.steps.filter((s) => s.type === 'send_email').map((s: any) => s.template_id as string))];
  if (templateIds.length > 0) {
    const found = await runForTenant(customerId, executor, (trx) =>
      trx
        .selectFrom('templates')
        .select('id')
        .where('customer_id', '=', customerId)
        .where('id', 'in', templateIds)
        .execute()
    );
    const foundSet = new Set(found.map((t) => t.id));
    const missing = templateIds.filter((t) => !foundSet.has(t));
    if (missing.length > 0) {
      throw new WorkflowError('unknown_template', `send_email step references unknown template(s): ${missing.join(', ')}`);
    }
  }

  // Webhook URLs: DNS-resolving SSRF gate at publish time for immediate
  // feedback (also re-checked at delivery, matching webhooks.ts). Network I/O
  // happens before the write transaction below.
  for (const step of def.steps) {
    if (step.type !== 'webhook') continue;
    try {
      await resolveAndAssertPublicUrl(step.url);
    } catch (err) {
      if (err instanceof SsrfError) {
        throw new WorkflowError('invalid_webhook_url', `Step '${step.id}': ${err.message}`);
      }
      throw err;
    }
  }

  return runForTenant(customerId, executor, async (trx) => {
    const last = await trx
      .selectFrom('workflow_versions')
      .select(sql<number>`COALESCE(MAX(version), 0)`.as('v'))
      .where('workflow_id', '=', id)
      .where('customer_id', '=', customerId)
      .executeTakeFirst();
    const nextVersion = Number(last?.v ?? 0) + 1;

    const version = await trx
      .insertInto('workflow_versions')
      .values({
        workflow_id: id,
        customer_id: customerId,
        version: nextVersion,
        definition: def as unknown as Record<string, unknown>,
        notes: input.notes ?? null,
        published_by_user_id: input.publishedByUserId ?? null,
      })
      .returning(['id', 'version'])
      .executeTakeFirstOrThrow();

    await trx
      .updateTable('workflows')
      .set({
        status: 'active',
        published_version_id: version.id,
        published_version: version.version,
        trigger_type: def.trigger.type,
        trigger_event_type: def.trigger.type === 'event' ? def.trigger.event_type : null,
        allow_reentry: def.settings.allow_reentry,
        reentry_cooldown_seconds: def.settings.reentry_cooldown_seconds,
      })
      .where('id', '=', id)
      .where('customer_id', '=', customerId)
      .execute();

    return { version: version.version, version_id: version.id, warnings: validation.warnings };
  });
}

export async function setWorkflowStatus(
  customerId: string,
  id: string,
  action: 'pause' | 'resume',
  executor?: TenantExecutor
): Promise<{ status: string }> {
  const from = action === 'pause' ? 'active' : 'paused';
  const to = action === 'pause' ? 'paused' : 'active';
  const res = await runForTenant(customerId, executor, (trx) =>
    trx
      .updateTable('workflows')
      .set({ status: to })
      .where('id', '=', id)
      .where('customer_id', '=', customerId)
      .where('status', '=', from)
      .returning('status')
      .executeTakeFirst()
  );
  if (!res) {
    const current = await runForTenant(customerId, executor, (trx) =>
      trx.selectFrom('workflows').select('status').where('id', '=', id).where('customer_id', '=', customerId).executeTakeFirst()
    );
    if (!current) throw new WorkflowError('not_found', 'Workflow not found');
    throw new WorkflowError('invalid_state', `Cannot ${action} a workflow in status '${current.status}'`);
  }
  return { status: res.status };
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export async function listWorkflowVersions(
  customerId: string,
  workflowId: string,
  executor?: TenantExecutor
): Promise<Array<{ id: string; version: number; notes: string | null; created_at: Date; is_published: boolean }>> {
  return runForTenant(customerId, executor, async (trx) => {
    const wf = await trx
      .selectFrom('workflows')
      .select('published_version_id')
      .where('id', '=', workflowId)
      .where('customer_id', '=', customerId)
      .executeTakeFirst();
    if (!wf) throw new WorkflowError('not_found', 'Workflow not found');
    const rows = await trx
      .selectFrom('workflow_versions')
      .select(['id', 'version', 'notes', 'created_at'])
      .where('workflow_id', '=', workflowId)
      .where('customer_id', '=', customerId)
      .orderBy('version', 'desc')
      .execute();
    return rows.map((r) => ({ ...r, is_published: r.id === wf.published_version_id })) as unknown as Array<{
      id: string; version: number; notes: string | null; created_at: Date; is_published: boolean;
    }>;
  });
}

export async function getWorkflowVersion(
  customerId: string,
  workflowId: string,
  version: number,
  executor?: TenantExecutor
): Promise<{ id: string; version: number; definition: unknown; notes: string | null; created_at: Date } | null> {
  const row = await runForTenant(customerId, executor, (trx) =>
    trx
      .selectFrom('workflow_versions')
      .select(['id', 'version', 'definition', 'notes', 'created_at'])
      .where('workflow_id', '=', workflowId)
      .where('customer_id', '=', customerId)
      .where('version', '=', version)
      .executeTakeFirst()
  );
  return (row ?? null) as { id: string; version: number; definition: unknown; notes: string | null; created_at: Date } | null;
}

/** Copy a historical version's definition back into the draft for re-editing/republish. */
export async function restoreWorkflowVersion(
  customerId: string,
  workflowId: string,
  version: number,
  executor?: TenantExecutor
): Promise<{ restored: boolean }> {
  return runForTenant(customerId, executor, async (trx) => {
    const v = await trx
      .selectFrom('workflow_versions')
      .select('definition')
      .where('workflow_id', '=', workflowId)
      .where('customer_id', '=', customerId)
      .where('version', '=', version)
      .executeTakeFirst();
    if (!v) throw new WorkflowError('not_found', 'Version not found');
    const res = await trx
      .updateTable('workflows')
      .set({ draft_definition: v.definition as any })
      .where('id', '=', workflowId)
      .where('customer_id', '=', customerId)
      .where('status', '!=', 'archived')
      .returning('id')
      .executeTakeFirst();
    if (!res) throw new WorkflowError('not_found', 'Workflow not found (or archived)');
    return { restored: true };
  });
}

// ---------------------------------------------------------------------------
// Runs (read/cancel — creation lives in workflow-engine.ts)
// ---------------------------------------------------------------------------

const RUN_COLS = [
  'id', 'workflow_id', 'version', 'subject_email', 'status', 'current_step_id',
  'trigger_source', 'wake_at', 'steps_executed', 'goal_met_at', 'goal_step_id',
  'error', 'started_at', 'finished_at',
] as const;

export async function listWorkflowRuns(
  customerId: string,
  opts: { workflowId?: string; status?: string; subjectEmail?: string; limit?: number; offset?: number } = {},
  executor?: TenantExecutor
): Promise<{ runs: any[]; total: number }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const offset = Math.max(0, opts.offset ?? 0);
  return runForTenant(customerId, executor, async (trx) => {
    let q = trx.selectFrom('workflow_runs').where('customer_id', '=', customerId);
    if (opts.workflowId) q = q.where('workflow_id', '=', opts.workflowId);
    if (opts.status) q = q.where('status', '=', opts.status as any);
    if (opts.subjectEmail) q = q.where('subject_email', '=', opts.subjectEmail.toLowerCase());
    const [rows, totalRow] = await Promise.all([
      q.select([...RUN_COLS]).orderBy('started_at', 'desc').limit(limit).offset(offset).execute(),
      q.select(sql<number>`count(*)`.as('c')).executeTakeFirst(),
    ]);
    return { runs: rows, total: Number(totalRow?.c ?? 0) };
  });
}

export async function getWorkflowRun(
  customerId: string,
  runId: string,
  executor?: TenantExecutor
): Promise<{ run: any; steps: any[] } | null> {
  return runForTenant(customerId, executor, async (trx) => {
    const run = await trx
      .selectFrom('workflow_runs')
      .select([...RUN_COLS, 'context', 'waiting_event_types'])
      .where('id', '=', runId)
      .where('customer_id', '=', customerId)
      .executeTakeFirst();
    if (!run) return null;
    const steps = await trx
      .selectFrom('workflow_run_steps')
      .select(['step_id', 'step_type', 'seq', 'status', 'result', 'error', 'executed_at'])
      .where('run_id', '=', runId)
      .where('customer_id', '=', customerId)
      .orderBy('seq', 'asc')
      .execute();
    return { run, steps };
  });
}

export async function cancelWorkflowRun(
  customerId: string,
  runId: string,
  executor?: TenantExecutor
): Promise<{ canceled: boolean }> {
  const res = await runForTenant(customerId, executor, (trx) =>
    trx
      .updateTable('workflow_runs')
      .set({ status: 'canceled', finished_at: new Date(), wake_at: null, waiting_event_types: null })
      .where('id', '=', runId)
      .where('customer_id', '=', customerId)
      .where('status', 'in', ['running', 'waiting_delay', 'waiting_event'])
      .returning('id')
      .executeTakeFirst()
  );
  return { canceled: !!res };
}

// ---------------------------------------------------------------------------
// Stats (powers the builder overlay + workflow dashboard)
// ---------------------------------------------------------------------------

export async function getWorkflowStats(
  customerId: string,
  workflowId: string,
  executor?: TenantExecutor
): Promise<{
  runs: Record<string, number>;
  goal: { met: number };
  steps: Array<{ step_id: string; version: number; entered: number; completed: number; failed: number }>;
}> {
  return runForTenant(customerId, executor, async (trx) => {
    const wf = await trx
      .selectFrom('workflows')
      .select(['id', 'published_version'])
      .where('id', '=', workflowId)
      .where('customer_id', '=', customerId)
      .executeTakeFirst();
    if (!wf) throw new WorkflowError('not_found', 'Workflow not found');

    const runRows = await trx
      .selectFrom('workflow_runs')
      .select(['status', sql<number>`count(*)`.as('c')])
      .where('workflow_id', '=', workflowId)
      .where('customer_id', '=', customerId)
      .groupBy('status')
      .execute();
    const goalRow = await trx
      .selectFrom('workflow_runs')
      .select(sql<number>`count(*)`.as('c'))
      .where('workflow_id', '=', workflowId)
      .where('customer_id', '=', customerId)
      .where('goal_met_at', 'is not', null)
      .executeTakeFirst();

    let steps: Array<{ step_id: string; version: number; entered: number; completed: number; failed: number }> = [];
    if (wf.published_version != null) {
      const statRows = await trx
        .selectFrom('workflow_step_stats')
        .select(['step_id', 'version', 'entered', 'completed', 'failed'])
        .where('workflow_id', '=', workflowId)
        .where('customer_id', '=', customerId)
        .where('version', '=', wf.published_version)
        .execute();
      steps = statRows.map((r) => ({
        step_id: r.step_id,
        version: r.version,
        entered: Number(r.entered),
        completed: Number(r.completed),
        failed: Number(r.failed),
      }));
    }

    const runs: Record<string, number> = {};
    for (const r of runRows) runs[r.status] = Number(r.c);
    return { runs, goal: { met: Number(goalRow?.c ?? 0) }, steps };
  });
}
