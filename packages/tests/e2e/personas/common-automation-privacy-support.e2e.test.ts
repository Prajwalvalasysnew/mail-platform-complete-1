// Tier-parameterized workflow, privacy/export, and support journeys.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getWorkflowRun, runDataExport } from '@platform/shared';
import { startWorkflowWorker } from '@platform/worker/workflow-worker.js';
import {
  countMessagesTo,
  resetPoolWarmup,
  resetQuota,
  seedAdminSession,
  startHarness,
  waitForStatus,
  type Harness,
} from '../harness.js';
import {
  PERSONA_TIERS,
  provisionSendingPersona,
  registerVerifiedHumanPersona,
  sessionHeaders,
  type PersonaTier,
} from './persona-helpers.js';

let h: Harness;
let workflowWorker: ReturnType<typeof startWorkflowWorker>;

const silentLogger: any = {
  info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {},
  child() { return silentLogger; },
};

beforeAll(async () => {
  h = await startHarness();
  await resetPoolWarmup('transactional');
  workflowWorker = startWorkflowWorker(silentLogger);
  await workflowWorker.waitUntilReady();
});

afterAll(async () => {
  await workflowWorker.close();
  await h.close();
});

function apiHeaders(apiKey: string, json = false): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

async function waitForWorkflow(customerId: string, runId: string, targets: string[], timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let status = 'missing';
  while (Date.now() < deadline) {
    const detail = await getWorkflowRun(customerId, runId);
    status = detail?.run.status ?? 'missing';
    if (targets.includes(status)) return detail!;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Workflow ${runId} remained ${status}; expected ${targets.join(', ')}`);
}

describe.each(PERSONA_TIERS)('common automation, privacy, and support: %s', (tier: PersonaTier) => {
  it('builds, publishes, simulates, executes, observes, and archives a workflow', async () => {
    const persona = await provisionSendingPersona(h.app, tier, 'workflow', [
      'send', 'messages', 'templates', 'workflows', 'suppressions',
    ]);
    await resetQuota(persona.customerId);

    const template = await h.app.inject({
      method: 'POST', url: '/v1/templates', headers: apiHeaders(persona.apiKey, true),
      payload: {
        name: `${tier}-workflow-welcome`, subject: 'Welcome {{subject.email}}',
        html_body: '<p>Your automated journey has started.</p>',
      },
    });
    expect(template.statusCode).toBe(201);

    const definition = {
      trigger: { type: 'api' },
      entry_step_id: 'send',
      steps: [
        {
          id: 'send', type: 'send_email', template_id: template.json().id,
          from: `automation@${persona.domain}`, next: 'suppress',
        },
        { id: 'suppress', type: 'suppress', action: 'add', next: 'done' },
        { id: 'done', type: 'exit' },
      ],
      settings: { allow_reentry: false, reentry_cooldown_seconds: 0 },
    };
    const validate = await h.app.inject({
      method: 'POST', url: '/v1/workflows/validate', headers: apiHeaders(persona.apiKey, true),
      payload: { definition },
    });
    expect(validate.statusCode).toBe(200);
    expect(validate.json().valid).toBe(true);

    const create = await h.app.inject({
      method: 'POST', url: '/v1/workflows', headers: apiHeaders(persona.apiKey, true),
      payload: { name: `${tier} onboarding journey`, description: 'Persona E2E workflow', definition },
    });
    expect(create.statusCode).toBe(201);
    const workflowId = create.json().id as string;

    const publish = await h.app.inject({
      method: 'POST', url: `/v1/workflows/${workflowId}/publish`, headers: apiHeaders(persona.apiKey, true), payload: {},
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json().version).toBe(1);

    const simulationRecipient = `${tier}-simulation-${persona.runId}@example.net`;
    const simulation = await h.app.inject({
      method: 'POST', url: `/v1/workflows/${workflowId}/simulate`, headers: apiHeaders(persona.apiKey, true),
      payload: { source: 'published', subject_email: simulationRecipient },
    });
    expect(simulation.statusCode).toBe(200);
    expect(simulation.json().simulation.path.map((step: any) => step.step_id)).toEqual(['send', 'suppress', 'done']);
    expect(await countMessagesTo(persona.customerId, simulationRecipient)).toBe(0);

    const recipient = `${tier}-workflow-${persona.runId}@example.net`;
    const trigger = await h.app.inject({
      method: 'POST', url: `/v1/workflows/${workflowId}/trigger`, headers: apiHeaders(persona.apiKey, true),
      payload: { subject_email: recipient, context: { persona_tier: tier } },
    });
    expect(trigger.statusCode).toBe(202);
    const runId = trigger.json().run_id as string;
    const detail = await waitForWorkflow(persona.customerId, runId, ['exited']);
    expect(detail.steps.map((step: any) => step.status)).toEqual(['completed', 'completed', 'completed']);
    expect(await countMessagesTo(persona.customerId, recipient)).toBe(1);

    const runApi = await h.app.inject({
      method: 'GET', url: `/v1/workflows/runs/${runId}`, headers: apiHeaders(persona.apiKey),
    });
    expect(runApi.statusCode).toBe(200);
    expect(runApi.json().run.status).toBe('exited');

    const versions = await h.app.inject({
      method: 'GET', url: `/v1/workflows/${workflowId}/versions`, headers: apiHeaders(persona.apiKey),
    });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().versions).toHaveLength(1);

    const stats = await h.app.inject({
      method: 'GET', url: `/v1/workflows/${workflowId}/stats`, headers: apiHeaders(persona.apiKey),
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().steps.find((step: any) => step.step_id === 'send')).toMatchObject({ entered: 1, completed: 1 });

    const archive = await h.app.inject({
      method: 'DELETE', url: `/v1/workflows/${workflowId}`, headers: apiHeaders(persona.apiKey),
    });
    expect(archive.statusCode).toBe(200);
    expect(archive.json().archived).toBe(true);
  });

  it('exports recipient data, creates a downloadable export, and honors legal holds during erasure', async () => {
    const persona = await provisionSendingPersona(h.app, tier, 'privacy', [
      'send', 'messages', 'suppressions',
    ]);
    await resetQuota(persona.customerId);
    const recipient = `${tier}-privacy-${persona.runId}@example.net`;

    const send = await h.app.inject({
      method: 'POST', url: '/v1/send', headers: apiHeaders(persona.apiKey, true),
      payload: {
        from: `privacy@${persona.domain}`, to: recipient,
        subject: 'Privacy lifecycle record', text: 'Personal data export and erasure test.',
      },
    });
    expect(send.statusCode).toBe(202);
    const messageId = send.json().message_ids[0] as string;
    expect(['accepted', 'sent']).toContain(await waitForStatus(messageId, ['accepted', 'sent']));

    expect((await h.app.inject({
      method: 'POST', url: '/v1/suppressions', headers: apiHeaders(persona.apiKey, true),
      payload: { email: recipient, reason: 'manual' },
    })).statusCode).toBe(201);

    const recipientExport = await h.app.inject({
      method: 'GET', url: `/v1/privacy/export-recipient?email=${encodeURIComponent(recipient)}`,
      headers: apiHeaders(persona.apiKey),
    });
    expect(recipientExport.statusCode).toBe(200);
    expect(recipientExport.json().messages.map((message: any) => message.message_id)).toContain(messageId);
    expect(recipientExport.json().events.length).toBeGreaterThan(0);
    expect(recipientExport.json().suppressed.reason).toBe('manual');

    const now = new Date();
    const createExport = await h.app.inject({
      method: 'POST', url: '/v1/exports', headers: apiHeaders(persona.apiKey, true),
      payload: {
        kind: 'events',
        from: new Date(now.getTime() - 86_400_000).toISOString(),
        to: new Date(now.getTime() + 60_000).toISOString(),
      },
    });
    expect(createExport.statusCode).toBe(202);
    const exportId = createExport.json().export.id as string;
    expect((await runDataExport(exportId))?.status).toBe('completed');

    const download = await h.app.inject({
      method: 'GET', url: `/v1/exports/${exportId}/download`, headers: apiHeaders(persona.apiKey),
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/x-ndjson');
    expect(download.body).toContain(messageId);

    const hold = await h.app.inject({
      method: 'POST', url: '/v1/privacy/legal-holds', headers: apiHeaders(persona.apiKey, true),
      payload: { scope: recipient, reason: 'Persona E2E preservation check' },
    });
    expect(hold.statusCode).toBe(201);
    const holdId = hold.json().hold.id as string;

    const blocked = await h.app.inject({
      method: 'POST', url: '/v1/privacy/delete-recipient', headers: apiHeaders(persona.apiKey, true),
      payload: { recipient, requested_by: `${tier} privacy administrator` },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('legal_hold_active');

    expect((await h.app.inject({
      method: 'POST', url: `/v1/privacy/legal-holds/${holdId}/release`, headers: apiHeaders(persona.apiKey),
    })).statusCode).toBe(200);

    const erase = await h.app.inject({
      method: 'POST', url: '/v1/privacy/delete-recipient', headers: apiHeaders(persona.apiKey, true),
      payload: { recipient, requested_by: `${tier} privacy administrator` },
    });
    expect([200, 202]).toContain(erase.statusCode);
    expect(erase.json().messages_deleted).toBe(1);

    const after = await h.app.inject({
      method: 'GET', url: `/v1/privacy/export-recipient?email=${encodeURIComponent(recipient)}`,
      headers: apiHeaders(persona.apiKey),
    });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({ messages: [], events: [], suppressed: null });

    const deletions = await h.app.inject({
      method: 'GET', url: '/v1/privacy/deletions', headers: apiHeaders(persona.apiKey),
    });
    expect(deletions.statusCode).toBe(200);
    expect(deletions.json().deletions).toEqual(expect.arrayContaining([
      expect.objectContaining({ recipient: recipient.toLowerCase(), messages_deleted: 1 }),
    ]));
  });

  it('completes the customer support conversation, resolution, and CSAT lifecycle', async () => {
    const persona = await registerVerifiedHumanPersona(h.app, tier, 'support');
    const admin = await seedAdminSession('support');

    const create = await h.app.inject({
      method: 'POST', url: '/v1/support/tickets', headers: sessionHeaders(persona.sessionToken, true),
      payload: {
        subject: `${tier} webhook delivery question`,
        body: 'Please help us understand a delayed webhook.',
        priority: 'high', category: 'technical',
      },
    });
    expect(create.statusCode).toBe(201);
    const ticketId = create.json().ticket.id as string;

    const adminReply = await h.app.inject({
      method: 'POST', url: `/admin/support-tickets/${ticketId}/messages`,
      headers: apiHeaders(admin.token, true), payload: { body: 'We found the delay and are applying the fix.' },
    });
    expect(adminReply.statusCode).toBe(201);

    const unread = await h.app.inject({
      method: 'GET', url: '/v1/support/tickets/unread-count', headers: sessionHeaders(persona.sessionToken),
    });
    expect(unread.statusCode).toBe(200);
    expect(unread.json().unread).toBe(1);

    const reply = await h.app.inject({
      method: 'POST', url: `/v1/support/tickets/${ticketId}/messages`,
      headers: sessionHeaders(persona.sessionToken, true),
      payload: { body: 'Thank you. We can confirm delivery has recovered.' },
    });
    expect(reply.statusCode).toBe(201);

    const resolved = await h.app.inject({
      method: 'PATCH', url: `/admin/support-tickets/${ticketId}`,
      headers: apiHeaders(admin.token, true), payload: { status: 'resolved' },
    });
    expect(resolved.statusCode).toBe(200);

    const rate = await h.app.inject({
      method: 'POST', url: `/v1/support/tickets/${ticketId}/rate`,
      headers: sessionHeaders(persona.sessionToken, true),
      payload: { rating: 5, comment: 'Resolved end to end.' },
    });
    expect(rate.statusCode).toBe(200);

    const detail = await h.app.inject({
      method: 'GET', url: `/v1/support/tickets/${ticketId}`, headers: sessionHeaders(persona.sessionToken),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().ticket).toMatchObject({ id: ticketId, status: 'resolved', satisfaction_rating: 5 });
    expect(detail.json().messages.map((message: any) => message.body)).toEqual(expect.arrayContaining([
      'Please help us understand a delayed webhook.',
      'We found the delay and are applying the fix.',
      'Thank you. We can confirm delivery has recovered.',
    ]));
  });
});
