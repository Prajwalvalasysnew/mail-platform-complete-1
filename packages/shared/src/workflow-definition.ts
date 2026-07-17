// Workflow definition model: the JSON document the builder UI edits, validated
// here before it can be saved as a draft and again (strictly) before publish.
//
// A definition is a directed acyclic graph of steps entered from a single
// trigger. Cycles are rejected — enterprise builders that allow loops require
// per-loop guards; a DAG plus the re-entry policy covers the same use cases
// without runaway-run risk. Runtime additionally caps steps_executed per run.
//
// Step vocabulary (matching the builder palette):
//   delay          — wait a fixed duration, optionally aligned to a UTC
//                    delivery window ("time window" in the palette).
//   condition      — attribute if/else over trigger/context/subject fields.
//   wait_for_event — "opened email within 2 days": park until a matching
//                    engagement event for the subject, else timeout branch.
//   send_email     — send a stored template to the subject (suppression,
//                    domain and quota rules all still apply).
//   webhook        — signed POST to a customer endpoint (SSRF-guarded).
//   suppress       — add/remove the subject on the suppression list (the
//                    platform's "remove from list" analog).
//   goal           — inline goal marker: records attainment and exits.
//   exit           — explicit end of the journey.

import { z } from 'zod';

// Engagement/delivery events a workflow can react to (trigger, waits, goals).
// Mirrors WEBHOOK_EVENT_TYPES minus 'failed' (internal-only noise for
// automations) — kept as its own list so the two can diverge deliberately.
export const WORKFLOW_EVENT_TYPES = [
  'delivered',
  'opened',
  'clicked',
  'soft_bounce',
  'hard_bounce',
  'complaint',
  'unsubscribed',
] as const;
export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

const STEP_ID = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'step id must be 1-64 chars of [a-zA-Z0-9_-]');

const MAX_STEPS = 100;
const MAX_DELAY_SECONDS = 90 * 86_400; // 90 days
const MAX_DEFINITION_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export const ConditionRuleSchema = z.object({
  // Dot-path into the run's data bag: trigger.*, context.*, subject.email.
  field: z.string().min(1).max(200),
  op: z.enum(['eq', 'neq', 'contains', 'not_contains', 'exists', 'not_exists', 'gt', 'gte', 'lt', 'lte', 'in']),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()])).max(100)]).optional(),
});
export type ConditionRule = z.infer<typeof ConditionRuleSchema>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const DeliverWindowSchema = z
  .object({
    // UTC hours; e.g. {start_hour: 9, end_hour: 17} delivers 09:00-16:59 UTC.
    start_hour: z.number().int().min(0).max(23),
    end_hour: z.number().int().min(1).max(24),
  })
  .refine((w) => w.start_hour < w.end_hour, { message: 'start_hour must be before end_hour' });

const DelayStepSchema = z.object({
  id: STEP_ID,
  type: z.literal('delay'),
  name: z.string().max(200).optional(),
  duration_seconds: z.number().int().min(0).max(MAX_DELAY_SECONDS),
  deliver_window: DeliverWindowSchema.optional(),
  next: STEP_ID.nullable(),
});

const ConditionStepSchema = z.object({
  id: STEP_ID,
  type: z.literal('condition'),
  name: z.string().max(200).optional(),
  match: z.enum(['all', 'any']).default('all'),
  rules: z.array(ConditionRuleSchema).min(1).max(20),
  on_true: STEP_ID.nullable(),
  on_false: STEP_ID.nullable(),
});

const WaitForEventStepSchema = z.object({
  id: STEP_ID,
  type: z.literal('wait_for_event'),
  name: z.string().max(200).optional(),
  event_types: z.array(z.enum(WORKFLOW_EVENT_TYPES)).min(1).max(WORKFLOW_EVENT_TYPES.length),
  timeout_seconds: z.number().int().min(60).max(MAX_DELAY_SECONDS),
  // 'run': only events on messages this run sent count ("opened THE welcome
  // email"). 'any': any matching subject activity counts.
  scope: z.enum(['run', 'any']).default('run'),
  on_event: STEP_ID.nullable(),
  on_timeout: STEP_ID.nullable(),
});

const SendEmailStepSchema = z.object({
  id: STEP_ID,
  type: z.literal('send_email'),
  name: z.string().max(200).optional(),
  template_id: z.string().uuid(),
  from: z.string().email(),
  from_name: z.string().max(100).optional(),
  reply_to: z.string().email().optional(),
  // Extra template variables merged over the run context at render time.
  variables: z.record(z.unknown()).optional(),
  next: STEP_ID.nullable(),
});

const WebhookStepSchema = z.object({
  id: STEP_ID,
  type: z.literal('webhook'),
  name: z.string().max(200).optional(),
  url: z.string().url().max(2000),
  // Static payload fields merged into the signed delivery body.
  payload: z.record(z.unknown()).optional(),
  next: STEP_ID.nullable(),
});

const SuppressStepSchema = z.object({
  id: STEP_ID,
  type: z.literal('suppress'),
  name: z.string().max(200).optional(),
  action: z.enum(['add', 'remove']),
  next: STEP_ID.nullable(),
});

const GoalStepSchema = z.object({
  id: STEP_ID,
  type: z.literal('goal'),
  name: z.string().max(200).optional(),
  next: STEP_ID.nullable(),
});

const ExitStepSchema = z.object({
  id: STEP_ID,
  type: z.literal('exit'),
  name: z.string().max(200).optional(),
});

export const WorkflowStepSchema = z.discriminatedUnion('type', [
  DelayStepSchema,
  ConditionStepSchema,
  WaitForEventStepSchema,
  SendEmailStepSchema,
  WebhookStepSchema,
  SuppressStepSchema,
  GoalStepSchema,
  ExitStepSchema,
]);
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type WorkflowStepType = WorkflowStep['type'];

// ---------------------------------------------------------------------------
// Trigger + workflow-level goal + settings
// ---------------------------------------------------------------------------

export const WorkflowTriggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('event'),
    event_type: z.enum(WORKFLOW_EVENT_TYPES),
    // Optional filters against the triggering event's data bag.
    filters: z.array(ConditionRuleSchema).max(10).optional(),
  }),
  z.object({
    // External trigger: POST /v1/workflows/:id/trigger with a subject email +
    // arbitrary context (CRM "contact added to segment", app signup, ...).
    type: z.literal('api'),
  }),
]);
export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;

export const WorkflowGoalSchema = z.object({
  name: z.string().max(200).optional(),
  event_type: z.enum(WORKFLOW_EVENT_TYPES),
  // Stop the journey when the goal is reached (default: record + continue).
  exit_on_goal: z.boolean().default(false),
});
export type WorkflowGoal = z.infer<typeof WorkflowGoalSchema>;

export const WorkflowSettingsSchema = z.object({
  allow_reentry: z.boolean().default(false),
  reentry_cooldown_seconds: z.number().int().min(0).max(365 * 86_400).default(0),
});

export const WorkflowDefinitionSchema = z.object({
  trigger: WorkflowTriggerSchema,
  entry_step_id: STEP_ID.nullable(),
  steps: z.array(WorkflowStepSchema).max(MAX_STEPS),
  goal: WorkflowGoalSchema.optional(),
  settings: WorkflowSettingsSchema.default({ allow_reentry: false, reentry_cooldown_seconds: 0 }),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

// ---------------------------------------------------------------------------
// Graph validation
// ---------------------------------------------------------------------------

export interface DefinitionIssue {
  code: string;
  message: string;
  step_id?: string;
}

export interface DefinitionValidation {
  valid: boolean;
  errors: DefinitionIssue[];
  warnings: DefinitionIssue[];
  definition?: WorkflowDefinition;
}

function outgoingTargets(step: WorkflowStep): Array<string | null> {
  switch (step.type) {
    case 'condition':
      return [step.on_true, step.on_false];
    case 'wait_for_event':
      return [step.on_event, step.on_timeout];
    case 'exit':
      return [];
    default:
      return [step.next];
  }
}

/**
 * Validate a raw definition document: schema shape first, then graph
 * integrity (targets exist, entry exists, DAG, reachability). `strict`
 * additionally requires an entry step with at least one step — the publish
 * bar; drafts may be saved headless while being built.
 */
export function validateWorkflowDefinition(raw: unknown, opts: { strict?: boolean } = {}): DefinitionValidation {
  const errors: DefinitionIssue[] = [];
  const warnings: DefinitionIssue[] = [];

  const json = JSON.stringify(raw ?? {});
  if (json.length > MAX_DEFINITION_BYTES) {
    return {
      valid: false,
      errors: [{ code: 'definition_too_large', message: `Definition exceeds ${MAX_DEFINITION_BYTES} bytes` }],
      warnings,
    };
  }

  const parsed = WorkflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.slice(0, 25).map((i) => ({
        code: 'schema',
        message: `${i.path.join('.') || '(root)'}: ${i.message}`,
      })),
      warnings,
    };
  }
  const def = parsed.data;

  const ids = new Set<string>();
  for (const step of def.steps) {
    if (ids.has(step.id)) errors.push({ code: 'duplicate_step_id', message: `Duplicate step id '${step.id}'`, step_id: step.id });
    ids.add(step.id);
  }

  // Every edge must land on a real step.
  for (const step of def.steps) {
    for (const target of outgoingTargets(step)) {
      if (target !== null && !ids.has(target)) {
        errors.push({ code: 'missing_target', message: `Step '${step.id}' points at unknown step '${target}'`, step_id: step.id });
      }
    }
  }

  if (def.entry_step_id !== null && !ids.has(def.entry_step_id)) {
    errors.push({ code: 'missing_entry', message: `entry_step_id '${def.entry_step_id}' is not a step` });
  }
  if (opts.strict) {
    if (def.steps.length === 0) errors.push({ code: 'empty_workflow', message: 'A published workflow needs at least one step' });
    if (def.entry_step_id === null) errors.push({ code: 'no_entry', message: 'A published workflow needs an entry_step_id' });
  }

  // Cycle check (iterative DFS with colors) — only meaningful once targets
  // resolve, so skip when we already have structural errors.
  if (errors.length === 0 && def.entry_step_id) {
    const byId = new Map(def.steps.map((s) => [s.id, s]));
    const color = new Map<string, 'gray' | 'black'>();
    const stack: Array<{ id: string; targets: string[]; i: number }> = [];
    const pushNode = (id: string) => {
      color.set(id, 'gray');
      const targets = outgoingTargets(byId.get(id)!).filter((t): t is string => t !== null);
      stack.push({ id, targets, i: 0 });
    };
    pushNode(def.entry_step_id);
    while (stack.length > 0 && errors.length === 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.i >= frame.targets.length) {
        color.set(frame.id, 'black');
        stack.pop();
        continue;
      }
      const next = frame.targets[frame.i++]!;
      const c = color.get(next);
      if (c === 'gray') {
        errors.push({ code: 'cycle', message: `Cycle detected involving step '${next}'`, step_id: next });
      } else if (c !== 'black') {
        pushNode(next);
      }
    }

    // Unreachable steps are almost always leftover builder debris — warn, and
    // refuse at publish time so live versions stay clean.
    const unreachable = def.steps.filter((s) => !color.has(s.id));
    for (const s of unreachable) {
      (opts.strict ? errors : warnings).push({
        code: 'unreachable_step',
        message: `Step '${s.id}' is not reachable from the entry step`,
        step_id: s.id,
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings, definition: errors.length === 0 ? def : undefined };
}

// ---------------------------------------------------------------------------
// Condition evaluation (shared by the engine and the simulator)
// ---------------------------------------------------------------------------

/** Resolve a dot-path against the run's data bag. */
export function resolveField(bag: Record<string, unknown>, path: string): unknown {
  let cur: unknown = bag;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function evaluateRule(bag: Record<string, unknown>, rule: ConditionRule): boolean {
  const actual = resolveField(bag, rule.field);
  switch (rule.op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'not_exists':
      return actual === undefined || actual === null;
    case 'eq':
      return actual === rule.value || String(actual) === String(rule.value);
    case 'neq':
      return !(actual === rule.value || String(actual) === String(rule.value));
    case 'contains':
      if (typeof actual === 'string') return actual.toLowerCase().includes(String(rule.value ?? '').toLowerCase());
      if (Array.isArray(actual)) return actual.some((v) => String(v) === String(rule.value));
      return false;
    case 'not_contains':
      if (typeof actual === 'string') return !actual.toLowerCase().includes(String(rule.value ?? '').toLowerCase());
      if (Array.isArray(actual)) return !actual.some((v) => String(v) === String(rule.value));
      return true;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(actual);
      const b = Number(rule.value);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (rule.op === 'gt') return a > b;
      if (rule.op === 'gte') return a >= b;
      if (rule.op === 'lt') return a < b;
      return a <= b;
    }
    case 'in':
      return Array.isArray(rule.value) && rule.value.some((v) => String(v) === String(actual));
    default:
      return false;
  }
}

export function evaluateRules(
  bag: Record<string, unknown>,
  rules: ConditionRule[],
  match: 'all' | 'any'
): boolean {
  if (rules.length === 0) return true;
  return match === 'all' ? rules.every((r) => evaluateRule(bag, r)) : rules.some((r) => evaluateRule(bag, r));
}

// ---------------------------------------------------------------------------
// Simulation ("Run simulation" in the builder): dry-walk the graph with a
// hypothetical subject. No side effects, no DB access — pure function so it
// can also back unit tests of a definition before it ever ships.
// ---------------------------------------------------------------------------

export interface SimulationInput {
  subject_email?: string;
  context?: Record<string, unknown>;
  trigger_payload?: Record<string, unknown>;
  // For each wait_for_event step id: does the awaited event arrive in time?
  // Missing entries default to true (the optimistic path).
  event_outcomes?: Record<string, boolean>;
}

export interface SimulationStepTrace {
  step_id: string;
  step_type: WorkflowStepType;
  outcome: string; // e.g. 'sent', 'branch:on_true', 'delayed 86400s', 'exited'
  next_step_id: string | null;
  virtual_elapsed_seconds: number;
}

export interface SimulationResult {
  completed: boolean;
  end_reason: 'end_of_flow' | 'exit_step' | 'goal_exit' | 'step_limit';
  path: SimulationStepTrace[];
  total_virtual_seconds: number;
}

export function simulateWorkflow(def: WorkflowDefinition, input: SimulationInput = {}): SimulationResult {
  const byId = new Map(def.steps.map((s) => [s.id, s]));
  const bag: Record<string, unknown> = {
    subject: { email: input.subject_email ?? 'test@example.com' },
    context: input.context ?? {},
    trigger: input.trigger_payload ?? {},
  };

  const path: SimulationStepTrace[] = [];
  let elapsed = 0;
  let cursor = def.entry_step_id;
  let endReason: SimulationResult['end_reason'] = 'end_of_flow';

  // The definition graph is a validated DAG, so MAX_STEPS bounds the walk;
  // the guard is belt-and-braces for definitions validated before rules
  // changed.
  for (let n = 0; n < MAX_STEPS + 1; n++) {
    if (cursor === null) break;
    const step = byId.get(cursor);
    if (!step) break;
    if (n === MAX_STEPS) {
      endReason = 'step_limit';
      break;
    }

    let outcome: string;
    let next: string | null;
    switch (step.type) {
      case 'delay':
        elapsed += step.duration_seconds;
        outcome = `delayed ${step.duration_seconds}s`;
        next = step.next;
        break;
      case 'condition': {
        const pass = evaluateRules(bag, step.rules, step.match);
        outcome = pass ? 'branch:on_true' : 'branch:on_false';
        next = pass ? step.on_true : step.on_false;
        break;
      }
      case 'wait_for_event': {
        const arrived = input.event_outcomes?.[step.id] ?? true;
        if (arrived) {
          outcome = `event:${step.event_types.join('|')}`;
          next = step.on_event;
        } else {
          elapsed += step.timeout_seconds;
          outcome = `timeout after ${step.timeout_seconds}s`;
          next = step.on_timeout;
        }
        break;
      }
      case 'send_email':
        outcome = `would send template ${step.template_id}`;
        next = step.next;
        break;
      case 'webhook':
        outcome = `would POST ${step.url}`;
        next = step.next;
        break;
      case 'suppress':
        outcome = `would ${step.action} suppression`;
        next = step.next;
        break;
      case 'goal':
        outcome = 'goal recorded';
        next = step.next;
        break;
      case 'exit':
        outcome = 'exited';
        next = null;
        break;
    }

    path.push({ step_id: step.id, step_type: step.type, outcome, next_step_id: next, virtual_elapsed_seconds: elapsed });
    if (step.type === 'exit') {
      endReason = 'exit_step';
      cursor = null;
      break;
    }
    cursor = next;
  }

  return {
    completed: endReason !== 'step_limit',
    end_reason: endReason,
    path,
    total_virtual_seconds: elapsed,
  };
}
