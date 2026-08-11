// Common content, delivery, scheduling, and observability journeys.
// Each journey runs independently for Free, Paid, and Enterprise because these
// surfaces are scope-controlled under the product's current behavior.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, loadMessageBody } from '@platform/shared';
import {
  countMessagesTo,
  getEventTypes,
  getMessageRow,
  getTrackedLinkUrls,
  getUsageSent,
  resetPoolWarmup,
  resetQuota,
  seedSuppression,
  startHarness,
  waitForStatus,
  type Harness,
} from '../harness.js';
import {
  PERSONA_PLAN,
  PERSONA_TIERS,
  provisionSendingPersona,
  type PersonaTier,
} from './persona-helpers.js';

let h: Harness;
const PDF_B64 = Buffer.from('%PDF-1.4\npersona invoice attachment\n%%EOF').toString('base64');

beforeAll(async () => {
  h = await startHarness();
  await resetPoolWarmup('transactional');
});

afterAll(async () => {
  await h.close();
});

function apiHeaders(apiKey: string, extra?: Record<string, string>): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    ...extra,
  };
}

function apiAuthHeader(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

describe.each(PERSONA_TIERS)('common content and delivery: %s', (tier: PersonaTier) => {
  it('handles successful, suppressed, and invalid entries independently in a batch', async () => {
    const persona = await provisionSendingPersona(h.app, tier, 'batch');
    await resetQuota(persona.customerId);
    const acceptedRecipient = `${tier}-batch-ok-${persona.runId}@example.net`;
    const suppressedRecipient = `${tier}-batch-suppressed-${persona.runId}@example.net`;
    await seedSuppression(persona.customerId, suppressedRecipient, 'unsubscribe');

    const batch = await h.app.inject({
      method: 'POST',
      url: '/v1/send/batch',
      headers: apiHeaders(persona.apiKey),
      payload: {
        messages: [
          {
            from: `batch@${persona.domain}`,
            to: acceptedRecipient,
            subject: 'Accepted batch entry',
            text: 'Allowed.',
          },
          {
            from: `batch@${persona.domain}`,
            to: suppressedRecipient,
            subject: 'Suppressed batch entry',
            text: 'Must not send.',
          },
          {
            from: `batch@${persona.domain}`,
            to: `${tier}-batch-pan-${persona.runId}@example.net`,
            subject: 'Rejected batch entry',
            text: 'Test payment card 4242424242424242 must be rejected.',
          },
        ],
      },
    });
    expect(batch.statusCode).toBe(202);
    expect(batch.json().accepted).toBe(1);
    expect(batch.json().results).toEqual([
      expect.objectContaining({ index: 0, accepted: true, message_id: expect.any(String) }),
      expect.objectContaining({ index: 1, accepted: false, suppressed: true }),
      expect.objectContaining({ index: 2, accepted: false, error: 'card_data_detected' }),
    ]);
    expect(await countMessagesTo(persona.customerId, acceptedRecipient)).toBe(1);
    expect(await countMessagesTo(persona.customerId, suppressedRecipient)).toBe(0);
    const quota = await h.app.inject({
      method: 'GET',
      url: '/v1/usage/quota',
      headers: apiAuthHeader(persona.apiKey),
    });
    expect(quota.statusCode).toBe(200);
    expect(quota.json().daily.used).toBe(1);
    expect(quota.json().monthly.used).toBe(1);
  });

  it('creates and updates a template, then delivers rendered and attachment messages', async () => {
    const persona = await provisionSendingPersona(h.app, tier, 'content');
    await resetQuota(persona.customerId);

    const createTemplate = await h.app.inject({
      method: 'POST',
      url: '/v1/templates',
      headers: apiHeaders(persona.apiKey),
      payload: {
        name: `welcome-${persona.runId}`,
        subject: 'Welcome {{name}}',
        html_body: '<p>Hello {{name}}, your {{plan}} workspace is ready.</p>',
        text_body: 'Hello {{name}}, your {{plan}} workspace is ready.',
      },
    });
    expect(createTemplate.statusCode).toBe(201);
    expect(createTemplate.json().variables).toEqual(['name', 'plan']);
    const templateId = createTemplate.json().id as string;

    const updateTemplate = await h.app.inject({
      method: 'PUT',
      url: `/v1/templates/${templateId}`,
      headers: apiHeaders(persona.apiKey),
      payload: {
        name: `welcome-${persona.runId}`,
        subject: 'Hello {{name}} — {{plan}} is active',
        html_body: '<p>Hello {{name}}. Your {{plan}} account is active.</p>',
        text_body: 'Hello {{name}}. Your {{plan}} account is active.',
      },
    });
    expect(updateTemplate.statusCode).toBe(200);
    expect(updateTemplate.json().variables).toEqual(['name', 'plan']);

    const templateDetail = await h.app.inject({
      method: 'GET', url: `/v1/templates/${templateId}`, headers: apiHeaders(persona.apiKey),
    });
    expect(templateDetail.statusCode).toBe(200);
    expect(templateDetail.json().subject).toContain('{{plan}}');

    const templateRecipient = `${tier}-template-${persona.runId}@example.net`;
    const templateSend = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: apiHeaders(persona.apiKey, { 'idempotency-key': `template-${persona.runId}` }),
      payload: {
        from: `welcome@${persona.domain}`,
        to: templateRecipient,
        template_id: templateId,
        variables: { name: 'Asha', plan: tier },
        tags: ['persona', tier, 'template'],
      },
    });
    expect(templateSend.statusCode).toBe(202);

    const attachmentRecipients = [
      `${tier}-finance-${persona.runId}@example.net`,
      `${tier}-buyer-${persona.runId}@example.net`,
    ];
    const attachmentSend = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: apiHeaders(persona.apiKey, { 'idempotency-key': `attachment-${persona.runId}` }),
      payload: {
        from: `billing@${persona.domain}`,
        to: attachmentRecipients,
        subject: `${tier} invoice available`,
        html: '<p>View the <a href="https://example.com/invoices/1001">invoice online</a>.</p>',
        text: 'Your invoice is attached.',
        tags: ['persona', tier, 'invoice'],
        tracking: { opens: true, clicks: true },
        attachments: [{ filename: 'invoice-1001.pdf', content: PDF_B64 }],
      },
    });
    expect(attachmentSend.statusCode).toBe(202);
    expect(attachmentSend.json().accepted).toBe(2);

    const templateMessageId = templateSend.json().message_ids[0] as string;
    const attachmentMessageIds = attachmentSend.json().message_ids as string[];
    for (const messageId of [templateMessageId, ...attachmentMessageIds]) {
      expect(['accepted', 'sent']).toContain(await waitForStatus(messageId, ['accepted', 'sent']));
      expect(await getEventTypes(messageId)).toEqual(expect.arrayContaining(['queued', 'sent']));
    }

    const rendered = await getMessageRow(templateMessageId);
    expect(rendered).toMatchObject({
      customer_id: persona.customerId,
      to_address: templateRecipient,
      subject: `Hello Asha — ${tier} is active`,
      template_id: templateId,
    });
    expect(rendered?.html_body).toContain(`Your ${tier} account is active`);

    const attachmentRow = await db.selectFrom('messages').selectAll()
      .where('message_id', '=', attachmentMessageIds[0]!).executeTakeFirstOrThrow();
    expect(attachmentRow.attachments).toEqual([
      expect.objectContaining({ filename: 'invoice-1001.pdf', content_type: 'application/pdf' }),
    ]);
    const loaded = await loadMessageBody(attachmentRow);
    expect(Buffer.from(loaded.attachments![0]!.content_b64, 'base64').toString()).toContain('persona invoice');
    expect(await getTrackedLinkUrls(attachmentMessageIds[0]!)).toContain('https://example.com/invoices/1001');

    const attachmentDetail = await h.app.inject({
      method: 'GET',
      url: `/v1/messages/${encodeURIComponent(attachmentMessageIds[0]!)}`,
      headers: apiHeaders(persona.apiKey),
    });
    expect(attachmentDetail.statusCode).toBe(200);
    expect(attachmentDetail.json().message.attachments).toEqual([
      expect.objectContaining({ filename: 'invoice-1001.pdf', content_type: 'application/pdf' }),
    ]);
    expect(JSON.stringify(attachmentDetail.json())).not.toContain(PDF_B64);

    const removeTemplate = await h.app.inject({
      method: 'DELETE', url: `/v1/templates/${templateId}`, headers: apiAuthHeader(persona.apiKey),
    });
    expect(removeTemplate.statusCode).toBe(204);
    expect((await h.app.inject({
      method: 'GET', url: `/v1/templates/${templateId}`, headers: apiHeaders(persona.apiKey),
    })).statusCode).toBe(404);
    expect(await getUsageSent(persona.customerId)).toBe(3);
  });

  it('schedules and cancels one message while making retries safely idempotent', async () => {
    const persona = await provisionSendingPersona(h.app, tier, 'schedule-idempotency');
    await resetQuota(persona.customerId);
    const sendAt = new Date(Date.now() + 60 * 60_000).toISOString();

    const scheduled = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: apiHeaders(persona.apiKey, { 'idempotency-key': `scheduled-${persona.runId}` }),
      payload: {
        from: `operations@${persona.domain}`,
        to: `${tier}-scheduled-${persona.runId}@example.net`,
        subject: 'Scheduled maintenance reminder',
        text: 'Maintenance begins in one hour.',
        send_at: sendAt,
        tags: ['persona', tier, 'scheduled'],
      },
    });
    expect(scheduled.statusCode).toBe(202);
    const scheduledMessageId = scheduled.json().message_ids[0] as string;

    const scheduledList = await h.app.inject({
      method: 'GET', url: '/v1/messages/scheduled', headers: apiHeaders(persona.apiKey),
    });
    expect(scheduledList.statusCode).toBe(200);
    expect(scheduledList.json().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ message_id: scheduledMessageId, subject: 'Scheduled maintenance reminder' }),
    ]));

    const cancel = await h.app.inject({
      method: 'DELETE',
      url: `/v1/messages/${encodeURIComponent(scheduledMessageId)}/cancel`,
      headers: apiAuthHeader(persona.apiKey),
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().cancelled).toBe(scheduledMessageId);
    const cancelledDetail = await h.app.inject({
      method: 'GET',
      url: `/v1/messages/${encodeURIComponent(scheduledMessageId)}`,
      headers: apiHeaders(persona.apiKey),
    });
    expect(cancelledDetail.statusCode).toBe(200);
    expect(cancelledDetail.json().message).toMatchObject({
      status: 'failed', failure_reason: 'cancelled_by_user',
    });

    const recipient = `${tier}-idempotent-${persona.runId}@example.net`;
    const idempotencyKey = `immediate-${persona.runId}`;
    const payload = {
      from: `operations@${persona.domain}`,
      to: recipient,
      subject: 'Exactly-once operational message',
      text: 'This message must be persisted once.',
      tags: ['persona', tier, 'idempotent'],
    };
    const first = await h.app.inject({
      method: 'POST', url: '/v1/send', headers: apiHeaders(persona.apiKey, { 'idempotency-key': idempotencyKey }), payload,
    });
    const retry = await h.app.inject({
      method: 'POST', url: '/v1/send', headers: apiHeaders(persona.apiKey, { 'idempotency-key': idempotencyKey }), payload,
    });
    expect(first.statusCode).toBe(202);
    expect(retry.statusCode).toBe(202);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    expect(await countMessagesTo(persona.customerId, recipient)).toBe(1);

    const conflict = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: apiHeaders(persona.apiKey, { 'idempotency-key': idempotencyKey }),
      payload: { ...payload, subject: 'A different request body' },
    });
    expect(conflict.statusCode).toBe(422);
    expect(conflict.json().error).toBe('idempotency_key_reused');

    const immediateMessageId = first.json().message_ids[0] as string;
    expect(['accepted', 'sent']).toContain(await waitForStatus(immediateMessageId, ['accepted', 'sent']));
    expect(await getUsageSent(persona.customerId)).toBe(1);

    // Cancellation must release its quota reservation. Only the one delivered
    // immediate message should remain charged.
    const quota = await h.app.inject({
      method: 'GET', url: '/v1/usage/quota', headers: apiHeaders(persona.apiKey),
    });
    expect(quota.statusCode).toBe(200);
    expect(quota.json().daily.used).toBe(1);
    expect(quota.json().monthly.used).toBe(1);
  });

  it('exposes tenant-scoped message, event, usage, stats, and analytics views', async () => {
    const persona = await provisionSendingPersona(h.app, tier, 'observability');
    await resetQuota(persona.customerId);
    const recipients = [
      `${tier}-observer-a-${persona.runId}@example.net`,
      `${tier}-observer-b-${persona.runId}@example.net`,
    ];
    const send = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: apiHeaders(persona.apiKey, { 'idempotency-key': `observability-${persona.runId}` }),
      payload: {
        from: `metrics@${persona.domain}`,
        to: recipients,
        subject: `${tier} observability message`,
        text: 'This delivery powers the customer analytics views.',
        tags: ['persona-observability', tier],
      },
    });
    expect(send.statusCode).toBe(202);
    expect(send.json().message_ids).toHaveLength(2);
    const messageIds = send.json().message_ids as string[];
    for (const messageId of messageIds) {
      expect(['accepted', 'sent']).toContain(await waitForStatus(messageId, ['accepted', 'sent']));
    }

    const messages = await h.app.inject({
      method: 'GET',
      url: `/v1/messages?tag=persona-observability&subject_contains=${tier}%20observability`,
      headers: apiHeaders(persona.apiKey),
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().messages.map((message: { message_id: string }) => message.message_id))
      .toEqual(expect.arrayContaining(messageIds));

    const detail = await h.app.inject({
      method: 'GET', url: `/v1/messages/${encodeURIComponent(messageIds[0]!)}`, headers: apiHeaders(persona.apiKey),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().message).toMatchObject({
      customer_id: persona.customerId,
      to_address: recipients[0],
      subject: `${tier} observability message`,
    });
    expect(detail.json().events.map((event: { event_type: string }) => event.event_type))
      .toEqual(expect.arrayContaining(['queued', 'sent']));

    const activity = await h.app.inject({
      method: 'GET',
      url: `/v1/messages/activity?message_id=${encodeURIComponent(messageIds[0]!)}&limit=20`,
      headers: apiHeaders(persona.apiKey),
    });
    expect(activity.statusCode).toBe(200);
    expect(activity.json().events.length).toBeGreaterThanOrEqual(2);
    expect(activity.json().events.every((event: { message_id: string }) => event.message_id === messageIds[0])).toBe(true);

    const plan = PERSONA_PLAN[tier];
    const quota = await h.app.inject({
      method: 'GET', url: '/v1/usage/quota', headers: apiHeaders(persona.apiKey),
    });
    expect(quota.statusCode).toBe(200);
    expect(quota.json()).toMatchObject({
      daily: { used: 2, limit: plan.daily, remaining: plan.daily - 2 },
      monthly: { used: 2, limit: plan.monthly, remaining: plan.monthly - 2 },
    });

    const usage = await h.app.inject({
      method: 'GET', url: '/v1/usage?days=7', headers: apiHeaders(persona.apiKey),
    });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().totals.sent).toBe(2);

    const stats = await h.app.inject({
      method: 'GET', url: '/v1/stats?days=7', headers: apiHeaders(persona.apiKey),
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().stats).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: 'queued' }),
      expect.objectContaining({ event_type: 'sent' }),
    ]));

    const summary = await h.app.inject({
      method: 'GET', url: '/v1/analytics/summary?period=24h', headers: apiHeaders(persona.apiKey),
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({ period: '24h', sent: 2 });

    const timeseries = await h.app.inject({
      method: 'GET', url: '/v1/analytics/timeseries?period=7d&granularity=day', headers: apiHeaders(persona.apiKey),
    });
    expect(timeseries.statusCode).toBe(200);
    expect(timeseries.json().series.reduce((sum: number, point: { sent: number }) => sum + point.sent, 0)).toBe(2);

    const breakdown = await h.app.inject({
      method: 'GET', url: '/v1/analytics/breakdown?by=tag&period=24h', headers: apiHeaders(persona.apiKey),
    });
    expect(breakdown.statusCode).toBe(200);
    expect(breakdown.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'persona-observability', sent: 2 }),
    ]));
  });
});
