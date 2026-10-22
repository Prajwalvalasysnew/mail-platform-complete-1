// Workflow execution engine.
//
// Durability model (same philosophy as the send outbox): workflow_runs rows
// are the source of truth for every run's position; BullMQ jobs are only the
// fast path that moves them. Every state transition happens in a Postgres
// transaction that re-verifies the run row FOR UPDATE, so duplicate or stale
// jobs (Redis retry, sweep re-arm, event/timeout race) collapse into no-ops.
//
// Side-effect semantics per step type:
//   send_email — exactly-once: the message row + queued event + send_outbox
//                row commit atomically with the run advancement, and actual
//                delivery flows through the existing outbox -> send worker
//                pipeline.
//   webhook    — at-least-once: the HTTP POST happens before the advancement
//                commit (never inside it — no holding a txn across network
//                I/O), so a crash in between can repeat it. Receivers get a
//                unique delivery id header to dedupe on.
//   suppress / goal / condition / delay — pure DB, transactional.
//
// The scheduler owns two recovery sweeps (see worker/scheduler.ts):
//   sweepOverdueWorkflowRuns  — re-arms waiting runs whose delayed Redis job
//                               was lost (wake_at is durable in Postgres).
//   recoverStuckWorkflowRuns  — re-enqueues 'running' runs whose advance job
//                               vanished between the DB write and Redis add.

import crypto from 'node:crypto';
import { sql } from 'kysely';
import { db } from './db.js';
import { workflowQueue, type WorkflowJobData } from './queues.js';
import { generateMessageId } from './crypto.js';
import { renderTemplate } from './templates.js';
import { isSuppressed, addSuppression, removeSuppression } from './suppression.js';
import { reserveQuota, releaseQuota } from './quota.js';
import { scanContent } from './abuse.js';
import { createSendOutboxRows, drainSendOutbox } from './outbox.js';
import { resolveAndAssertPublicUrl, SsrfError } from './ssrf.js';
import { redis } from './redis.js';
import {
  workflowRunsStarted,
  workflowRunsFinished,
  workflowStepsExecuted,
  workflowSweepRecovered,
  workflowDefinitionCacheEvents,
  workflowDefinitionCacheSize,
} from './metrics.js';
import {
  WorkflowDefinitionSchema,
  evaluateRules,
  splitBranchForKey,
  type WorkflowDefinition,
  type WorkflowStep,
} from './workflow-definition.js';
import type { WorkflowRunStatus } from './schema.js';
import { loadContactBag, loadContactBags, applyContactUpdate, workflowRenderVariables, type ContactBag } from './workflow-contacts.js';
import { inWindow, nextWindowStart, nextClockTime, resolveTimeZone, parseDateValue, localDate, type ClockWindow } from './workflow-time.js';
import { resolveField, customEventKey } from './workflow-definition.js';

type DbLike = typeof db;

// Safety caps (env-tunable).
const MAX_STEPS_PER_RUN = Number(process.env.WORKFLOW_MAX_STEPS_PER_RUN ?? 200);
const STEP_BUDGET_PER_JOB = Number(process.env.WORKFLOW_STEP_BUDGET_PER_JOB ?? 25);
const MAX_ACTIVE_RUNS_PER_WORKFLOW = Number(process.env.WORKFLOW_MAX_ACTIVE_RUNS_PER_WORKFLOW ?? 50_000);
const QUOTA_RETRY_MINUTES = Number(process.env.WORKFLOW_QUOTA_RETRY_MINUTES ?? 60);
const MAX_QUOTA_RETRIES = Number(process.env.WORKFLOW_MAX_QUOTA_RETRIES ?? 24);
const WEBHOOK_TIMEOUT_MS = Number(process.env.WORKFLOW_WEBHOOK_TIMEOUT_MS ?? 10_000);
const WEBHOOK_RETRY_MINUTES = Number(process.env.WORKFLOW_WEBHOOK_RETRY_MINUTES ?? 5);
const MAX_WEBHOOK_RETRIES = Number(process.env.WORKFLOW_WEBHOOK_MAX_RETRIES ?? 5);
const STUCK_RUN_MINUTES = Number(process.env.WORKFLOW_STUCK_RUN_MINUTES ?? 10);

export interface TriggerRunInput {
  customerId: string;
  workflowId: string;
  subjectEmail: string;
  source: 'event' | 'api' | 'manual' | 'test' | 'audience' | 'schedule';
  triggerPayload?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface TriggerRunResult {
  started: boolean;
  run_id?: string;
  skipped_reason?:
    | 'workflow_not_active'
    | 'not_published'
    | 'already_active'
    | 'reentry_blocked'
    | 'reentry_cooldown'
    | 'capacity'
    | 'customer_inactive'
    | 'entry_filtered'
    | 'not_subscribed';
}

/** Settings.entry: subscription requirement and entry rules. Returns a skip reason or null. */
async function screenEntry(
  def: WorkflowDefinition,
  customerId: string,
  email: string,
  contact: ContactBag,
  trigger: Record<string, unknown>,
  context: Record<string, unknown>
): Promise<'entry_filtered' | 'not_subscribed' | null> {
  const entry = def.settings.entry;
  if (!entry) return null;
  if (entry.require_subscribed && (contact.status !== 'Subscribed' || (await isSuppressed(customerId, email)))) return 'not_subscribed';
  if (entry.rules.length && !evaluateRules({ subject: { email }, contact, trigger, context }, entry.rules, entry.match)) return 'entry_filtered';
  return null;
}

function parseDefinition(raw: unknown): WorkflowDefinition {
  // Stored definitions were validated at write time; parse (not safeParse) so
  // corruption fails loudly instead of executing a half-understood graph.
  return WorkflowDefinitionSchema.parse(raw);
}

// Published workflow versions are immutable. Cache their validated runtime
// representation by version id so engagement events do not repeatedly run a
// full Zod graph parse. The insertion-ordered Map is a small dependency-free
// LRU; the cap prevents a high-cardinality multi-tenant workload from growing
// process memory without bound.
const parsedDefinitionCache = new Map<string, WorkflowDefinition>();

function workflowDefinitionCacheMax(): number {
  const configured = Number(process.env.WORKFLOW_DEFINITION_CACHE_MAX ?? 10_000);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 10_000;
}

export function cachedWorkflowDefinition(versionId: string, raw: unknown): WorkflowDefinition {
  const cached = parsedDefinitionCache.get(versionId);
  if (cached) {
    parsedDefinitionCache.delete(versionId);
    parsedDefinitionCache.set(versionId, cached);
    workflowDefinitionCacheEvents.inc({ event: 'hit' });
    return cached;
  }

  workflowDefinitionCacheEvents.inc({ event: 'miss' });
  const parsed = parseDefinition(raw);
  const max = workflowDefinitionCacheMax();
  while (parsedDefinitionCache.size >= max) {
    const oldest = parsedDefinitionCache.keys().next().value as string | undefined;
    if (!oldest) break;
    parsedDefinitionCache.delete(oldest);
    workflowDefinitionCacheEvents.inc({ event: 'eviction' });
  }
  parsedDefinitionCache.set(versionId, parsed);
  workflowDefinitionCacheSize.set(parsedDefinitionCache.size);
  return parsed;
}

export function clearWorkflowDefinitionCache(): void {
  parsedDefinitionCache.clear();
  workflowDefinitionCacheSize.set(0);
}

export function getWorkflowDefinitionCacheSize(): number {
  return parsedDefinitionCache.size;
}

function stepById(def: WorkflowDefinition, id: string | null): WorkflowStep | null {
  if (id === null) return null;
  return def.steps.find((s) => s.id === id) ?? null;
}

/**
 * Deterministic job id per (run, position) so sweep re-arms dedupe against
 * live jobs. Hyphen-separated: BullMQ rejects custom job ids containing ':'.
 */
function jobId(kind: WorkflowJobData['kind'], runId: string, seq: number): string {
  return `wf-${kind}-${runId}-${seq}`;
}

async function enqueue(kind: WorkflowJobData['kind'], run: { id: string; customer_id: string }, opts: { delayMs?: number; seq: number; stepId?: string; uniqueSuffix?: string }) {
  await workflowQueue.add(
    kind,
    { kind, run_id: run.id, customer_id: run.customer_id, step_id: opts.stepId },
    {
      jobId: jobId(kind, run.id, opts.seq) + (opts.uniqueSuffix ?? ''),
      delay: opts.delayMs && opts.delayMs > 0 ? opts.delayMs : undefined,
    }
  );
}

// ---------------------------------------------------------------------------
// Run creation
// ---------------------------------------------------------------------------

/**
 * Enqueue the first advance job for a freshly created run. Split from
 * triggerWorkflowRun so API routes can call it AFTER their tenant transaction
 * commits (enqueueing inside the txn would race the worker against commit
 * visibility). Failures are safe to swallow: recoverStuckWorkflowRuns re-arms.
 */
export async function kickWorkflowRun(runId: string, customerId: string): Promise<void> {
  try {
    await enqueue('advance', { id: runId, customer_id: customerId }, { seq: 0 });
  } catch {
    /* sweep recovers */
  }
}

/**
 * Start a run for a subject, honoring the re-entry policy and capacity caps.
 *
 * `executor` matters for RLS: worker/event-dispatch callers omit it (service
 * role), while API routes MUST pass their tenant transaction — the workflow
 * tables are fail-closed, so global-db reads from the API role see nothing.
 * When an executor is provided the advance job is NOT enqueued (the caller's
 * transaction hasn't committed yet); call kickWorkflowRun after commit.
 */
export async function triggerWorkflowRun(
  input: TriggerRunInput,
  executor?: DbLike
): Promise<TriggerRunResult> {
  const subject = input.subjectEmail.toLowerCase();
  const exec = executor ?? db;
  const deferKick = executor !== undefined;

  const wf = await exec
    .selectFrom('workflows')
    .innerJoin('customers', 'customers.id', 'workflows.customer_id')
    .select([
      'workflows.id as id',
      'workflows.status as status',
      'workflows.published_version_id',
      'workflows.published_version',
      'workflows.allow_reentry',
      'workflows.reentry_cooldown_seconds',
      'customers.status as customer_status',
    ])
    .where('workflows.id', '=', input.workflowId)
    .where('workflows.customer_id', '=', input.customerId)
    .executeTakeFirst();

  if (!wf || wf.status !== 'active') return { started: false, skipped_reason: 'workflow_not_active' };
  if (!wf.published_version_id || wf.published_version == null) return { started: false, skipped_reason: 'not_published' };
  if (wf.customer_status !== 'active') return { started: false, skipped_reason: 'customer_inactive' };

  const version = await exec
    .selectFrom('workflow_versions')
    .select(['id', 'version', 'definition'])
    .where('id', '=', wf.published_version_id)
    .executeTakeFirstOrThrow();
  const def = cachedWorkflowDefinition(version.id, version.definition);
  if (!def.entry_step_id) return { started: false, skipped_reason: 'not_published' };

  // Re-entry policy. The partial unique index is the authoritative guard for
  // concurrent triggers; these reads give clean skip reasons for the common
  // paths without racing.
  const lastRun = await exec
    .selectFrom('workflow_runs')
    .select(['id', 'status', 'started_at'])
    .where('workflow_id', '=', input.workflowId)
    .where('subject_email', '=', subject)
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (lastRun) {
    if (['running', 'waiting_delay', 'waiting_event'].includes(lastRun.status)) {
      return { started: false, skipped_reason: 'already_active' };
    }
    if (!wf.allow_reentry) return { started: false, skipped_reason: 'reentry_blocked' };
    const cooldownMs = wf.reentry_cooldown_seconds * 1000;
    if (cooldownMs > 0 && Date.now() - new Date(lastRun.started_at as unknown as string | Date).getTime() < cooldownMs) {
      return { started: false, skipped_reason: 'reentry_cooldown' };
    }
  }

  // Entry screening ("who can enter") against the contact record.
  const contact = await loadContactBag(exec, input.customerId, subject);
  const entry = await screenEntry(def, input.customerId, subject, contact, input.triggerPayload ?? {}, input.context ?? {});
  if (entry) return { started: false, skipped_reason: entry };

  // Blast-radius cap per workflow (a misfiring trigger can't build an
  // unbounded backlog of active journeys).
  const activeCount = await exec
    .selectFrom('workflow_runs')
    .select(sql<number>`count(*)`.as('c'))
    .where('workflow_id', '=', input.workflowId)
    .where('status', 'in', ['running', 'waiting_delay', 'waiting_event'])
    .executeTakeFirst();
  if (Number(activeCount?.c ?? 0) >= MAX_ACTIVE_RUNS_PER_WORKFLOW) {
    return { started: false, skipped_reason: 'capacity' };
  }

  let run: { id: string };
  try {
    run = await exec
      .insertInto('workflow_runs')
      .values({
        customer_id: input.customerId,
        workflow_id: input.workflowId,
        version_id: version.id,
        version: version.version,
        subject_email: subject,
        status: 'running',
        current_step_id: def.entry_step_id,
        trigger_source: input.source,
        context: {
          subject: { email: subject },
          trigger: input.triggerPayload ?? {},
          context: input.context ?? {},
          contact,
        } as any,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  } catch (err: any) {
    // Unique partial index (workflow, subject) active: a concurrent trigger won.
    if (err?.code === '23505') return { started: false, skipped_reason: 'already_active' };
    throw err;
  }

  workflowRunsStarted.inc({ trigger_source: input.source });
  // Fast path; recoverStuckWorkflowRuns re-arms if this Redis add is lost.
  // Deferred when running inside a caller's transaction (see kickWorkflowRun).
  if (!deferKick) await kickWorkflowRun(run.id, input.customerId);
  return { started: true, run_id: run.id };
}

export interface BulkTriggerSubject {
  email: string;
  context?: Record<string, unknown>;
}

export interface BulkTriggerItemResult {
  email: string;
  started: boolean;
  run_id?: string;
  skipped_reason?: TriggerRunResult['skipped_reason'] | 'duplicate_in_request';
}

/**
 * Enroll many subjects in one call (audience-sized entry, the batch analog of
 * triggerWorkflowRun). Workflow/version load, re-entry screening, and the
 * capacity check are each ONE query for the whole batch; eligible subjects
 * are bulk-inserted with ON CONFLICT DO NOTHING so a concurrent single
 * trigger can never double-enroll anyone.
 *
 * Same executor contract as triggerWorkflowRun: API routes pass their tenant
 * transaction and kick the returned run ids after commit.
 */
export async function triggerWorkflowRunsBulk(
  input: {
    customerId: string;
    workflowId: string;
    subjects: BulkTriggerSubject[];
    source: 'event' | 'api' | 'manual' | 'test' | 'audience' | 'schedule';
    triggerPayload?: Record<string, unknown>;
  },
  executor?: DbLike
): Promise<{ results: BulkTriggerItemResult[]; started: number }> {
  const exec = executor ?? db;
  const deferKick = executor !== undefined;

  // Normalize + de-dupe within the request (first occurrence wins).
  const seen = new Set<string>();
  const subjects: BulkTriggerSubject[] = [];
  const results = new Map<string, BulkTriggerItemResult>();
  for (const s of input.subjects) {
    const email = s.email.toLowerCase();
    if (seen.has(email)) continue; // duplicates coalesce into the first entry
    seen.add(email);
    subjects.push({ email, context: s.context });
  }

  const finish = (started: number): { results: BulkTriggerItemResult[]; started: number } => ({
    results: subjects.map((s) => results.get(s.email)!),
    started,
  });
  const skipAll = (reason: TriggerRunResult['skipped_reason']) => {
    for (const s of subjects) results.set(s.email, { email: s.email, started: false, skipped_reason: reason });
    return finish(0);
  };

  const wf = await exec
    .selectFrom('workflows')
    .innerJoin('customers', 'customers.id', 'workflows.customer_id')
    .select([
      'workflows.id as id',
      'workflows.status as status',
      'workflows.published_version_id',
      'workflows.allow_reentry',
      'workflows.reentry_cooldown_seconds',
      'customers.status as customer_status',
    ])
    .where('workflows.id', '=', input.workflowId)
    .where('workflows.customer_id', '=', input.customerId)
    .executeTakeFirst();
  if (!wf || wf.status !== 'active') return skipAll('workflow_not_active');
  if (!wf.published_version_id) return skipAll('not_published');
  if (wf.customer_status !== 'active') return skipAll('customer_inactive');

  const version = await exec
    .selectFrom('workflow_versions')
    .select(['id', 'version', 'definition'])
    .where('id', '=', wf.published_version_id)
    .executeTakeFirstOrThrow();
  const def = cachedWorkflowDefinition(version.id, version.definition);
  if (!def.entry_step_id) return skipAll('not_published');

  // Re-entry screening: latest run per subject in one DISTINCT ON query.
  const emails = subjects.map((s) => s.email);
  const latest = await exec
    .selectFrom('workflow_runs')
    .select(['subject_email', 'status', 'started_at'])
    .distinctOn('subject_email')
    .where('workflow_id', '=', input.workflowId)
    .where('subject_email', 'in', emails)
    .orderBy('subject_email')
    .orderBy('started_at', 'desc')
    .execute();
  const latestBySubject = new Map(latest.map((r) => [r.subject_email, r]));

  const cooldownMs = wf.reentry_cooldown_seconds * 1000;
  const eligible: BulkTriggerSubject[] = [];
  for (const s of subjects) {
    const last = latestBySubject.get(s.email);
    if (last) {
      if (['running', 'waiting_delay', 'waiting_event'].includes(last.status)) {
        results.set(s.email, { email: s.email, started: false, skipped_reason: 'already_active' });
        continue;
      }
      if (!wf.allow_reentry) {
        results.set(s.email, { email: s.email, started: false, skipped_reason: 'reentry_blocked' });
        continue;
      }
      if (cooldownMs > 0 && Date.now() - new Date(last.started_at as unknown as string | Date).getTime() < cooldownMs) {
        results.set(s.email, { email: s.email, started: false, skipped_reason: 'reentry_cooldown' });
        continue;
      }
    }
    eligible.push(s);
  }

  // Entry screening per subject, with one contact query for the batch.
  const contacts = await loadContactBags(exec, input.customerId, eligible.map((s) => s.email));
  const screened: BulkTriggerSubject[] = [];
  for (const s of eligible) {
    const reason = await screenEntry(def, input.customerId, s.email, contacts.get(s.email)!, input.triggerPayload ?? {}, s.context ?? {});
    if (reason) results.set(s.email, { email: s.email, started: false, skipped_reason: reason });
    else screened.push(s);
  }
  eligible.length = 0;
  eligible.push(...screened);

  // Capacity: admit only up to the per-workflow active-run headroom.
  const activeCount = await exec
    .selectFrom('workflow_runs')
    .select(sql<number>`count(*)`.as('c'))
    .where('workflow_id', '=', input.workflowId)
    .where('status', 'in', ['running', 'waiting_delay', 'waiting_event'])
    .executeTakeFirst();
  const headroom = Math.max(0, MAX_ACTIVE_RUNS_PER_WORKFLOW - Number(activeCount?.c ?? 0));
  const admitted = eligible.slice(0, headroom);
  for (const s of eligible.slice(headroom)) {
    results.set(s.email, { email: s.email, started: false, skipped_reason: 'capacity' });
  }

  let started = 0;
  if (admitted.length > 0) {
    // ON CONFLICT DO NOTHING: the partial unique index absorbs races with
    // concurrent single/bulk triggers; conflicting rows simply don't return.
    const inserted = await exec
      .insertInto('workflow_runs')
      .values(
        admitted.map((s) => ({
          customer_id: input.customerId,
          workflow_id: input.workflowId,
          version_id: version.id,
          version: version.version,
          subject_email: s.email,
          status: 'running' as const,
          current_step_id: def.entry_step_id,
          trigger_source: input.source,
          context: {
            subject: { email: s.email },
            trigger: input.triggerPayload ?? {},
            context: s.context ?? {},
            contact: contacts.get(s.email),
          } as any,
        }))
      )
      .onConflict((oc) => oc.doNothing())
      .returning(['id', 'subject_email'])
      .execute();

    const startedBySubject = new Map(inserted.map((r) => [r.subject_email, r.id]));
    for (const s of admitted) {
      const runId = startedBySubject.get(s.email);
      if (runId) {
        results.set(s.email, { email: s.email, started: true, run_id: runId });
        started++;
        workflowRunsStarted.inc({ trigger_source: input.source });
        if (!deferKick) await kickWorkflowRun(runId, input.customerId);
      } else {
        results.set(s.email, { email: s.email, started: false, skipped_reason: 'already_active' });
      }
    }
  }

  return finish(started);
}

// ---------------------------------------------------------------------------
// Step advancement
// ---------------------------------------------------------------------------

type StepOutcome =
  | { kind: 'continue'; sentMessageIds?: string[] }
  | { kind: 'parked'; job:{kind:'wake'|'timeout';run:{id:string;customer_id:string};wakeAt:Date;seq:number;stepId?:string;uniqueSuffix?:string} }
  | { kind: 'finished' }
  | { kind: 'noop' };

interface RunRow {
  id: string;
  customer_id: string;
  workflow_id: string;
  version_id: string;
  version: number;
  subject_email: string;
  status: WorkflowRunStatus;
  current_step_id: string | null;
  context: Record<string, unknown>;
  steps_executed: number;
  goal_met_at: Date | null;
}

const RUN_ENGINE_COLS = [
  'id', 'customer_id', 'workflow_id', 'version_id', 'version', 'subject_email',
  'status', 'current_step_id', 'context', 'steps_executed', 'goal_met_at',
] as const;

async function loadRun(executor: DbLike, runId: string, forUpdate: boolean): Promise<RunRow | undefined> {
  let q = executor
    .selectFrom('workflow_runs')
    .select([...RUN_ENGINE_COLS])
    .where('id', '=', runId);
  if (forUpdate) q = (q as any).forUpdate();
  return (await q.executeTakeFirst()) as RunRow | undefined;
}

async function bumpStepStat(
  trx: DbLike,
  run: RunRow,
  stepId: string,
  field: 'entered' | 'completed' | 'failed'
): Promise<void> {
  await trx
    .insertInto('workflow_step_stats')
    .values({
      workflow_id: run.workflow_id,
      customer_id: run.customer_id,
      version: run.version,
      step_id: stepId,
      entered: field === 'entered' ? 1 : 0,
      completed: field === 'completed' ? 1 : 0,
      failed: field === 'failed' ? 1 : 0,
    } as any)
    .onConflict((oc) =>
      oc.columns(['workflow_id', 'version', 'step_id']).doUpdateSet((eb) => ({
        [field]: eb(`workflow_step_stats.${field}` as any, '+', 1),
        updated_at: new Date(),
      }) as any)
    )
    .execute();
}

function finishStatus(run: RunRow, status: WorkflowRunStatus) {
  workflowRunsFinished.inc({ status });
}

/**
 * Advance a run: execute steps from its current position until it parks
 * (delay/wait), finishes, or exhausts the per-job step budget (then a
 * continuation job takes over — keeps one huge workflow from monopolizing a
 * worker slot).
 */
export async function advanceWorkflowRun(runId: string): Promise<void> {
  const runMeta = await loadRun(db, runId, false);
  if (!runMeta) return;
  // Versions are immutable — load the definition once per job, not per step.
  const versionRow = await db
    .selectFrom('workflow_versions')
    .select(['id', 'definition'])
    .where('id', '=', runMeta.version_id)
    .executeTakeFirst();
  if (!versionRow) return;
  const def = cachedWorkflowDefinition(versionRow.id, versionRow.definition);

  for (let i = 0; i < STEP_BUDGET_PER_JOB; i++) {
    const outcome = await advanceOneStep(runId, def);
    if(outcome.kind==='parked'){
      // The parked row must be committed before a zero-delay job can run.
      // Redis remains best effort; the durable wake_at sweep is the fallback.
      const job=outcome.job;
      try{await enqueue(job.kind,job.run,{seq:job.seq,stepId:job.stepId,uniqueSuffix:job.uniqueSuffix,delayMs:Math.max(0,job.wakeAt.getTime()-Date.now())});}catch{/* sweep recovers */}
    }
    if (outcome.kind === 'continue' && outcome.sentMessageIds?.length) {
      // Best-effort immediate dispatch after the step txn committed; the
      // scheduler's outbox drain is the durable fallback.
      await dispatchPendingWorkflowSends(outcome.sentMessageIds);
    }
    if (outcome.kind !== 'continue') return;
  }

  // Budget exhausted mid-flow: hand off to a continuation job.
  const still = await loadRun(db, runId, false);
  if (still && still.status === 'running') {
    await enqueue('advance', still, { seq: still.steps_executed, uniqueSuffix: '-cont' });
  }
}

async function advanceOneStep(runId: string, def: WorkflowDefinition): Promise<StepOutcome> {
  // Phase 1: read current position (no lock) to run non-transactional
  // pre-work (suppression/quota Redis checks, webhook HTTP) outside the txn.
  const pre = await loadRun(db, runId, false);
  if (!pre || pre.status !== 'running') return { kind: 'noop' };

  const step = stepById(def, pre.current_step_id);
  const goalCfg = def.goal;

  // Loop guard (belt-and-braces on top of DAG validation).
  if (pre.steps_executed >= MAX_STEPS_PER_RUN) {
    await db
      .updateTable('workflow_runs')
      .set({ status: 'failed', error: 'step_limit_exceeded', finished_at: new Date(), wake_at: null })
      .where('id', '=', runId)
      .where('status', '=', 'running')
      .execute();
    finishStatus(pre, 'failed');
    return { kind: 'finished' };
  }

  // No step to execute -> the flow reached its natural end.
  if (!step) {
    const res = await db
      .updateTable('workflow_runs')
      .set({ status: 'completed', finished_at: new Date(), wake_at: null, current_step_id: null })
      .where('id', '=', runId)
      .where('status', '=', 'running')
      .returning('id')
      .executeTakeFirst();
    if (res) finishStatus(pre, 'completed');
    return { kind: 'finished' };
  }

  // Non-transactional side effects, computed before the advancement txn.
  let sideEffect: Record<string, unknown> = {};
  let stepFailed: string | null = null;
  let parkForQuota = false;
  let parkForWebhookRetry = false;
  // Quiet hours / frequency cap: hold the message step without executing it.
  const hold = step.type === 'send_email' || step.type === 'notify' ? await sendingRulesHold(pre, def, step.type) : null;

  if (hold) {
    /* parked below, inside the advancement transaction */
  } else if (step.type === 'send_email') {
    const prep = await prepareSendEmail(pre, step);
    if (prep.kind === 'park_quota') parkForQuota = true;
    else if (prep.kind === 'failed') stepFailed = prep.reason;
    else sideEffect = prep;
  } else if (step.type === 'notify') {
    const prep = await prepareNotify(pre, step);
    if (prep.kind === 'park_quota') parkForQuota = true;
    else if (prep.kind === 'failed') stepFailed = prep.reason;
    else sideEffect = prep;
  } else if (step.type === 'condition') {
    // Conditions see fresh contact data and this run's email engagement.
    sideEffect = { bag: await conditionBag(pre, step.rules) };
  } else if (step.type === 'webhook') {
    const delivery = await deliverWorkflowWebhook(pre, step);
    sideEffect = delivery;
    if (!delivery.ok) {
      // Transient failures (timeout / 5xx / network) get a bounded park-based
      // retry; permanent ones (4xx, SSRF, bad URL) fail through immediately.
      if (isRetryableWebhookFailure(delivery)) parkForWebhookRetry = true;
      else stepFailed = `webhook_failed:${delivery.status ?? delivery.error ?? 'unknown'}`;
    }
  }

  // Phase 2: transactional advancement. Re-verify the run under lock — a
  // cancel/goal-exit/duplicate job between phase 1 and here turns this into a
  // no-op (the message row for send_email is only written inside this txn, so
  // no phantom sends).
  return db.transaction().execute(async (trx): Promise<StepOutcome> => {
    const run = await loadRun(trx as unknown as DbLike, runId, true);
    if (!run || run.status !== 'running' || run.current_step_id !== step.id || run.steps_executed !== pre.steps_executed) {
      return { kind: 'noop' };
    }
    const seq = run.steps_executed + 1;
    const t = trx as unknown as DbLike;

    if (hold) {
      await t
        .updateTable('workflow_runs')
        .set({ status: 'waiting_delay', wake_at: hold.wakeAt })
        .where('id', '=', runId)
        .execute();
      workflowStepsExecuted.inc({ step_type: step.type, outcome: `${hold.reason}_deferred` });
      return { kind: 'parked', job: { kind: 'wake', run, wakeAt: hold.wakeAt, seq: run.steps_executed, stepId: step.id, uniqueSuffix: `-${hold.reason}${hold.wakeAt.getTime()}` } };
    }

    // Quota exhausted: park and retry the same step later (no seq consumed,
    // no 'entered' stat bump — the step hasn't actually executed yet).
    if (parkForQuota) {
      const retries = Number((run.context as any)._quota_retries ?? 0);
      if (retries >= MAX_QUOTA_RETRIES) {
        stepFailed = 'quota_retry_exhausted';
      } else {
        const wakeAt = new Date(Date.now() + QUOTA_RETRY_MINUTES * 60_000);
        await t
          .updateTable('workflow_runs')
          .set({
            status: 'waiting_delay',
            wake_at: wakeAt,
            context: { ...run.context, _quota_retries: retries + 1 } as any,
          })
          .where('id', '=', runId)
          .execute();
        workflowStepsExecuted.inc({ step_type: step.type, outcome: 'quota_deferred' });
        return { kind: 'parked',job:{kind:'wake',run,wakeAt,seq:run.steps_executed,stepId:step.id,uniqueSuffix:`-q${retries+1}`} };
      }
    }

    // Transient webhook failure: park and re-attempt the same step later
    // (no seq consumed — the step hasn't logically executed yet).
    if (parkForWebhookRetry) {
      const retries = Number((run.context as any)._webhook_retries ?? 0);
      if (retries >= MAX_WEBHOOK_RETRIES) {
        stepFailed = `webhook_failed:${(sideEffect as any).status ?? (sideEffect as any).error ?? 'retries_exhausted'}`;
      } else {
        const wakeAt = new Date(Date.now() + WEBHOOK_RETRY_MINUTES * 60_000);
        await t
          .updateTable('workflow_runs')
          .set({
            status: 'waiting_delay',
            wake_at: wakeAt,
            context: { ...run.context, _webhook_retries: retries + 1 } as any,
          })
          .where('id', '=', runId)
          .execute();
        workflowStepsExecuted.inc({ step_type: step.type, outcome: 'webhook_retry_deferred' });
        return { kind: 'parked',job:{kind:'wake',run,wakeAt,seq:run.steps_executed,stepId:step.id,uniqueSuffix:`-w${retries+1}`} };
      }
    }

    await bumpStepStat(t, run, step.id, 'entered');

    let nextStepId: string | null = null;
    let result: Record<string, unknown> = {};
    let ledgerStatus: 'completed' | 'failed' | 'waiting' | 'skipped' = 'completed';
    let park: { status: 'waiting_delay' | 'waiting_event'; wakeAt: Date; waitingEvents?: string[] } | null = null;
    let contextPatch: Record<string, unknown> | null = null;
    let terminal: WorkflowRunStatus | null = null;

    if (stepFailed) {
      ledgerStatus = 'failed';
      result = { ...sideEffect, error: stepFailed };
      // A webhook that failed through (permanent or retries exhausted) must
      // not bequeath its spent retry budget to a later webhook step.
      if (step.type === 'webhook') contextPatch = { _webhook_retries: 0 };
      nextStepId = defaultNext(step);
    } else {
      switch (step.type) {
        case 'delay': {
          const tz = step.deliver_window?.timezone
            ? resolveTimeZone(step.deliver_window.timezone, (run.context as any).contact?.timezone, def.settings.default_timezone)
            : 'UTC';
          const wakeAt = computeWakeAt(new Date(), step.duration_seconds, step.deliver_window, tz);
          park = { status: 'waiting_delay', wakeAt };
          result = { wake_at: wakeAt.toISOString() };
          nextStepId = step.next;
          break;
        }
        case 'condition': {
          const pass = evaluateRules((sideEffect as any).bag ?? run.context, step.rules, step.match);
          result = { branch: pass ? 'on_true' : 'on_false' };
          nextStepId = pass ? step.on_true : step.on_false;
          break;
        }
        case 'split': {
          // Deterministic per (run, step): a re-executed job takes the same
          // branch, preserving effectively-once semantics.
          const branch = splitBranchForKey(`${run.id}:${step.id}`, step.percent_a);
          result = { branch, percent_a: step.percent_a };
          nextStepId = branch === 'a' ? step.branch_a : step.branch_b;
          break;
        }
        case 'wait_for_event': {
          const wakeAt = new Date(Date.now() + step.timeout_seconds * 1000);
          park = { status: 'waiting_event', wakeAt, waitingEvents: step.event_types };
          ledgerStatus = 'waiting';
          result = { waiting_for: step.event_types, timeout_at: wakeAt.toISOString(), scope: step.scope };
          // Branch chosen later by the event dispatcher or the timeout job.
          nextStepId = step.id;
          break;
        }
        case 'send_email': {
          const send = sideEffect as Extract<SendPrep, { kind: 'ready' }>;
          if (send.skip_reason) {
            ledgerStatus = 'skipped';
            result = { skipped: send.skip_reason };
          } else {
            await t
              .insertInto('messages')
              .values({
                message_id: send.message_id!,
                customer_id: run.customer_id,
                from_address: step.from,
                from_name: step.from_name ?? null,
                to_address: run.subject_email,
                reply_to: step.reply_to ?? null,
                subject: send.subject!,
                html_body: send.html ?? null,
                text_body: send.text ?? null,
                headers: {},
                tags: ['workflow'],
                metadata: {
                  workflow_id: run.workflow_id,
                  workflow_run_id: run.id,
                  workflow_step_id: step.id,
                },
                tracking_opens: true,
                tracking_clicks: true,
                ip_pool: 'marketing',
                template_id: step.template_id,
                risk_score: send.risk_score ?? 0,
                status: 'queued',
              } as any)
              .execute();
            await t
              .insertInto('events')
              .values({
                message_id: send.message_id!,
                customer_id: run.customer_id,
                event_type: 'queued',
                payload: { workflow_run_id: run.id },
              } as any)
              .execute();
            await createSendOutboxRows(
              [{ message_id: send.message_id!, customer_id: run.customer_id, priority: send.priority! }],
              t
            );
            const sent = Array.isArray((run.context as any)._sent_message_ids)
              ? [...(run.context as any)._sent_message_ids]
              : [];
            sent.push(send.message_id);
            // Reset the quota-retry budget: it is per send step, not per run.
            contextPatch = { _sent_message_ids: sent.slice(-50), _quota_retries: 0 };
            result = { message_id: send.message_id, template_id: step.template_id };
          }
          nextStepId = step.next;
          break;
        }
        case 'webhook': {
          result = sideEffect;
          // Reset the retry budget — it is per webhook attempt-cycle, not per run.
          contextPatch = { _webhook_retries: 0 };
          nextStepId = step.next;
          break;
        }
        case 'suppress': {
          if (step.action === 'add') {
            await addSuppression(run.customer_id, run.subject_email, 'manual', `workflow:${run.workflow_id}`, t, {
              source: 'workflow',
            });
          } else {
            await removeSuppression(run.customer_id, run.subject_email, t, { source: 'workflow' });
          }
          result = { action: step.action };
          nextStepId = step.next;
          break;
        }
        case 'goal': {
          result = { goal: step.name ?? step.id };
          if (!run.goal_met_at) {
            await t
              .updateTable('workflow_runs')
              .set({ goal_met_at: new Date(), goal_step_id: step.id })
              .where('id', '=', runId)
              .execute();
          }
          nextStepId = step.next;
          break;
        }
        case 'exit': {
          terminal = 'exited';
          result = {};
          nextStepId = null;
          break;
        }
        case 'wait_until': {
          const contact = (run.context as any).contact ?? {};
          const tz = resolveTimeZone(step.timezone, contact.timezone, def.settings.default_timezone);
          let target: Date | null = null;
          if (step.mode === 'time_of_day' && step.time) target = nextClockTime(new Date(), step.time, tz, step.days);
          else if (step.field) {
            const base = parseDateValue(resolveField(run.context, step.field));
            target = base ? new Date(base.getTime() + step.offset_seconds * 1000) : null;
          }
          if (!target || target.getTime() <= Date.now()) {
            result = { missed: true, reason: target ? 'already_passed' : 'date_missing' };
            ledgerStatus = 'skipped';
            if (step.if_missed === 'exit') {
              terminal = 'exited';
              nextStepId = null;
            } else nextStepId = step.next;
          } else {
            park = { status: 'waiting_delay', wakeAt: target };
            result = { wake_at: target.toISOString(), timezone: tz };
            nextStepId = step.next;
          }
          break;
        }
        case 'update_contact': {
          const contact = await applyContactUpdate(t, run.customer_id, run.subject_email, step);
          if (step.status === 'Unsubscribed') {
            await addSuppression(run.customer_id, run.subject_email, 'unsubscribe', `workflow:${run.workflow_id}`, t, { source: 'workflow' });
          }
          contextPatch = { contact };
          result = { tags: contact.tags, attributes: Object.keys(step.set_attributes), status: step.status ?? null };
          nextStepId = step.next;
          break;
        }
        case 'notify': {
          const send = sideEffect as NotifyPrep;
          if (!send.messages.length) {
            ledgerStatus = 'skipped';
            result = { skipped: 'all_recipients_suppressed' };
          } else {
            for (const m of send.messages) {
              await t
                .insertInto('messages')
                .values({
                  message_id: m.message_id, customer_id: run.customer_id, from_address: step.from, from_name: null,
                  to_address: m.to, reply_to: null, subject: send.subject, html_body: null, text_body: send.text,
                  headers: {}, tags: ['workflow', 'notify'],
                  metadata: { workflow_id: run.workflow_id, workflow_run_id: run.id, workflow_step_id: step.id, notify_subject: run.subject_email },
                  tracking_opens: false, tracking_clicks: false, ip_pool: 'transactional', template_id: null,
                  risk_score: send.risk_score, status: 'queued',
                } as any)
                .execute();
              await t.insertInto('events').values({ message_id: m.message_id, customer_id: run.customer_id, event_type: 'queued', payload: { workflow_run_id: run.id } } as any).execute();
            }
            await createSendOutboxRows(send.messages.map((m) => ({ message_id: m.message_id, customer_id: run.customer_id, priority: send.priority })), t);
            result = { message_ids: send.messages.map((m) => m.message_id), to: send.messages.map((m) => m.to) };
          }
          nextStepId = step.next;
          break;
        }
      }
    }

    await t
      .insertInto('workflow_run_steps')
      .values({
        run_id: run.id,
        customer_id: run.customer_id,
        step_id: step.id,
        step_type: step.type,
        seq,
        status: ledgerStatus as any,
        result: result as any,
        error: stepFailed,
      })
      .execute();
    await bumpStepStat(t, run, step.id, stepFailed ? 'failed' : 'completed');
    workflowStepsExecuted.inc({ step_type: step.type, outcome: stepFailed ? 'failed' : ledgerStatus });

    const baseSet: Record<string, unknown> = {
      steps_executed: seq,
      ...(contextPatch ? { context: { ...run.context, ...contextPatch } } : {}),
    };

    if (terminal) {
      await t
        .updateTable('workflow_runs')
        .set({ ...baseSet, status: terminal, finished_at: new Date(), wake_at: null, current_step_id: null } as any)
        .where('id', '=', runId)
        .execute();
      finishStatus(run, terminal);
      return { kind: 'finished' };
    }

    if (park) {
      await t
        .updateTable('workflow_runs')
        .set({
          ...baseSet,
          status: park.status,
          wake_at: park.wakeAt,
          waiting_event_types: park.waitingEvents ?? null,
          current_step_id: nextStepId,
        } as any)
        .where('id', '=', runId)
        .execute();
      const kind = park.status === 'waiting_delay' ? 'wake' : 'timeout';
      return { kind: 'parked',job:{kind,run,wakeAt:park.wakeAt,seq,stepId:park.status==='waiting_event'?step.id:nextStepId ?? undefined} };
    }

    if (nextStepId === null) {
      await t
        .updateTable('workflow_runs')
        .set({ ...baseSet, status: 'completed', finished_at: new Date(), wake_at: null, current_step_id: null } as any)
        .where('id', '=', runId)
        .execute();
      finishStatus(run, 'completed');
      return { kind: 'finished' };
    }

    // Workflow-level goal with exit_on_goal: if a goal was met mid-flight, stop
    // before the next step rather than sending more mail at a converted subject.
    if (goalCfg?.exit_on_goal && run.goal_met_at) {
      await t
        .updateTable('workflow_runs')
        .set({ ...baseSet, status: 'goal_met', finished_at: new Date(), wake_at: null, current_step_id: null } as any)
        .where('id', '=', runId)
        .execute();
      finishStatus(run, 'goal_met');
      return { kind: 'finished' };
    }

    await t
      .updateTable('workflow_runs')
      .set({ ...baseSet, current_step_id: nextStepId, wake_at: null, waiting_event_types: null } as any)
      .where('id', '=', runId)
      .execute();
    const sentIds = typeof result.message_id === 'string' ? [result.message_id] : Array.isArray(result.message_ids) ? (result.message_ids as string[]) : [];
    return { kind: 'continue', sentMessageIds: sentIds };
  });
}

function defaultNext(step: WorkflowStep): string | null {
  switch (step.type) {
    case 'condition':
      return step.on_false;
    case 'wait_for_event':
      return step.on_timeout;
    case 'split':
      return step.branch_b;
    case 'exit':
      return null;
    default:
      return step.next;
  }
}

/** Delay wake-time: now + duration, pushed into the UTC delivery window if one is set. */
export function computeWakeAt(
  now: Date,
  durationSeconds: number,
  window?: { start_hour: number; end_hour: number; days?: number[] },
  timeZone = 'UTC'
): Date {
  const wake = new Date(now.getTime() + durationSeconds * 1000);
  if (!window) return wake;
  if (timeZone !== 'UTC' || window.days?.length) {
    const clock = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
    return nextWindowStart(wake, { start: clock(window.start_hour), end: clock(window.end_hour), days: window.days }, timeZone);
  }
  const hour = wake.getUTCHours();
  if (hour >= window.start_hour && hour < window.end_hour) return wake;
  const aligned = new Date(wake);
  aligned.setUTCHours(window.start_hour, 0, 0, 0);
  // Landed after today's window closed: deliver at tomorrow's window start.
  // (Before it opened: today's start, which setUTCHours already produced.)
  if (hour >= window.end_hour) aligned.setUTCDate(aligned.getUTCDate() + 1);
  return aligned;
}

// ---------------------------------------------------------------------------
// send_email preparation (outside the advancement txn)
// ---------------------------------------------------------------------------

type SendPrep =
  | { kind: 'park_quota' }
  | { kind: 'failed'; reason: string }
  | {
      kind: 'ready';
      skip_reason?: string;
      message_id?: string;
      subject?: string;
      html?: string | null;
      text?: string | null;
      priority?: number;
      risk_score?: number;
    };

async function prepareSendEmail(
  run: RunRow,
  step: Extract<WorkflowStep, { type: 'send_email' }>
): Promise<SendPrep> {
  // Suppressed subjects are silently skipped (never an error — honoring the
  // list is correct behavior, and the ledger records why nothing was sent).
  if (await isSuppressed(run.customer_id, run.subject_email)) {
    return { kind: 'ready', skip_reason: 'suppressed' };
  }

  const customer = await db
    .selectFrom('customers')
    .select(['status', 'daily_quota', 'monthly_quota', 'tier'])
    .where('id', '=', run.customer_id)
    .executeTakeFirst();
  if (!customer || customer.status !== 'active') return { kind: 'ready', skip_reason: 'customer_inactive' };

  const fromDomain = step.from.split('@')[1]!.toLowerCase();
  const domain = await db
    .selectFrom('sending_domains')
    .select(['verified_at', 'dkim_verified'])
    .where('customer_id', '=', run.customer_id)
    .where('domain', '=', fromDomain)
    .executeTakeFirst();
  if (!domain?.verified_at || !domain.dkim_verified) {
    return { kind: 'failed', reason: 'domain_not_verified' };
  }

  const template = await db
    .selectFrom('templates')
    .selectAll()
    .where('id', '=', step.template_id)
    .where('customer_id', '=', run.customer_id)
    .executeTakeFirst();
  if (!template) return { kind: 'failed', reason: 'template_not_found' };

  const quota = await reserveQuota(run.customer_id, 1, customer.daily_quota, customer.monthly_quota);
  if (!quota.allowed) return { kind: 'park_quota' };

  try {
    const bag = workflowRenderVariables(run.context, step.variables ?? {});
    const rendered = renderTemplate(step.subject ? { ...template, subject: step.subject } : template, bag, { onMissing: 'ignore' });

    // Same content policy as /v1/send — a workflow must not become the
    // unscanned back door.
    const scan = scanContent(rendered.subject, rendered.html, rendered.text);
    if (scan.action === 'block') {
      await releaseQuota(run.customer_id, 1);
      return { kind: 'failed', reason: 'content_rejected' };
    }

    return {
      kind: 'ready',
      message_id: generateMessageId(fromDomain),
      subject: rendered.subject,
      html: rendered.html ?? null,
      text: rendered.text ?? null,
      priority: customer.tier === 'enterprise' ? 1 : customer.tier === 'paid' ? 5 : 10,
      risk_score: scan.score,
    };
  } catch (err: any) {
    await releaseQuota(run.customer_id, 1);
    return { kind: 'failed', reason: `render_failed:${err?.message ?? 'unknown'}` };
  }
}

// ---------------------------------------------------------------------------
// Sending rules, notify preparation, condition data
// ---------------------------------------------------------------------------

/** Quiet hours and frequency cap. Returns when to retry the step, or null to run it now. */
async function sendingRulesHold(run: RunRow, def: WorkflowDefinition, kind: 'send_email' | 'notify'): Promise<{ wakeAt: Date; reason: 'quiet_hours' | 'frequency_cap' } | null> {
  const now = new Date();
  const window = def.settings.send_window;
  if (window && kind === 'send_email') {
    const tz = resolveTimeZone(window.timezone, (run.context as any).contact?.timezone, def.settings.default_timezone);
    const w: ClockWindow = { start: window.start, end: window.end, days: window.days };
    if (!inWindow(now, w, tz)) return { wakeAt: nextWindowStart(now, w, tz), reason: 'quiet_hours' };
  }
  const cap = def.settings.frequency_cap;
  if (cap && kind === 'send_email') {
    const since = new Date(now.getTime() - cap.days * 86_400_000);
    const recent = await db
      .selectFrom('messages')
      .select('queued_at')
      .where('customer_id', '=', run.customer_id)
      .where('to_address', '=', run.subject_email)
      .where('ip_pool', '=', 'marketing')
      .where('queued_at', '>', since.toISOString() as any)
      .orderBy('queued_at', 'desc')
      .limit(cap.max)
      .execute();
    if (recent.length >= cap.max) {
      const oldest = new Date(recent[recent.length - 1]!.queued_at as unknown as string);
      return { wakeAt: new Date(oldest.getTime() + cap.days * 86_400_000 + 60_000), reason: 'frequency_cap' };
    }
  }
  return null;
}

type NotifyPrep = { kind: 'ready'; subject: string; text: string; priority: number; risk_score: number; messages: { to: string; message_id: string }[] };
async function prepareNotify(run: RunRow, step: Extract<WorkflowStep, { type: 'notify' }>): Promise<NotifyPrep | { kind: 'failed'; reason: string } | { kind: 'park_quota' }> {
  const customer = await db.selectFrom('customers').select(['status', 'daily_quota', 'monthly_quota', 'tier']).where('id', '=', run.customer_id).executeTakeFirst();
  if (!customer || customer.status !== 'active') return { kind: 'failed', reason: 'customer_inactive' };
  const fromDomain = step.from.split('@')[1]!.toLowerCase();
  const domain = await db.selectFrom('sending_domains').select(['verified_at', 'dkim_verified']).where('customer_id', '=', run.customer_id).where('domain', '=', fromDomain).executeTakeFirst();
  if (!domain?.verified_at || !domain.dkim_verified) return { kind: 'failed', reason: 'domain_not_verified' };
  const recipients: string[] = [];
  for (const to of step.to) if (!(await isSuppressed(run.customer_id, to))) recipients.push(to.toLowerCase());
  const vars = workflowRenderVariables(run.context);
  const rendered = renderTemplate({ subject: step.subject, text_body: step.body }, vars, { onMissing: 'ignore' });
  const scan = scanContent(rendered.subject, null as any, rendered.text ?? '');
  if (scan.action === 'block') return { kind: 'failed', reason: 'content_rejected' };
  if (recipients.length) {
    const quota = await reserveQuota(run.customer_id, recipients.length, customer.daily_quota, customer.monthly_quota);
    if (!quota.allowed) return { kind: 'park_quota' };
  }
  return {
    kind: 'ready', subject: rendered.subject, text: rendered.text ?? step.body, risk_score: scan.score,
    priority: customer.tier === 'enterprise' ? 1 : customer.tier === 'paid' ? 5 : 10,
    messages: recipients.map((to) => ({ to, message_id: generateMessageId(fromDomain) })),
  };
}

/** Bag for a condition: run data + fresh contact + engagement with this run's emails. */
async function conditionBag(run: RunRow, rules: { field: string }[]): Promise<Record<string, unknown>> {
  const bag: Record<string, unknown> = { ...run.context };
  if (rules.some((r) => r.field.startsWith('contact.'))) bag.contact = await loadContactBag(db, run.customer_id, run.subject_email);
  if (rules.some((r) => r.field.startsWith('run.'))) {
    const sent: string[] = Array.isArray((run.context as any)._sent_message_ids) ? (run.context as any)._sent_message_ids : [];
    const rows = sent.length
      ? await db.selectFrom('messages').select(['message_id', 'queued_at', 'opened_at', 'first_clicked_at']).where('customer_id', '=', run.customer_id).where('message_id', 'in', sent).execute()
      : [];
    const last = rows.sort((a, b) => new Date(b.queued_at as any).getTime() - new Date(a.queued_at as any).getTime())[0];
    bag.run = {
      emails_sent: rows.length,
      opened: rows.some((r) => r.opened_at), clicked: rows.some((r) => r.first_clicked_at),
      last_opened: !!last?.opened_at, last_clicked: !!last?.first_clicked_at,
    };
  }
  return bag;
}

/** Best-effort immediate dispatch after the advancement txn commits. */
export async function dispatchPendingWorkflowSends(messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  try {
    await drainSendOutbox({ messageIds, limit: messageIds.length });
  } catch {
    /* outbox drain in the scheduler picks it up */
  }
}

// ---------------------------------------------------------------------------
// webhook action delivery (at-least-once, SSRF-guarded, HMAC-signed)
// ---------------------------------------------------------------------------

function workflowSigningSecret(customerId: string): string {
  // Per-customer signing secret derived from the platform encryption key —
  // stable across deliveries, retrievable via GET /v1/workflows/signing-secret
  // so receivers can verify without another stored credential.
  const key = process.env.ENCRYPTION_KEY ?? 'dev-workflow-signing';
  return crypto.createHmac('sha256', key).update(`workflow-webhook:${customerId}`).digest('hex');
}

export function getWorkflowSigningSecret(customerId: string): string {
  return workflowSigningSecret(customerId);
}

export interface WorkflowWebhookDelivery {
  ok: boolean;
  status?: number;
  error?: string;
  delivery_id: string;
}

/**
 * Transient failures earn a park-based retry; permanent ones fail through.
 * 5xx and timeouts/network errors are transient. 4xx means the endpoint
 * rejected the request (retrying identical bytes won't help), and SSRF/URL
 * failures are configuration problems.
 */
export function isRetryableWebhookFailure(d: Pick<WorkflowWebhookDelivery, 'ok' | 'status' | 'error'>): boolean {
  if (d.ok) return false;
  if (d.status !== undefined) return d.status >= 500;
  return d.error !== 'ssrf_blocked' && d.error !== 'url_error';
}

async function deliverWorkflowWebhook(
  run: RunRow,
  step: Extract<WorkflowStep, { type: 'webhook' }>
): Promise<{ ok: boolean; status?: number; error?: string; delivery_id: string }> {
  const deliveryId = crypto.randomUUID();
  const body = JSON.stringify({
    type: 'workflow.step',
    delivery_id: deliveryId,
    workflow_id: run.workflow_id,
    run_id: run.id,
    step_id: step.id,
    subject: { email: run.subject_email },
    context: (run.context as any).context ?? {},
    trigger: (run.context as any).trigger ?? {},
    payload: step.payload ?? {},
    occurred_at: new Date().toISOString(),
  });

  try {
    // Delivery-time SSRF re-check (DNS may have changed since publish).
    await resolveAndAssertPublicUrl(step.url);
  } catch (err) {
    return { ok: false, error: err instanceof SsrfError ? 'ssrf_blocked' : 'url_error', delivery_id: deliveryId };
  }

  const ts = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac('sha256', workflowSigningSecret(run.customer_id))
    .update(`${ts}.${body}`)
    .digest('hex');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(step.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'MailPlatform-Workflows/1.0',
          'X-Workflow-Delivery': deliveryId,
          'X-Workflow-Timestamp': String(ts),
          'X-Workflow-Signature': `v1=${signature}`,
        },
        body,
        signal: controller.signal,
        redirect: 'error',
      });
      return { ok: res.status >= 200 && res.status < 300, status: res.status, delivery_id: deliveryId };
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message ?? err), delivery_id: deliveryId };
  }
}

// ---------------------------------------------------------------------------
// Wake / timeout job handlers
// ---------------------------------------------------------------------------

export async function handleWorkflowWake(runId: string): Promise<void> {
  const resumed = await db
    .updateTable('workflow_runs')
    .set({ status: 'running', wake_at: null })
    .where('id', '=', runId)
    .where('status', '=', 'waiting_delay')
    // Small skew guard: never wake early if the sweep re-armed with old data.
    .where('wake_at', '<=', new Date(Date.now() + 5_000))
    .returning('id')
    .executeTakeFirst();
  if (!resumed) return;
  await advanceWorkflowRun(runId);
}

export async function handleWorkflowTimeout(runId: string, stepId?: string): Promise<void> {
  // Take the on_timeout branch — but only if the run is still waiting on the
  // same wait step (an event may have resumed it already).
  const run = await loadRun(db, runId, false);
  if (!run || run.status !== 'waiting_event') return;
  if (stepId && run.current_step_id !== stepId) return;

  const versionRow = await db
    .selectFrom('workflow_versions')
    .select(['id', 'definition'])
    .where('id', '=', run.version_id)
    .executeTakeFirst();
  if (!versionRow) return;
  const def = cachedWorkflowDefinition(versionRow.id, versionRow.definition);
  const step = stepById(def, run.current_step_id);
  if (!step || step.type !== 'wait_for_event') return;

  const moved = await db
    .updateTable('workflow_runs')
    .set({
      status: 'running',
      current_step_id: step.on_timeout,
      wake_at: null,
      waiting_event_types: null,
    })
    .where('id', '=', runId)
    .where('status', '=', 'waiting_event')
    .where('current_step_id', '=', step.id)
    .where('wake_at', '<=', new Date(Date.now() + 5_000))
    .returning('id')
    .executeTakeFirst();
  if (!moved) return;

  await db
    .updateTable('workflow_run_steps')
    .set({ status: 'completed', result: sql`result || '{"branch": "on_timeout"}'::jsonb` as any })
    .where('run_id', '=', runId)
    .where('step_id', '=', step.id)
    .where('status', '=', 'waiting')
    .execute();
  workflowStepsExecuted.inc({ step_type: 'wait_for_event', outcome: 'timeout' });
  await advanceWorkflowRun(runId);
}

// ---------------------------------------------------------------------------
// Event dispatch (called by the event worker for every engagement event)
// ---------------------------------------------------------------------------

const ACTIVE_WF_CACHE_TTL = 60;

/**
 * Cheap short-circuit for the event-worker hot path: most tenants have no
 * workflows, and events vastly outnumber workflow mutations. Cached 60s.
 */
async function tenantHasWorkflowActivity(customerId: string): Promise<boolean> {
  const cacheKey = `wf:active:${customerId}`;
  const cached = await redis.get(cacheKey);
  if (cached !== null) return cached === '1';
  const row = await db
    .selectFrom('workflows')
    .select('id')
    .where('customer_id', '=', customerId)
    .where('status', 'in', ['active', 'paused'])
    .limit(1)
    .executeTakeFirst();
  const has = !!row;
  await redis.setex(cacheKey, ACTIVE_WF_CACHE_TTL, has ? '1' : '0');
  return has;
}

/** Invalidate the activity cache after publish/pause/archive mutations. */
export async function invalidateWorkflowActivityCache(customerId: string): Promise<void> {
  await redis.del(`wf:active:${customerId}`);
}

export interface WorkflowEventInput {
  customerId: string;
  eventType: string;
  subjectEmail: string;
  messageId?: string;
  payload?: Record<string, unknown>;
}

export interface WorkflowEventDispatchResult {
  started_runs: string[];
  resumed_runs: string[];
  goals_met: string[];
  exited_runs: string[];
}

export async function dispatchWorkflowEvent(input: WorkflowEventInput): Promise<WorkflowEventDispatchResult> {
  const result: WorkflowEventDispatchResult = { started_runs: [], resumed_runs: [], goals_met: [], exited_runs: [] };
  if (!(await tenantHasWorkflowActivity(input.customerId))) return result;

  const subject = input.subjectEmail.toLowerCase();

  // One query serves auto-exits, goals, and trigger matching below.
  const workflows = await db
    .selectFrom('workflows')
    .innerJoin('workflow_versions', 'workflow_versions.id', 'workflows.published_version_id')
    .select([
      'workflows.id as id',
      'workflows.status as status',
      'workflows.trigger_type',
      'workflows.trigger_event_type',
      'workflows.published_version_id as version_id',
      'workflow_versions.definition as definition',
    ])
    .where('workflows.customer_id', '=', input.customerId)
    .where('workflows.status', 'in', ['active', 'paused'])
    .execute();
  const parsedDefs = new Map<string, WorkflowDefinition>();
  for (const wf of workflows) {
    try {
      if (wf.version_id) parsedDefs.set(wf.id, cachedWorkflowDefinition(wf.version_id, wf.definition));
    } catch {
      /* skip corrupt definitions */
    }
  }

  // --- 0. Auto-exit rules — processed FIRST, so a subject who unsubscribes
  // or complains is out of the journey before any wait-resume could push them
  // toward another send. Applies to active AND paused workflows (paused only
  // stops new entries; in-flight compliance still binds).
  for (const wf of workflows) {
    const def = parsedDefs.get(wf.id);
    if (!def || !def.settings.exit_on_events.includes(input.eventType as any)) continue;
    const exited = await db
      .updateTable('workflow_runs')
      .set({
        status: 'exited',
        error: `auto_exit:${input.eventType}`,
        finished_at: new Date(),
        wake_at: null,
        waiting_event_types: null,
        current_step_id: null,
      })
      .where('workflow_id', '=', wf.id)
      .where('subject_email', '=', subject)
      .where('status', 'in', ['running', 'waiting_delay', 'waiting_event'])
      .returning('id')
      .execute();
    for (const r of exited) {
      result.exited_runs.push(r.id);
      workflowRunsFinished.inc({ status: 'exited' });
    }
  }

  // --- 1. Resume waiting_event runs for this subject -----------------------
  const waiting = await db
    .selectFrom('workflow_runs')
    .select([...RUN_ENGINE_COLS, 'waiting_event_types'])
    .where('customer_id', '=', input.customerId)
    .where('subject_email', '=', subject)
    .where('status', '=', 'waiting_event')
    .execute();

  const matchingWaits = waiting.filter((r) => (r.waiting_event_types ?? []).includes(input.eventType));
  if (matchingWaits.length > 0) {
    const versionIds = [...new Set(matchingWaits.map((r) => r.version_id))];
    const versions = await db
      .selectFrom('workflow_versions')
      .select(['id', 'definition'])
      .where('id', 'in', versionIds)
      .execute();
    const defs = new Map(versions.map((v) => [v.id, cachedWorkflowDefinition(v.id, v.definition)]));

    for (const raw of matchingWaits) {
      const run = raw as unknown as RunRow;
      const def = defs.get(run.version_id);
      const step = def ? stepById(def, run.current_step_id) : null;
      if (!def || !step || step.type !== 'wait_for_event') continue;

      // Scope 'run': only events on messages this run itself sent count.
      // Custom business events are about the subject, never a specific message.
      if (step.scope === 'run' && !input.eventType.startsWith('custom:')) {
        const sent: string[] = Array.isArray((run.context as any)._sent_message_ids)
          ? (run.context as any)._sent_message_ids
          : [];
        if (!input.messageId || !sent.includes(input.messageId)) continue;
      }

      const moved = await db
        .updateTable('workflow_runs')
        .set({ status: 'running', current_step_id: step.on_event, wake_at: null, waiting_event_types: null })
        .where('id', '=', run.id)
        .where('status', '=', 'waiting_event')
        .where('current_step_id', '=', step.id)
        .returning('id')
        .executeTakeFirst();
      if (!moved) continue;

      await db
        .updateTable('workflow_run_steps')
        .set({
          status: 'completed',
          result: sql`result || ${JSON.stringify({ branch: 'on_event', event_type: input.eventType, message_id: input.messageId ?? null })}::jsonb` as any,
        })
        .where('run_id', '=', run.id)
        .where('step_id', '=', step.id)
        .where('status', '=', 'waiting')
        .execute();
      workflowStepsExecuted.inc({ step_type: 'wait_for_event', outcome: 'event' });
      result.resumed_runs.push(run.id);
      try {
        await enqueue('advance', run, { seq: run.steps_executed, uniqueSuffix: '-ev' });
      } catch {
        /* recoverStuckWorkflowRuns re-arms */
      }
    }
  }

  // --- 2 & 3. Goal attainment + trigger matching over the same workflow set.
  for (const wf of workflows) {
    const def = parsedDefs.get(wf.id);
    if (!def) continue;

    // Goal attainment: any in-flight run of this workflow for the subject.
    if (def.goal && def.goal.event_type === input.eventType) {
      const goalRuns = await db
        .updateTable('workflow_runs')
        .set({ goal_met_at: new Date() })
        .where('workflow_id', '=', wf.id)
        .where('subject_email', '=', subject)
        .where('goal_met_at', 'is', null)
        .where('status', 'in', ['running', 'waiting_delay', 'waiting_event'])
        .returning(['id', 'status'])
        .execute();
      for (const gr of goalRuns) {
        result.goals_met.push(gr.id);
        if (def.goal.exit_on_goal) {
          const finished = await db
            .updateTable('workflow_runs')
            .set({ status: 'goal_met', finished_at: new Date(), wake_at: null, waiting_event_types: null, current_step_id: null })
            .where('id', '=', gr.id)
            .where('status', 'in', ['running', 'waiting_delay', 'waiting_event'])
            .returning('id')
            .executeTakeFirst();
          if (finished) workflowRunsFinished.inc({ status: 'goal_met' });
        }
      }
    }

    // Custom business event trigger ("order_placed"): its data becomes the run context.
    if (
      wf.status === 'active' &&
      wf.trigger_type === 'custom_event' &&
      wf.trigger_event_type === input.eventType &&
      def.trigger.type === 'custom_event'
    ) {
      const data = input.payload ?? {};
      const contact = def.trigger.filters?.some((f) => f.field.startsWith('contact.')) ? await loadContactBag(db, input.customerId, subject) : undefined;
      if (def.trigger.filters?.length && !evaluateRules({ subject: { email: subject }, trigger: data, context: data, contact }, def.trigger.filters, 'all')) continue;
      const started = await triggerWorkflowRun({
        customerId: input.customerId,
        workflowId: wf.id,
        subjectEmail: subject,
        source: 'api',
        triggerPayload: { event_type: input.eventType },
        context: data,
      });
      if (started.started && started.run_id) result.started_runs.push(started.run_id);
      continue;
    }

    // Trigger: start a new run when this event type is the workflow's entry.
    if (
      wf.status === 'active' &&
      wf.trigger_type === 'event' &&
      wf.trigger_event_type === input.eventType &&
      def.trigger.type === 'event'
    ) {
      const bag = { subject: { email: subject }, trigger: input.payload ?? {}, context: {} };
      if (def.trigger.filters && def.trigger.filters.length > 0 && !evaluateRules(bag, def.trigger.filters, 'all')) {
        continue;
      }
      const started = await triggerWorkflowRun({
        customerId: input.customerId,
        workflowId: wf.id,
        subjectEmail: subject,
        source: 'event',
        triggerPayload: { event_type: input.eventType, message_id: input.messageId ?? null, ...(input.payload ?? {}) },
      });
      if (started.started && started.run_id) result.started_runs.push(started.run_id);
    }
  }

  return result;
}

/**
 * A named business event from the customer's systems (order placed, appointment
 * booked, payment failed). Starts custom_event workflows, resumes waits on it,
 * marks goals and applies auto-exits, exactly like engagement events.
 */
export async function emitWorkflowCustomEvent(input: { customerId: string; name: string; subjectEmail: string; data?: Record<string, unknown> }) {
  return dispatchWorkflowEvent({ customerId: input.customerId, eventType: customEventKey(input.name), subjectEmail: input.subjectEmail, payload: input.data ?? {} });
}

/**
 * Contacts were added to a list/segment: enroll them in every active workflow
 * whose trigger is that collection. Pass the tenant transaction from API
 * routes and kick the returned run ids after commit.
 */
export async function enrollAudienceWorkflows(customerId: string, collectionId: string, emails: string[], executor?: DbLike): Promise<string[]> {
  if (!emails.length) return [];
  const exec = executor ?? db;
  const workflows = await exec
    .selectFrom('workflows')
    .select('id')
    .where('customer_id', '=', customerId)
    .where('status', '=', 'active')
    .where('trigger_type', '=', 'audience')
    .where('trigger_event_type', '=', collectionId)
    .execute();
  const runIds: string[] = [];
  for (const wf of workflows) {
    for (let i = 0; i < emails.length; i += 500) {
      const res = await triggerWorkflowRunsBulk(
        { customerId, workflowId: wf.id, subjects: emails.slice(i, i + 500).map((email) => ({ email })), source: 'audience', triggerPayload: { collection_id: collectionId } },
        exec
      );
      for (const r of res.results) if (r.started && r.run_id) runIds.push(r.run_id);
    }
  }
  return runIds;
}

/** Local month-day (or full date) the date trigger matches today. */
function dateTriggerTarget(now: Date, timeZone: string, offsetDays: number) {
  const local = localDate(now, timeZone);
  const target = new Date(`${local}T00:00:00Z`);
  // Enter `offset_days` before (negative) or after (positive) the stored date.
  target.setUTCDate(target.getUTCDate() - offsetDays);
  return { local, iso: target.toISOString().slice(0, 10), monthDay: target.toISOString().slice(5, 10) };
}

/**
 * Daily date-based enrollment (birthdays, renewals, anniversaries, due dates).
 * Runs from the scheduler; each workflow enrolls once per local day after its
 * configured hour. Re-entry rules still apply (yearly journeys need re-entry).
 */
export async function sweepDateTriggeredWorkflows(now = new Date(), limit = 200): Promise<number> {
  const workflows = await db
    .selectFrom('workflows')
    .innerJoin('workflow_versions', 'workflow_versions.id', 'workflows.published_version_id')
    .select(['workflows.id', 'workflows.customer_id', 'workflows.date_trigger_swept_on', 'workflow_versions.id as version_id', 'workflow_versions.definition'])
    .where('workflows.status', '=', 'active')
    .where('workflows.trigger_type', '=', 'date')
    .limit(limit)
    .execute();
  let enrolled = 0;
  for (const wf of workflows) {
    let def: WorkflowDefinition;
    try { def = cachedWorkflowDefinition(wf.version_id, wf.definition); } catch { continue; }
    if (def.trigger.type !== 'date') continue;
    const trigger = def.trigger;
    const tz = resolveTimeZone(trigger.timezone, null);
    const { local, iso, monthDay } = dateTriggerTarget(now, tz, trigger.offset_days);
    const swept = wf.date_trigger_swept_on ? String(wf.date_trigger_swept_on).slice(0, 10) : null;
    if (swept === local || Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now)) < trigger.hour) continue;
    // Claim the day first so concurrent schedulers never double-enroll.
    const claimed = await db
      .updateTable('workflows')
      .set({ date_trigger_swept_on: local })
      .where('id', '=', wf.id)
      .where((eb) => eb.or([eb('date_trigger_swept_on', 'is', null), eb('date_trigger_swept_on', '!=', local)]))
      .executeTakeFirst();
    if (!Number(claimed.numUpdatedRows)) continue;
    const column = trigger.field === 'contact.created_at' ? sql`(created_at at time zone ${tz})::date` : sql`(attributes->>${trigger.field.slice('contact.attributes.'.length)})`;
    let after = '';
    for (;;) {
      const page = await db
        .selectFrom('audience_contacts')
        .select(['email', 'attributes', 'created_at'])
        .where('customer_id', '=', wf.customer_id)
        .where('status', '!=', 'Unsubscribed')
        .where('email', '>', after)
        .where(
          trigger.recurrence === 'yearly'
            ? sql<boolean>`substr((${column})::text, 6, 5) = ${monthDay}`
            : sql<boolean>`substr((${column})::text, 1, 10) = ${iso}`
        )
        .orderBy('email')
        .limit(500)
        .execute();
      if (!page.length) break;
      const res = await triggerWorkflowRunsBulk({
        customerId: wf.customer_id, workflowId: wf.id, source: 'schedule',
        subjects: page.map((c) => ({ email: c.email, context: { date_field: trigger.field, matched_date: local } })),
        triggerPayload: { date: local },
      });
      enrolled += res.started;
      after = page[page.length - 1]!.email;
      if (page.length < 500) break;
    }
  }
  return enrolled;
}

// ---------------------------------------------------------------------------
// Scheduler sweeps
// ---------------------------------------------------------------------------

/**
 * Re-arm waiting runs whose wake time passed but whose delayed Redis job was
 * lost (flush/failover). Deterministic job ids make re-arming idempotent
 * against a job that does still exist.
 */
export async function sweepOverdueWorkflowRuns(limit = 500): Promise<number> {
  const overdue = await db
    .selectFrom('workflow_runs')
    .select(['id', 'customer_id', 'status', 'current_step_id', 'steps_executed'])
    .where('status', 'in', ['waiting_delay', 'waiting_event'])
    .where('wake_at', '<', new Date(Date.now() - 60_000))
    .limit(limit)
    .execute();

  let armed = 0;
  for (const run of overdue) {
    const kind = run.status === 'waiting_delay' ? 'wake' : 'timeout';
    try {
      await enqueue(kind, run, {
        seq: run.steps_executed,
        stepId: run.current_step_id ?? undefined,
        uniqueSuffix: '-sweep',
      });
      armed++;
    } catch {
      /* next sweep retries */
    }
  }
  if (armed > 0) workflowSweepRecovered.inc({ kind: 'overdue_wake' }, armed);
  return armed;
}

/**
 * Age out finished runs (terminal for longer than the retention window).
 * Step-ledger rows cascade via FK. Aggregate reporting survives in
 * workflow_step_stats, which is never swept. Batched so a large backlog
 * cannot hold long row locks.
 */
export async function sweepFinishedWorkflowRuns(
  retentionDays = Number(process.env.WORKFLOW_RUN_RETENTION_DAYS ?? 90),
  batchSize = 10_000
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  let total = 0;
  for (;;) {
    const batch = await db
      .selectFrom('workflow_runs')
      .select('id')
      .where('status', 'in', ['completed', 'goal_met', 'exited', 'failed', 'canceled'])
      .where('finished_at', '<', cutoff)
      .limit(batchSize)
      .execute();
    if (batch.length === 0) return total;
    await db
      .deleteFrom('workflow_runs')
      .where('id', 'in', batch.map((r) => r.id))
      .execute();
    total += batch.length;
    if (batch.length < batchSize) return total;
  }
}

/**
 * Re-enqueue advance jobs for runs stuck in 'running' (crash between the run
 * insert/transition and the Redis add, or a poison job that exhausted
 * retries). updated_at is bumped by every step txn, so a genuinely
 * progressing run never looks stuck.
 */
export async function recoverStuckWorkflowRuns(limit = 200): Promise<number> {
  const stuck = await db
    .selectFrom('workflow_runs')
    .select(['id', 'customer_id', 'steps_executed'])
    .where('status', '=', 'running')
    .where(sql<boolean>`updated_at < NOW() - INTERVAL '1 minute' * ${STUCK_RUN_MINUTES}`)
    .limit(limit)
    .execute();

  let armed = 0;
  for (const run of stuck) {
    try {
      await enqueue('advance', run, { seq: run.steps_executed, uniqueSuffix: `-r${Date.now()}` });
      armed++;
    } catch {
      /* next sweep retries */
    }
  }
  if (armed > 0) workflowSweepRecovered.inc({ kind: 'stuck_running' }, armed);
  return armed;
}
