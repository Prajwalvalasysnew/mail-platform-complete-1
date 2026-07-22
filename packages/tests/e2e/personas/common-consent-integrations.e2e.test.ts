// Tier-parameterized customer journeys for consent and webhook integrations.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countMessagesTo, resetPoolWarmup, resetQuota, startHarness, type Harness } from '../harness.js';
import {
  PERSONA_TIERS,
  provisionSendingPersona,
  sessionHeaders,
  type PersonaTier,
} from './persona-helpers.js';

let h: Harness;

const PUBLIC_WEBHOOK_URL = 'https://93.184.216.34/persona-hook';

beforeAll(async () => {
  h = await startHarness();
  await resetPoolWarmup('transactional');
});

afterAll(async () => {
  await h.close();
});

function apiHeaders(apiKey: string, json = false): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

describe.each(PERSONA_TIERS)('common consent and integrations: %s', (tier: PersonaTier) => {
  it('manages global consent and enforces suppression during delivery', async () => {
    const persona = await provisionSendingPersona(h.app, tier, 'consent', [
      'send', 'messages', 'suppressions',
    ]);
    await resetQuota(persona.customerId);
    const recipient = `${tier}-consent-${persona.runId}@example.net`;

    const add = await h.app.inject({
      method: 'POST', url: '/v1/suppressions', headers: apiHeaders(persona.apiKey, true),
      payload: { email: recipient, reason: 'manual', notes: 'Persona requested a pause' },
    });
    expect(add.statusCode).toBe(201);

    const list = await h.app.inject({
      method: 'GET', url: '/v1/suppressions?reason=manual', headers: apiHeaders(persona.apiKey),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().suppressions).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: recipient.toLowerCase(), reason: 'manual' }),
    ]));

    const blockedSend = await h.app.inject({
      method: 'POST', url: '/v1/send', headers: apiHeaders(persona.apiKey, true),
      payload: {
        from: `consent@${persona.domain}`, to: recipient,
        subject: 'Consent enforcement check', text: 'This must not be delivered.',
      },
    });
    expect(blockedSend.statusCode).toBe(200);
    expect(blockedSend.json()).toMatchObject({ accepted: 0, message_ids: [] });
    expect(blockedSend.json().suppressed).toContain(recipient);
    expect(await countMessagesTo(persona.customerId, recipient)).toBe(0);

    const csv = await h.app.inject({
      method: 'GET', url: '/v1/suppressions/export?reason=manual', headers: apiHeaders(persona.apiKey),
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain(recipient.toLowerCase());

    const remove = await h.app.inject({
      method: 'DELETE', url: `/v1/suppressions/${encodeURIComponent(recipient)}`,
      headers: apiHeaders(persona.apiKey),
    });
    expect(remove.statusCode).toBe(204);

    const history = await h.app.inject({
      method: 'GET',
      url: `/v1/suppressions/${encodeURIComponent(recipient)}/consent-history`,
      headers: apiHeaders(persona.apiKey),
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().history.length).toBeGreaterThanOrEqual(2);
  });

  it('manages unsubscribe groups and enforces group-specific opt-outs', async () => {
    const persona = await provisionSendingPersona(h.app, tier, 'unsubscribe-group', [
      'send', 'messages', 'suppressions',
    ]);
    await resetQuota(persona.customerId);
    const recipient = `${tier}-newsletter-${persona.runId}@example.net`;

    const create = await h.app.inject({
      method: 'POST', url: '/v1/unsubscribe-groups', headers: apiHeaders(persona.apiKey, true),
      payload: { name: `${tier} product updates`, description: 'Persona E2E group', is_default: true },
    });
    expect(create.statusCode).toBe(201);
    const groupId = create.json().group.id as string;

    const addMember = await h.app.inject({
      method: 'POST', url: `/v1/unsubscribe-groups/${groupId}/members`, headers: apiHeaders(persona.apiKey, true),
      payload: { emails: [recipient] },
    });
    expect(addMember.statusCode).toBe(200);

    const optedOut = await h.app.inject({
      method: 'POST', url: '/v1/send', headers: apiHeaders(persona.apiKey, true),
      payload: {
        from: `updates@${persona.domain}`, to: recipient, subject: 'Product update',
        text: 'Group-specific content', unsubscribe_group_id: groupId,
      },
    });
    expect(optedOut.statusCode).toBe(200);
    expect(optedOut.json().accepted).toBe(0);
    expect(await countMessagesTo(persona.customerId, recipient)).toBe(0);

    const removeMember = await h.app.inject({
      method: 'DELETE',
      url: `/v1/unsubscribe-groups/${groupId}/members/${encodeURIComponent(recipient)}`,
      headers: apiHeaders(persona.apiKey),
    });
    expect(removeMember.statusCode).toBe(204);

    const members = await h.app.inject({
      method: 'GET', url: `/v1/unsubscribe-groups/${groupId}/members`, headers: apiHeaders(persona.apiKey),
    });
    expect(members.statusCode).toBe(200);
    expect(members.json().members).toHaveLength(0);

    const patch = await h.app.inject({
      method: 'PATCH', url: `/v1/unsubscribe-groups/${groupId}`, headers: apiHeaders(persona.apiKey, true),
      payload: { name: `${tier} product news` },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().group.name).toBe(`${tier} product news`);

    const removeGroup = await h.app.inject({
      method: 'DELETE', url: `/v1/unsubscribe-groups/${groupId}`, headers: apiHeaders(persona.apiKey),
    });
    expect(removeGroup.statusCode).toBe(204);
  });

  it('manages API and dashboard webhooks with secret rotation and SSRF protection', async () => {
    const persona = await provisionSendingPersona(h.app, tier, 'webhooks', ['messages', 'webhooks']);

    const create = await h.app.inject({
      method: 'POST', url: '/v1/webhooks', headers: apiHeaders(persona.apiKey, true),
      payload: { url: PUBLIC_WEBHOOK_URL, events: ['delivered', 'hard_bounce'] },
    });
    expect(create.statusCode).toBe(201);
    const webhookId = create.json().id as string;
    const originalSecret = create.json().secret as string;

    const list = await h.app.inject({ method: 'GET', url: '/v1/webhooks', headers: apiHeaders(persona.apiKey) });
    expect(list.statusCode).toBe(200);
    expect(list.json().webhooks).toEqual(expect.arrayContaining([expect.objectContaining({ id: webhookId })]));

    const rotate = await h.app.inject({
      method: 'POST', url: `/v1/webhooks/${webhookId}/rotate-secret`, headers: apiHeaders(persona.apiKey),
    });
    expect(rotate.statusCode).toBe(201);
    expect(rotate.json().secret).not.toBe(originalSecret);

    const deliveries = await h.app.inject({
      method: 'GET', url: `/v1/webhooks/${webhookId}/deliveries`, headers: apiHeaders(persona.apiKey),
    });
    expect(deliveries.statusCode).toBe(200);
    expect(deliveries.json().deliveries).toEqual([]);

    const privateUrl = await h.app.inject({
      method: 'POST', url: '/v1/webhooks', headers: apiHeaders(persona.apiKey, true),
      payload: { url: 'http://127.0.0.1/hook', events: ['delivered'] },
    });
    expect(privateUrl.statusCode).toBe(400);
    expect(privateUrl.json().error).toBe('invalid_webhook_url');

    const dashboardCreate = await h.app.inject({
      method: 'POST', url: '/v1/account/webhooks', headers: sessionHeaders(persona.sessionToken, true),
      payload: { url: `${PUBLIC_WEBHOOK_URL}-dashboard`, events: ['opened'] },
    });
    expect(dashboardCreate.statusCode).toBe(201);
    const dashboardId = dashboardCreate.json().id as string;

    expect((await h.app.inject({
      method: 'DELETE', url: `/v1/account/webhooks/${dashboardId}`,
      headers: sessionHeaders(persona.sessionToken),
    })).statusCode).toBe(200);
    expect((await h.app.inject({
      method: 'DELETE', url: `/v1/webhooks/${webhookId}`, headers: apiHeaders(persona.apiKey),
    })).statusCode).toBe(204);
  });
});
