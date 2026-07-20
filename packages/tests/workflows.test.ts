// Workflow definition validation + simulation (pure — no DB/Redis needed).
import { describe, it, expect } from 'vitest';
import {
  validateWorkflowDefinition,
  simulateWorkflow,
  computeWakeAt,
  evaluateRule,
  splitBranchForKey,
  isRetryableWebhookFailure,
} from '@platform/shared';

const TEMPLATE_ID = '4f0b17a6-52b3-4c1d-9e59-1af2cbb7e001';

function welcomeSeries() {
  // Mirrors the builder screenshot: trigger -> delay -> wait-for-open ->
  // (yes: send email / no: webhook) -> goal -> exit.
  return {
    trigger: { type: 'event', event_type: 'delivered' },
    entry_step_id: 'wait1',
    steps: [
      { id: 'wait1', type: 'delay', duration_seconds: 86_400, next: 'opened' },
      {
        id: 'opened',
        type: 'wait_for_event',
        event_types: ['opened'],
        timeout_seconds: 172_800,
        scope: 'any',
        on_event: 'welcome',
        on_timeout: 'nudge',
      },
      { id: 'welcome', type: 'send_email', template_id: TEMPLATE_ID, from: 'hi@acme.example', next: 'goal' },
      { id: 'nudge', type: 'webhook', url: 'https://hooks.example.com/nudge', next: 'goal' },
      { id: 'goal', type: 'goal', name: 'engaged', next: 'end' },
      { id: 'end', type: 'exit' },
    ],
    goal: { event_type: 'clicked', exit_on_goal: true },
    settings: { allow_reentry: true, reentry_cooldown_seconds: 604_800 },
  };
}

describe('workflow definition validation', () => {
  it('accepts a well-formed definition', () => {
    const v = validateWorkflowDefinition(welcomeSeries(), { strict: true });
    expect(v.errors).toEqual([]);
    expect(v.valid).toBe(true);
    expect(v.definition?.steps).toHaveLength(6);
  });

  it('rejects unknown branch targets', () => {
    const def = welcomeSeries();
    (def.steps[0] as any).next = 'nope';
    const v = validateWorkflowDefinition(def);
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.code === 'missing_target')).toBe(true);
  });

  it('rejects duplicate step ids', () => {
    const def = welcomeSeries();
    (def.steps[1] as any).id = 'wait1';
    const v = validateWorkflowDefinition(def);
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.code === 'duplicate_step_id')).toBe(true);
  });

  it('rejects cycles', () => {
    const def = welcomeSeries();
    (def.steps[4] as any).next = 'wait1'; // goal loops back to the delay
    const v = validateWorkflowDefinition(def);
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.code === 'cycle')).toBe(true);
  });

  it('warns about unreachable steps in draft mode, rejects at publish', () => {
    const def = welcomeSeries();
    def.steps.push({ id: 'island', type: 'exit' } as any);
    const draft = validateWorkflowDefinition(def, { strict: false });
    expect(draft.valid).toBe(true);
    expect(draft.warnings.some((w) => w.code === 'unreachable_step')).toBe(true);
    const publish = validateWorkflowDefinition(def, { strict: true });
    expect(publish.valid).toBe(false);
  });

  it('requires an entry step for publish but not for drafts', () => {
    const def = { ...welcomeSeries(), entry_step_id: null };
    expect(validateWorkflowDefinition(def, { strict: false }).valid).toBe(true);
    const strict = validateWorkflowDefinition(def, { strict: true });
    expect(strict.valid).toBe(false);
    expect(strict.errors.some((e) => e.code === 'no_entry')).toBe(true);
  });

  it('rejects malformed step schemas with paths in messages', () => {
    const def = welcomeSeries();
    (def.steps[2] as any).template_id = 'not-a-uuid';
    const v = validateWorkflowDefinition(def);
    expect(v.valid).toBe(false);
    expect(v.errors[0]!.code).toBe('schema');
  });
});

describe('condition rule evaluation', () => {
  const bag = { trigger: { plan: 'pro', score: 42 }, subject: { email: 'a@b.c' }, context: { tags: ['vip', 'beta'] } };

  it('handles comparison and membership operators', () => {
    expect(evaluateRule(bag, { field: 'trigger.plan', op: 'eq', value: 'pro' })).toBe(true);
    expect(evaluateRule(bag, { field: 'trigger.score', op: 'gte', value: 42 })).toBe(true);
    expect(evaluateRule(bag, { field: 'trigger.score', op: 'lt', value: 42 })).toBe(false);
    expect(evaluateRule(bag, { field: 'context.tags', op: 'contains', value: 'vip' })).toBe(true);
    expect(evaluateRule(bag, { field: 'trigger.plan', op: 'in', value: ['free', 'pro'] })).toBe(true);
    expect(evaluateRule(bag, { field: 'trigger.missing', op: 'not_exists' })).toBe(true);
  });
});

describe('workflow simulation', () => {
  it('walks the happy path when awaited events arrive', () => {
    const def = validateWorkflowDefinition(welcomeSeries(), { strict: true }).definition!;
    const sim = simulateWorkflow(def, { subject_email: 'user@example.com' });
    expect(sim.completed).toBe(true);
    expect(sim.end_reason).toBe('exit_step');
    expect(sim.path.map((p) => p.step_id)).toEqual(['wait1', 'opened', 'welcome', 'goal', 'end']);
    expect(sim.total_virtual_seconds).toBe(86_400); // wait-for-event resolved without timeout
  });

  it('takes the timeout branch when the event never arrives', () => {
    const def = validateWorkflowDefinition(welcomeSeries(), { strict: true }).definition!;
    const sim = simulateWorkflow(def, { event_outcomes: { opened: false } });
    expect(sim.path.map((p) => p.step_id)).toEqual(['wait1', 'opened', 'nudge', 'goal', 'end']);
    expect(sim.total_virtual_seconds).toBe(86_400 + 172_800);
  });

  it('follows condition branches from trigger payload', () => {
    const def = validateWorkflowDefinition(
      {
        trigger: { type: 'api' },
        entry_step_id: 'cond',
        steps: [
          {
            id: 'cond',
            type: 'condition',
            match: 'all',
            rules: [{ field: 'context.plan', op: 'eq', value: 'pro' }],
            on_true: 'yes',
            on_false: 'no',
          },
          { id: 'yes', type: 'exit' },
          { id: 'no', type: 'exit' },
        ],
        settings: { allow_reentry: false, reentry_cooldown_seconds: 0 },
      },
      { strict: true }
    ).definition!;

    expect(simulateWorkflow(def, { context: { plan: 'pro' } }).path[0]!.outcome).toBe('branch:on_true');
    expect(simulateWorkflow(def, { context: { plan: 'free' } }).path[0]!.outcome).toBe('branch:on_false');
  });
});

describe('A/B split step', () => {
  function splitDef(percentA: number) {
    return validateWorkflowDefinition(
      {
        trigger: { type: 'api' },
        entry_step_id: 'ab',
        steps: [
          { id: 'ab', type: 'split', percent_a: percentA, branch_a: 'a', branch_b: 'b' },
          { id: 'a', type: 'exit' },
          { id: 'b', type: 'exit' },
        ],
        settings: { allow_reentry: false, reentry_cooldown_seconds: 0 },
      },
      { strict: true }
    ).definition!;
  }

  it('validates split steps and their branch targets', () => {
    const bad = {
      trigger: { type: 'api' },
      entry_step_id: 'ab',
      steps: [{ id: 'ab', type: 'split', percent_a: 50, branch_a: 'ghost', branch_b: null }],
      settings: { allow_reentry: false, reentry_cooldown_seconds: 0 },
    };
    expect(validateWorkflowDefinition(bad).errors.some((e) => e.code === 'missing_target')).toBe(true);
  });

  it('assigns branches deterministically (same key, same branch) at roughly the configured ratio', () => {
    expect(splitBranchForKey('run-1:ab', 50)).toBe(splitBranchForKey('run-1:ab', 50));
    let a = 0;
    for (let i = 0; i < 1000; i++) if (splitBranchForKey(`run-${i}:ab`, 30) === 'a') a++;
    expect(a).toBeGreaterThan(200);
    expect(a).toBeLessThan(400);
    expect(splitBranchForKey('any:key', 0)).toBe('b');
    expect(splitBranchForKey('any:key', 100)).toBe('a');
  });

  it('simulates splits with forced and hashed outcomes', () => {
    const def = splitDef(50);
    const forcedA = simulateWorkflow(def, { split_outcomes: { ab: 'a' } });
    expect(forcedA.path.map((p) => p.step_id)).toEqual(['ab', 'a']);
    const forcedB = simulateWorkflow(def, { split_outcomes: { ab: 'b' } });
    expect(forcedB.path.map((p) => p.step_id)).toEqual(['ab', 'b']);
    // Hashed default is deterministic for the same subject.
    const s1 = simulateWorkflow(def, { subject_email: 'x@example.com' });
    const s2 = simulateWorkflow(def, { subject_email: 'x@example.com' });
    expect(s1.path[1]!.step_id).toBe(s2.path[1]!.step_id);
  });
});

describe('auto-exit settings', () => {
  it('defaults exit_on_events to unsubscribed + complaint', () => {
    const def = validateWorkflowDefinition(welcomeSeries(), { strict: true }).definition!;
    expect(def.settings.exit_on_events.sort()).toEqual(['complaint', 'unsubscribed']);
  });

  it('warns when the trigger event is also an exit event', () => {
    const def = welcomeSeries();
    (def as any).trigger = { type: 'event', event_type: 'complaint' };
    const v = validateWorkflowDefinition(def, { strict: true });
    expect(v.valid).toBe(true);
    expect(v.warnings.some((w) => w.code === 'trigger_is_exit_event')).toBe(true);
  });
});

describe('webhook failure classification', () => {
  it('retries 5xx, timeouts, and network errors; fails through 4xx/SSRF/URL errors', () => {
    expect(isRetryableWebhookFailure({ ok: false, status: 503 })).toBe(true);
    expect(isRetryableWebhookFailure({ ok: false, error: 'timeout' })).toBe(true);
    expect(isRetryableWebhookFailure({ ok: false, error: 'fetch failed' })).toBe(true);
    expect(isRetryableWebhookFailure({ ok: false, status: 404 })).toBe(false);
    expect(isRetryableWebhookFailure({ ok: false, status: 401 })).toBe(false);
    expect(isRetryableWebhookFailure({ ok: false, error: 'ssrf_blocked' })).toBe(false);
    expect(isRetryableWebhookFailure({ ok: false, error: 'url_error' })).toBe(false);
    expect(isRetryableWebhookFailure({ ok: true, status: 200 })).toBe(false);
  });
});

describe('computeWakeAt delivery windows', () => {
  it('returns the raw wake time without a window', () => {
    const now = new Date('2026-07-17T10:00:00Z');
    expect(computeWakeAt(now, 3600).toISOString()).toBe('2026-07-17T11:00:00.000Z');
  });

  it('keeps a wake time already inside the window', () => {
    const now = new Date('2026-07-17T10:00:00Z');
    const wake = computeWakeAt(now, 3600, { start_hour: 9, end_hour: 17 });
    expect(wake.toISOString()).toBe('2026-07-17T11:00:00.000Z');
  });

  it('pushes an early-morning wake to the window start', () => {
    const now = new Date('2026-07-17T01:00:00Z');
    const wake = computeWakeAt(now, 3600, { start_hour: 9, end_hour: 17 });
    expect(wake.toISOString()).toBe('2026-07-17T09:00:00.000Z');
  });

  it('pushes a post-window wake to the next day start', () => {
    const now = new Date('2026-07-17T20:00:00Z');
    const wake = computeWakeAt(now, 3600, { start_hour: 9, end_hour: 17 });
    expect(wake.toISOString()).toBe('2026-07-18T09:00:00.000Z');
  });
});
