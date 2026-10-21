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

import crypto from 'node:crypto';
import { z } from 'zod';
import { parseDateValue, resolveRelativeDate } from './workflow-time.js';

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

// Business events the customer's own systems send ("order_placed",
// "appointment_booked", "trial_started") via POST /v1/workflows/events. Inside
// the engine they travel as 'custom:<name>' alongside the engagement events,
// so triggers, waits, goals and auto-exits all work with either kind.
export const CUSTOM_EVENT_NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const customEventKey = (name: string) => `custom:${name.toLowerCase()}`;
const EventKeySchema = z.string().refine(
  (v) => (WORKFLOW_EVENT_TYPES as readonly string[]).includes(v) || (v.startsWith('custom:') && CUSTOM_EVENT_NAME.test(v.slice(7))),
  'must be an email event (delivered, opened, clicked, ...) or custom:<event_name>'
);
const TimeZoneSchema = z.string().max(64).refine((tz) => {
  if (tz === 'contact') return true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}, 'must be "contact" or an IANA time zone such as America/New_York');
const ClockSchema = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'use HH:MM (24-hour)');
const WeekdaysSchema = z.array(z.number().int().min(0).max(6)).max(7).optional();

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
  op: z.enum([
    'eq', 'neq', 'contains', 'not_contains', 'exists', 'not_exists', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in',
    'starts_with', 'ends_with', 'is_true', 'is_false',
    // Dates: value is an ISO date or a relative expression ('now', 'now-7d', 'now+2h').
    'before', 'after',
  ]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()])).max(100)]).optional(),
});
export type ConditionRule = z.infer<typeof ConditionRuleSchema>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const DeliverWindowSchema = z
  .object({
    // Hours in `timezone` (UTC when omitted); {start_hour: 9, end_hour: 17} delivers 09:00-16:59.
    start_hour: z.number().int().min(0).max(23),
    end_hour: z.number().int().min(1).max(24),
    timezone: TimeZoneSchema.optional(),
    days: WeekdaysSchema,
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
  event_types: z.array(EventKeySchema).min(1).max(20),
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
  // Optional subject line for this step; the template's subject otherwise.
  subject: z.string().min(1).max(998).optional(),
  // Extra template variables merged over the run context at render time.
  variables: z.record(z.unknown()).optional(),
  next: STEP_ID.nullable(),
});

// Wait until a moment derived from data ("1 day before context.appointment_at")
// or until a local clock time ("next 09:00 in the contact's time zone").
const WaitUntilStepSchema = z.object({
    id: STEP_ID,
    type: z.literal('wait_until'),
    name: z.string().max(200).optional(),
    mode: z.enum(['field', 'time_of_day']),
    field: z.string().min(1).max(200).optional(),
    // Negative = before the date (reminders), positive = after (follow-ups).
    offset_seconds: z.number().int().min(-365 * 86_400).max(365 * 86_400).default(0),
    time: ClockSchema.optional(),
    timezone: TimeZoneSchema.optional(),
    days: WeekdaysSchema,
    // When the date is missing, unparseable or already past.
    if_missed: z.enum(['continue', 'exit']).default('continue'),
    next: STEP_ID.nullable(),
});

// CRM-style contact updates: tags, custom attributes, subscription status.
const UpdateContactStepSchema = z.object({
  id: STEP_ID,
  type: z.literal('update_contact'),
  name: z.string().max(200).optional(),
  add_tags: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  remove_tags: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  set_attributes: z.record(z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).default({}),
  status: z.enum(['Subscribed', 'Unsubscribed']).optional(),
  next: STEP_ID.nullable(),
});

// Internal alert to the customer's own team (new lead, failed payment, VIP).
const NotifyStepSchema = z.object({
  id: STEP_ID,
  type: z.literal('notify'),
  name: z.string().max(200).optional(),
  to: z.array(z.string().email()).min(1).max(5),
  from: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
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

const SplitStepSchema = z.object({
  id: STEP_ID,
  type: z.literal('split'),
  name: z.string().max(200).optional(),
  // Percentage of subjects routed to branch_a; the remainder go to branch_b.
  percent_a: z.number().int().min(0).max(100),
  branch_a: STEP_ID.nullable(),
  branch_b: STEP_ID.nullable(),
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
  SplitStepSchema,
  SuppressStepSchema,
  GoalStepSchema,
  ExitStepSchema,
  WaitUntilStepSchema,
  UpdateContactStepSchema,
  NotifyStepSchema,
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
  z.object({
    // Named business event from the customer's systems (POST /v1/workflows/events):
    // order_placed, appointment_booked, trial_started, payment_failed, ...
    type: z.literal('custom_event'),
    event_name: z.string().regex(CUSTOM_EVENT_NAME, 'lowercase letters, digits, _ . - (max 64)'),
    filters: z.array(ConditionRuleSchema).max(10).optional(),
  }),
  z.object({
    // A contact is added to a list or segment.
    type: z.literal('audience'),
    collection_id: z.string().uuid(),
  }),
  z.object({
    // Daily date-based entry: birthdays, renewals, anniversaries, due dates.
    type: z.literal('date'),
    // Contact field holding the date, e.g. contact.attributes.birthday.
    field: z.string().regex(/^contact\.(attributes\.[a-zA-Z0-9_]{1,64}|created_at)$/, 'use contact.attributes.<name> or contact.created_at'),
    // Enter this many days before (negative) or after (positive) the date.
    offset_days: z.number().int().min(-365).max(365).default(0),
    // yearly: match month+day every year (birthdays, anniversaries); once: the exact date.
    recurrence: z.enum(['yearly', 'once']).default('yearly'),
    hour: z.number().int().min(0).max(23).default(9),
    timezone: TimeZoneSchema.default('UTC'),
  }),
]);
export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;

export const WorkflowGoalSchema = z.object({
  name: z.string().max(200).optional(),
  event_type: EventKeySchema,
  // Stop the journey when the goal is reached (default: record + continue).
  exit_on_goal: z.boolean().default(false),
});
export type WorkflowGoal = z.infer<typeof WorkflowGoalSchema>;

export const WorkflowSettingsSchema = z.object({
  allow_reentry: z.boolean().default(false),
  reentry_cooldown_seconds: z.number().int().min(0).max(365 * 86_400).default(0),
  // Auto-exit: events that immediately pull an in-flight subject out of the
  // journey. Defaults to the compliance-critical pair — someone who
  // unsubscribes or complains must not keep receiving journey mail.
  exit_on_events: z.array(EventKeySchema).max(20).default(['unsubscribed', 'complaint']),
  // Who may enter: rules over the trigger bag (contact.*, trigger.*, context.*).
  entry: z
    .object({
      match: z.enum(['all', 'any']).default('all'),
      rules: z.array(ConditionRuleSchema).max(20).default([]),
      // Only contacts whose status is Subscribed (and who are not suppressed).
      require_subscribed: z.boolean().default(false),
    })
    .optional(),
  // Quiet hours: email/notify steps only execute inside this local window.
  send_window: z
    .object({ start: ClockSchema, end: ClockSchema, timezone: TimeZoneSchema.default('contact'), days: WeekdaysSchema })
    .optional(),
  // Frequency cap across every workflow and campaign: at most `max` marketing
  // emails per contact in `days`. Excess sends wait until the cap frees up.
  frequency_cap: z.object({ max: z.number().int().min(1).max(100), days: z.number().int().min(1).max(30) }).optional(),
  // Fallback time zone for contacts without one ("contact" windows/waits).
  default_timezone: TimeZoneSchema.optional(),
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
    case 'split':
      return [step.branch_a, step.branch_b];
    case 'exit':
      return [];
    default:
      return [step.next];
  }
}

/**
 * Deterministic A/B assignment for a split step. Keyed (not random) so a
 * crashed/retried step execution always lands on the same branch — randomness
 * would break the engine's effectively-once guarantee.
 */
export function splitBranchForKey(key: string, percentA: number): 'a' | 'b' {
  const bucket = crypto.createHash('sha256').update(key).digest().readUInt32BE(0) % 100;
  return bucket < percentA ? 'a' : 'b';
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

  for (const step of def.steps) {
    if (step.type === 'wait_until' && (step.mode === 'field' ? !step.field : !step.time)) {
      errors.push({ code: 'invalid_wait_until', message: `Step '${step.id}': ${step.mode === 'field' ? 'choose the date field to wait for' : 'set the time of day'}`, step_id: step.id });
    }
    if (step.type === 'update_contact' && !step.add_tags.length && !step.remove_tags.length && !Object.keys(step.set_attributes).length && !step.status) {
      errors.push({ code: 'empty_update', message: `Step '${step.id}': choose at least one contact change`, step_id: step.id });
    }
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

  // A workflow triggered by an event that is also configured to auto-exit
  // subjects would start runs that a *second* occurrence immediately kills —
  // usually a misconfiguration, occasionally intentional (win-back on
  // complaint). Surface it, don't block it.
  if (def.trigger.type === 'event' && def.settings.exit_on_events.includes(def.trigger.event_type)) {
    warnings.push({
      code: 'trigger_is_exit_event',
      message: `Trigger event '${def.trigger.event_type}' is also in settings.exit_on_events; a repeat of the event will exit the run it started`,
    });
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

/** A list value: an array, or a comma-separated string from a form field. */
function listValue(value: unknown): Array<string | number> {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
  return value === undefined || value === null ? [] : [String(value)];
}

export function evaluateRule(bag: Record<string, unknown>, rule: ConditionRule, now = new Date()): boolean {
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
      if (Array.isArray(actual)) return actual.some((v) => String(v).toLowerCase() === String(rule.value ?? '').toLowerCase());
      return false;
    case 'not_contains':
      if (typeof actual === 'string') return !actual.toLowerCase().includes(String(rule.value ?? '').toLowerCase());
      if (Array.isArray(actual)) return !actual.some((v) => String(v).toLowerCase() === String(rule.value ?? '').toLowerCase());
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
      return listValue(rule.value).some((v) => String(v).toLowerCase() === String(actual ?? '').toLowerCase());
    case 'not_in':
      return !listValue(rule.value).some((v) => String(v).toLowerCase() === String(actual ?? '').toLowerCase());
    case 'starts_with':
      return typeof actual === 'string' && actual.toLowerCase().startsWith(String(rule.value ?? '').toLowerCase());
    case 'ends_with':
      return typeof actual === 'string' && actual.toLowerCase().endsWith(String(rule.value ?? '').toLowerCase());
    case 'is_true':
      return actual === true || actual === 'true' || actual === 1 || actual === '1' || actual === 'yes';
    case 'is_false':
      return !(actual === true || actual === 'true' || actual === 1 || actual === '1' || actual === 'yes');
    case 'before':
    case 'after': {
      const a = parseDateValue(actual), b = resolveRelativeDate(rule.value, now);
      if (!a || !b) return false;
      return rule.op === 'before' ? a.getTime() < b.getTime() : a.getTime() > b.getTime();
    }
    default:
      return false;
  }
}

export function evaluateRules(
  bag: Record<string, unknown>,
  rules: ConditionRule[],
  match: 'all' | 'any',
  now = new Date()
): boolean {
  if (rules.length === 0) return true;
  return match === 'all' ? rules.every((r) => evaluateRule(bag, r, now)) : rules.some((r) => evaluateRule(bag, r, now));
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
  // For each split step id: force branch 'a' or 'b'. Missing entries use the
  // same deterministic hash the engine uses (keyed on subject email here).
  split_outcomes?: Record<string, 'a' | 'b'>;
  contact?: Record<string, unknown>;
  run_opened?: boolean;
  run_clicked?: boolean;
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
    contact: input.contact ?? { email: input.subject_email ?? 'test@example.com', tags: [], attributes: {} },
    run: { opened: input.run_opened ?? false, clicked: input.run_clicked ?? false },
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
      case 'split': {
        const branch =
          input.split_outcomes?.[step.id] ??
          splitBranchForKey(`${(bag.subject as any).email}:${step.id}`, step.percent_a);
        outcome = `branch:${branch} (${step.percent_a}/${100 - step.percent_a})`;
        next = branch === 'a' ? step.branch_a : step.branch_b;
        break;
      }
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
      case 'wait_until':
        outcome = step.mode === 'field' ? `wait until ${step.field}${step.offset_seconds ? ` ${step.offset_seconds > 0 ? '+' : ''}${step.offset_seconds}s` : ''}` : `wait until ${step.time} (${step.timezone ?? 'contact'})`;
        next = step.next;
        break;
      case 'update_contact':
        outcome = `would update contact${step.add_tags.length ? ` +tags ${step.add_tags.join(',')}` : ''}${step.remove_tags.length ? ` -tags ${step.remove_tags.join(',')}` : ''}${Object.keys(step.set_attributes).length ? ` set ${Object.keys(step.set_attributes).join(',')}` : ''}${step.status ? ` status ${step.status}` : ''}`;
        next = step.next;
        // Later conditions in the simulation see the update.
        {
          const contact = ((bag.contact as any) ??= { tags: [], attributes: {} });
          contact.tags = [...new Set([...(contact.tags ?? []), ...step.add_tags])].filter((t: string) => !step.remove_tags.includes(t));
          contact.attributes = { ...(contact.attributes ?? {}), ...step.set_attributes };
          if (step.status) contact.status = step.status;
        }
        break;
      case 'notify':
        outcome = `would notify ${step.to.join(', ')}`;
        next = step.next;
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
