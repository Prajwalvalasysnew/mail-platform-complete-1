// Workflow engine end-to-end: builder CRUD + publish over HTTP, then real
// run execution through the BullMQ workflow worker against live PG + Redis —
// API triggers, event-driven waits, goals, re-entry policy, suppression
// honoring, simulation, and cancellation.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain, seedSuppression, countMessagesTo, type SeededCustomer } from './harness.js';
import { startWorkflowWorker } from '@platform/worker/workflow-worker.js';
import {
  getWorkflowRun,
  listWorkflowRuns,
  dispatchWorkflowEvent,
  triggerWorkflowRun,
} from '@platform/shared';

let app: FastifyInstance;
let worker: ReturnType<typeof startWorkflowWorker>;
let cust: SeededCustomer;
let domain: string;
let templateId: string;

const silentLogger: any = {
  info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {},
  child() { return silentLogger; },
};

function authed() {
  return { authorization: `Bearer ${cust.apiKey}` };
}

async function createAndPublish(name: string, definition: unknown): Promise<string> {
  const create = await app.inject({
    method: 'POST', url: '/v1/workflows', headers: authed(),
    payload: { name, definition },
  });
  expect(create.statusCode).toBe(201);
  const id = create.json().id as string;
  const publish = await app.inject({ method: 'POST', url: `/v1/workflows/${id}/publish`, headers: authed(), payload: {} });
  expect(publish.statusCode).toBe(200);
  expect(publish.json().version).toBe(1);
  return id;
}

async function waitForRunStatus(runId: string, targets: string[], timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = 'unknown';
  while (Date.now() < deadline) {
    const res = await getWorkflowRun(cust.customerId, runId);
    last = res?.run?.status ?? 'missing';
    if (targets.includes(last)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  return last;
}

beforeAll(async () => {
  app = await buildTestApp();
  worker = startWorkflowWorker(silentLogger);
  await worker.waitUntilReady();
  cust = await seedCustomer();
  domain = await seedVerifiedDomain(cust.customerId);

  const tpl = await app.inject({
    method: 'POST', url: '/v1/templates', headers: authed(),
    payload: {
      name: 'wf-welcome',
      subject: 'Welcome {{subject.email}}',
      html_body: '<p>Hello from the workflow</p>',
    },
  });
  expect(tpl.statusCode).toBe(201);
  templateId = tpl.json().id;
});

afterAll(async () => {
  await worker.close();
  await app.close();
});

describe('workflow builder API', () => {
  it('validates definitions without saving', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/workflows/validate', headers: authed(),
      payload: { definition: { trigger: { type: 'api' }, entry_step_id: 'ghost', steps: [] } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
  });

  it('rejects publishing a workflow that references a foreign template', async () => {
    const create = await app.inject({
      method: 'POST', url: '/v1/workflows', headers: authed(),
      payload: {
        name: 'bad-template-ref',
        definition: {
          trigger: { type: 'api' },
          entry_step_id: 's1',
          steps: [{ id: 's1', type: 'send_email', template_id: '00000000-0000-4000-8000-000000000000', from: `x@${domain}`, next: null }],
          settings: { allow_reentry: false, reentry_cooldown_seconds: 0 },
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const publish = await app.inject({ method: 'POST', url: `/v1/workflows/${create.json().id}/publish`, headers: authed(), payload: {} });
    expect(publish.statusCode).toBe(422);
    expect(publish.json().error).toBe('unknown_template');
  });

  it('runs CRUD + version history + simulate', async () => {
    const id = await createAndPublish('crud-flow', {
      trigger: { type: 'api' },
      entry_step_id: 'send',
      steps: [
        { id: 'send', type: 'send_email', template_id: templateId, from: `hello@${domain}`, next: 'done' },
        { id: 'done', type: 'exit' },
      ],
      settings: { allow_reentry: false, reentry_cooldown_seconds: 0 },
    });

    const list = await app.inject({ method: 'GET', url: '/v1/workflows', headers: authed() });
    expect(list.statusCode).toBe(200);
    expect(list.json().workflows.some((w: any) => w.id === id && w.status === 'active')).toBe(true);

    const versions = await app.inject({ method: 'GET', url: `/v1/workflows/${id}/versions`, headers: authed() });
    expect(versions.json().versions).toHaveLength(1);
    expect(versions.json().versions[0].is_published).toBe(true);

    const sim = await app.inject({
      method: 'POST', url: `/v1/workflows/${id}/simulate`, headers: authed(),
      payload: { source: 'published', subject_email: 'simulated@example.com' },
    });
    expect(sim.statusCode).toBe(200);
    expect(sim.json().simulation.path.map((p: any) => p.step_id)).toEqual(['send', 'done']);
    expect(sim.json().simulation.end_reason).toBe('exit_step');

    // No side effects from simulation.
    expect(await countMessagesTo(cust.customerId, 'simulated@example.com')).toBe(0);
  });

  it('enforces the workflows scope', async () => {
    const limited = await seedCustomer({ scopes: ['send'] });
    const res = await app.inject({ method: 'GET', url: '/v1/workflows', headers: { authorization: `Bearer ${limited.apiKey}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('insufficient_scope');
  });
});

describe('workflow execution', () => {
  it('executes an API-triggered run end to end: send_email -> suppress -> exit', async () => {
    const id = await createAndPublish('journey-send', {
      trigger: { type: 'api' },
      entry_step_id: 'send',
      steps: [
        { id: 'send', type: 'send_email', template_id: templateId, from: `hello@${domain}`, next: 'tagout' },
        { id: 'tagout', type: 'suppress', action: 'add', next: 'done' },
        { id: 'done', type: 'exit' },
      ],
      settings: { allow_reentry: false, reentry_cooldown_seconds: 0 },
    });

    const subject = `journey-${Date.now()}@example.com`;
    const trigger = await app.inject({
      method: 'POST', url: `/v1/workflows/${id}/trigger`, headers: authed(),
      payload: { subject_email: subject, context: { plan: 'pro' } },
    });
    expect(trigger.statusCode).toBe(202);
    const runId = trigger.json().run_id as string;

    expect(await waitForRunStatus(runId, ['exited'])).toBe('exited');

    const detail = await getWorkflowRun(cust.customerId, runId);
    const stepsById = new Map(detail!.steps.map((s: any) => [s.step_id, s]));
    expect(stepsById.get('send')!.status).toBe('completed');
    expect(stepsById.get('send')!.result.message_id).toBeTruthy();
    expect(stepsById.get('tagout')!.status).toBe('completed');

    // The message row exists and the suppress step actually landed.
    expect(await countMessagesTo(cust.customerId, subject)).toBe(1);

    // Re-entry blocked (allow_reentry: false).
    const again = await app.inject({
      method: 'POST', url: `/v1/workflows/${id}/trigger`, headers: authed(),
      payload: { subject_email: subject },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().reason).toBe('reentry_blocked');

    // Step stats reflect the executed path.
    const stats = await app.inject({ method: 'GET', url: `/v1/workflows/${id}/stats`, headers: authed() });
    const sendStat = stats.json().steps.find((s: any) => s.step_id === 'send');
    expect(sendStat.entered).toBe(1);
    expect(sendStat.completed).toBe(1);
  });

  it('skips the send (without failing the run) for suppressed subjects', async () => {
    const id = await createAndPublish('suppressed-flow', {
      trigger: { type: 'api' },
      entry_step_id: 'send',
      steps: [
        { id: 'send', type: 'send_email', template_id: templateId, from: `hello@${domain}`, next: null },
      ],
      settings: { allow_reentry: false, reentry_cooldown_seconds: 0 },
    });

    const subject = `opted-out-${Date.now()}@example.com`;
    await seedSuppression(cust.customerId, subject);

    const trigger = await app.inject({
      method: 'POST', url: `/v1/workflows/${id}/trigger`, headers: authed(),
      payload: { subject_email: subject },
    });
    expect(trigger.statusCode).toBe(202);
    const runId = trigger.json().run_id as string;

    expect(await waitForRunStatus(runId, ['completed'])).toBe('completed');
    const detail = await getWorkflowRun(cust.customerId, runId);
    expect(detail!.steps[0]!.status).toBe('skipped');
    expect(detail!.steps[0]!.result.skipped).toBe('suppressed');
    expect(await countMessagesTo(cust.customerId, subject)).toBe(0);
  });

  it('parks on wait_for_event and resumes when the event arrives', async () => {
    const id = await createAndPublish('wait-flow', {
      trigger: { type: 'api' },
      entry_step_id: 'wait',
      steps: [
        {
          id: 'wait', type: 'wait_for_event', event_types: ['opened'], timeout_seconds: 3600,
          scope: 'any', on_event: 'send', on_timeout: 'done',
        },
        { id: 'send', type: 'send_email', template_id: templateId, from: `hello@${domain}`, next: 'done' },
        { id: 'done', type: 'exit' },
      ],
      settings: { allow_reentry: false, reentry_cooldown_seconds: 0 },
    });

    const subject = `waiter-${Date.now()}@example.com`;
    const trigger = await app.inject({
      method: 'POST', url: `/v1/workflows/${id}/trigger`, headers: authed(),
      payload: { subject_email: subject },
    });
    const runId = trigger.json().run_id as string;
    expect(await waitForRunStatus(runId, ['waiting_event'])).toBe('waiting_event');

    // Engagement event arrives (what the event worker calls on 'opened').
    const dispatched = await dispatchWorkflowEvent({
      customerId: cust.customerId,
      eventType: 'opened',
      subjectEmail: subject,
      payload: {},
    });
    expect(dispatched.resumed_runs).toContain(runId);

    expect(await waitForRunStatus(runId, ['exited'])).toBe('exited');
    const detail = await getWorkflowRun(cust.customerId, runId);
    const wait = detail!.steps.find((s: any) => s.step_id === 'wait')!;
    expect(wait.result.branch).toBe('on_event');
    expect(await countMessagesTo(cust.customerId, subject)).toBe(1);
  });

  it('starts runs from engagement-event triggers and honors goal exit', async () => {
    const id = await createAndPublish('event-goal-flow', {
      trigger: { type: 'event', event_type: 'delivered' },
      entry_step_id: 'pause',
      steps: [
        { id: 'pause', type: 'delay', duration_seconds: 3600, next: 'send' },
        { id: 'send', type: 'send_email', template_id: templateId, from: `hello@${domain}`, next: null },
      ],
      goal: { event_type: 'clicked', exit_on_goal: true },
      settings: { allow_reentry: false, reentry_cooldown_seconds: 0 },
    });

    const subject = `converted-${Date.now()}@example.com`;

    // 'delivered' starts the run (event trigger)...
    const started = await dispatchWorkflowEvent({
      customerId: cust.customerId,
      eventType: 'delivered',
      subjectEmail: subject,
      payload: {},
    });
    expect(started.started_runs).toHaveLength(1);
    const runId = started.started_runs[0]!;
    expect(await waitForRunStatus(runId, ['waiting_delay'])).toBe('waiting_delay');

    // ...and 'clicked' hits the goal, exiting the parked run immediately.
    const goal = await dispatchWorkflowEvent({
      customerId: cust.customerId,
      eventType: 'clicked',
      subjectEmail: subject,
      payload: {},
    });
    expect(goal.goals_met).toContain(runId);

    const detail = await getWorkflowRun(cust.customerId, runId);
    expect(detail!.run.status).toBe('goal_met');
    expect(detail!.run.goal_met_at).toBeTruthy();
    // The delayed send never happened.
    expect(await countMessagesTo(cust.customerId, subject)).toBe(0);
  });

  it('cancels a parked run via the API', async () => {
    const id = await createAndPublish('cancel-flow', {
      trigger: { type: 'api' },
      entry_step_id: 'pause',
      steps: [
        { id: 'pause', type: 'delay', duration_seconds: 3600, next: null },
      ],
      settings: { allow_reentry: false, reentry_cooldown_seconds: 0 },
    });

    const subject = `cancel-${Date.now()}@example.com`;
    const trigger = await app.inject({
      method: 'POST', url: `/v1/workflows/${id}/trigger`, headers: authed(),
      payload: { subject_email: subject },
    });
    const runId = trigger.json().run_id as string;
    expect(await waitForRunStatus(runId, ['waiting_delay'])).toBe('waiting_delay');

    const cancel = await app.inject({ method: 'POST', url: `/v1/workflows/runs/${runId}/cancel`, headers: authed() });
    expect(cancel.statusCode).toBe(200);

    const detail = await getWorkflowRun(cust.customerId, runId);
    expect(detail!.run.status).toBe('canceled');
  });

  it('archiving cancels in-flight runs and blocks new triggers', async () => {
    const id = await createAndPublish('archive-flow', {
      trigger: { type: 'api' },
      entry_step_id: 'pause',
      steps: [{ id: 'pause', type: 'delay', duration_seconds: 3600, next: null }],
      settings: { allow_reentry: true, reentry_cooldown_seconds: 0 },
    });

    const subject = `archive-${Date.now()}@example.com`;
    const res = await triggerWorkflowRun({
      customerId: cust.customerId,
      workflowId: id,
      subjectEmail: subject,
      source: 'test',
    });
    expect(res.started).toBe(true);
    expect(await waitForRunStatus(res.run_id!, ['waiting_delay'])).toBe('waiting_delay');

    const del = await app.inject({ method: 'DELETE', url: `/v1/workflows/${id}`, headers: authed() });
    expect(del.statusCode).toBe(200);
    expect(del.json().canceled_runs).toBe(1);

    const after = await triggerWorkflowRun({
      customerId: cust.customerId,
      workflowId: id,
      subjectEmail: 'other@example.com',
      source: 'test',
    });
    expect(after.started).toBe(false);
    expect(after.skipped_reason).toBe('workflow_not_active');

    const runs = await listWorkflowRuns(cust.customerId, { workflowId: id });
    expect(runs.runs[0].status).toBe('canceled');
  });
});
