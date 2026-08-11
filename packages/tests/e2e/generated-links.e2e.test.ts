// Generated-artifact E2E: use the exact URLs emitted by the send worker, then
// drive the tracker. This guards against route/token/encoding drift that tests
// using independently reconstructed URLs cannot detect.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  db,
  isSuppressed,
} from '@platform/shared';
import {
  startHarness,
  loadTrackerApp,
  seedCustomer,
  seedVerifiedDomain,
  waitForStatus,
  type Harness,
} from './harness.js';

let h: Harness;
let tracker: FastifyInstance | undefined;
const previousTransport = process.env.DELIVERY_TRANSPORT;
const previousMailpitHost = process.env.MAILPIT_SMTP_HOST;
const previousMailpitPort = process.env.MAILPIT_SMTP_PORT;
const mailpitApi = process.env.MAILPIT_API_URL ?? 'http://127.0.0.1:8026';

async function waitForMailpitMessage(recipient: string, timeoutMs = 8_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${mailpitApi}/api/v1/messages?limit=100`);
    if (!response.ok) throw new Error(`Mailpit messages API returned ${response.status}`);
    const mailbox = await response.json() as any;
    const summary = mailbox.messages?.find((message: any) =>
      message.To?.some((address: any) => String(address.Address ?? address).toLowerCase() === recipient.toLowerCase())
    );
    if (summary) {
      const detail = await fetch(`${mailpitApi}/api/v1/message/${encodeURIComponent(summary.ID)}`);
      if (!detail.ok) throw new Error(`Mailpit message API returned ${detail.status}`);
      return detail.json();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Mailpit did not receive a message for ${recipient}`);
}

beforeAll(async () => {
  process.env.DELIVERY_TRANSPORT = 'mailpit';
  process.env.MAILPIT_SMTP_HOST = previousMailpitHost ?? '127.0.0.1';
  process.env.MAILPIT_SMTP_PORT = previousMailpitPort ?? '1026';
  tracker = await loadTrackerApp();
  await tracker.ready();
  h = await startHarness();
});

afterAll(async () => {
  await h?.close();
  await tracker?.close();
  if (previousTransport === undefined) delete process.env.DELIVERY_TRANSPORT;
  else process.env.DELIVERY_TRANSPORT = previousTransport;
  if (previousMailpitHost === undefined) delete process.env.MAILPIT_SMTP_HOST;
  else process.env.MAILPIT_SMTP_HOST = previousMailpitHost;
  if (previousMailpitPort === undefined) delete process.env.MAILPIT_SMTP_PORT;
  else process.env.MAILPIT_SMTP_PORT = previousMailpitPort;
});

describe('worker-generated tracking and unsubscribe artifacts', () => {
  it('delivers, redirects the generated click URL, and enforces the generated unsubscribe URL', async () => {
    const tenant = await seedCustomer({ keyType: 'secret', scopes: ['send', 'messages'] });
    const domain = await seedVerifiedDomain(tenant.customerId);
    const recipient = `artifact-${Date.now()}@example.com`;
    await db.updateTable('customers')
      .set({
        physical_address: '1 Release Gate Way, Test City',
        email_verified_at: new Date(),
      })
      .where('id', '=', tenant.customerId)
      .execute();

    const sent = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: { authorization: `Bearer ${tenant.apiKey}`, 'content-type': 'application/json' },
      payload: {
        from: `sender@${domain}`,
        to: recipient,
        subject: 'Generated artifact release gate',
        html: '<p><a href="https://example.com/product?from=email">View product</a></p>',
        text: 'View product: https://example.com/product?from=email',
        tracking: { opens: true, clicks: true },
      },
    });
    expect(sent.statusCode).toBe(202);
    const messageId = sent.json().message_ids[0] as string;
    await waitForStatus(messageId, ['accepted']);

    const captured = await waitForMailpitMessage(recipient);
    const listUnsubscribe = String(captured.ListUnsubscribe?.Header ?? '');
    const unsubscribeUrl = captured.ListUnsubscribe?.Links?.find((link: string) => link.includes('/u/'))
      ?? listUnsubscribe.match(/<([^>]+\/u\/[^>]+)>/)?.[1];
    expect(unsubscribeUrl).toBeTruthy();
    expect(captured.HTML).toContain(unsubscribeUrl);
    expect(captured.Text).toContain(unsubscribeUrl);

    const clickUrl = captured.HTML?.match(/href="([^"]+\/c\/[^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
    expect(clickUrl).toBeTruthy();
    const click = new URL(clickUrl!);
    const clickResponse = await tracker.inject({
      method: 'GET',
      url: `${click.pathname}${click.search}`,
      headers: { 'user-agent': 'release-gate-browser/1.0' },
    });
    expect(clickResponse.statusCode).toBe(302);
    expect(clickResponse.headers.location).toBe('https://example.com/product?from=email');

    const unsubscribe = new URL(unsubscribeUrl!);
    const page = await tracker.inject({ method: 'GET', url: `${unsubscribe.pathname}${unsubscribe.search}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(recipient);
    const oneClick = await tracker.inject({
      method: 'POST',
      url: `${unsubscribe.pathname}${unsubscribe.search}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(oneClick.statusCode).toBe(200);
    expect(await isSuppressed(tenant.customerId, recipient)).toBe(true);

    const blocked = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: { authorization: `Bearer ${tenant.apiKey}`, 'content-type': 'application/json' },
      payload: {
        from: `sender@${domain}`,
        to: recipient,
        subject: 'Must remain suppressed',
        text: 'This must not be admitted.',
      },
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json()).toMatchObject({ accepted: 0, suppressed: [recipient] });
  });
});
