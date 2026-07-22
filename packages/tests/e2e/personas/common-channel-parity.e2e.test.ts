// Native API alternatives must feed the same tenant pipeline for every tier.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nodemailer from 'nodemailer';
import { db } from '@platform/shared';
import { MailPlatformClient } from '@platform/sdk';
import { startHarness, waitForStatus, type Harness } from '../harness.js';
import { PERSONA_TIERS, provisionSendingPersona, type PersonaTier } from './persona-helpers.js';

let h: Harness;
let smtpServer: any;
let smtpPort: number;

const SDK_BASE = 'http://persona.test/v1';

beforeAll(async () => {
  process.env.SMTP_GATEWAY_AUTOSTART = 'false';
  const { buildSmtpServer } = await import('@platform/smtp-gateway');
  smtpServer = buildSmtpServer();
  await new Promise<void>((resolve) => smtpServer.listen(0, '127.0.0.1', resolve));
  smtpPort = smtpServer.server.address().port;
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
  await new Promise<void>((resolve) => smtpServer.close(resolve));
});

function smtpClient(apiKey: string) {
  return nodemailer.createTransport({
    host: '127.0.0.1', port: smtpPort, secure: false, ignoreTLS: true,
    auth: { user: 'apikey', pass: apiKey },
  });
}

function injectFetch(): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const response = await h.app.inject({
      method: (init.method ?? 'GET') as any,
      url: url.pathname + url.search,
      headers: init.headers,
      ...(init.body ? { payload: init.body } : {}),
    });
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      text: async () => response.body,
    } as Response;
  }) as unknown as typeof fetch;
}

describe.each(PERSONA_TIERS)('common channel parity: %s', (tier: PersonaTier) => {
  it('submits authenticated SMTP mail into the tenant delivery pipeline', async () => {
    const persona = await provisionSendingPersona(h.app, tier, 'smtp-channel', [
      'send', 'smtp', 'messages',
    ]);
    const recipient = `${tier}-smtp-${persona.runId}@example.net`;
    const response = await smtpClient(persona.apiKey).sendMail({
      from: `${tier} Operations <operations@${persona.domain}>`,
      to: recipient,
      subject: `${tier} SMTP parity`,
      text: 'Submitted through the SMTP gateway.',
      attachments: [{
        filename: 'status.txt', content: Buffer.from('channel=SMTP'), contentType: 'text/plain',
      }],
    });
    expect(response.response).toContain('250');
    const messageId = response.response.match(/id=(\S+)/)?.[1];
    expect(messageId).toBeTruthy();
    expect(['accepted', 'sent']).toContain(await waitForStatus(messageId!, ['accepted', 'sent']));

    const row = await db.selectFrom('messages').select([
      'customer_id', 'to_address', 'from_name', 'subject', 'tags', 'metadata', 'attachments',
    ]).where('message_id', '=', messageId!).executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      customer_id: persona.customerId,
      to_address: recipient,
      from_name: `${tier} Operations`,
      subject: `${tier} SMTP parity`,
      tags: ['smtp'],
    });
    expect((row.metadata as any)._channel).toBe('smtp');
    expect(row.attachments?.[0]?.filename).toBe('status.txt');
  });

  it('accepts a SendGrid v3 payload and preserves compatibility metadata', async () => {
    const persona = await provisionSendingPersona(h.app, tier, 'sendgrid-channel', ['send', 'messages']);
    const recipient = `${tier}-sendgrid-${persona.runId}@example.net`;
    const response = await h.app.inject({
      method: 'POST', url: '/v3/mail/send',
      headers: { authorization: `Bearer ${persona.apiKey}` },
      payload: {
        personalizations: [{ to: [{ email: recipient }] }],
        from: { email: `notify@${persona.domain}`, name: `${tier} Notifications` },
        subject: `${tier} SendGrid parity`,
        content: [
          { type: 'text/plain', value: 'SendGrid-compatible text.' },
          { type: 'text/html', value: '<p>SendGrid-compatible HTML.</p>' },
        ],
        categories: ['persona', tier],
        custom_args: { tier, channel: 'sendgrid' },
        tracking_settings: { open_tracking: { enable: true }, click_tracking: { enable: false } },
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.body).toBe('');
    const messageId = response.headers['x-message-id'] as string;
    expect(['accepted', 'sent']).toContain(await waitForStatus(messageId, ['accepted', 'sent']));

    const row = await db.selectFrom('messages').select([
      'customer_id', 'to_address', 'from_name', 'tags', 'metadata', 'tracking_opens', 'tracking_clicks',
    ]).where('message_id', '=', messageId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      customer_id: persona.customerId,
      to_address: recipient,
      from_name: `${tier} Notifications`,
      tags: ['persona', tier],
      tracking_opens: true,
      tracking_clicks: false,
    });
    expect(row.metadata).toMatchObject({ tier, channel: 'sendgrid' });
  });

  it('uses the published SDK for template, suppression, and delivery operations', async () => {
    const persona = await provisionSendingPersona(h.app, tier, 'sdk-channel', [
      'send', 'messages', 'templates', 'suppressions',
    ]);
    const client = new MailPlatformClient({
      apiKey: persona.apiKey, baseUrl: SDK_BASE, fetch: injectFetch(),
    });

    const suppressed = `${tier}-sdk-suppressed-${persona.runId}@example.net`;
    await client.suppressions.add(suppressed, 'manual');
    const suppressions = await client.suppressions.list() as { suppressions: Array<{ email: string }> };
    expect(suppressions.suppressions.map((entry) => entry.email)).toContain(suppressed);
    await client.suppressions.remove(suppressed);

    const template = await client.templates.create({
      name: `${tier}-sdk-template-${persona.runId}`,
      subject: 'SDK hello {{name}}',
      html_body: '<p>Hello {{name}}</p>',
    });
    expect((await client.templates.get(template.id)).id).toBe(template.id);

    const recipient = `${tier}-sdk-${persona.runId}@example.net`;
    const send = await client.messages.send({
      from: `sdk@${persona.domain}`, to: recipient,
      template_id: template.id, variables: { name: tier },
    });
    expect(send.accepted).toBe(1);
    expect(['accepted', 'sent']).toContain(await waitForStatus(send.message_ids[0]!, ['accepted', 'sent']));
  });
});
