// Governance, admin visibility, tenant isolation, and safe failure behavior.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resetPoolWarmup,
  seedAdminSession,
  seedVerifiedDomain,
  startHarness,
  waitForStatus,
  type Harness,
} from '../harness.js';
import {
  PERSONA_TIERS,
  passwordLogin,
  provisionSendingPersona,
  registerVerifiedHumanPersona,
  sessionHeaders,
  type PersonaTier,
} from './persona-helpers.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
  await resetPoolWarmup('transactional');
});

afterAll(async () => {
  await h.close();
});

function apiHeaders(token: string, json = false, extra?: Record<string, string>): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(json ? { 'content-type': 'application/json' } : {}),
    ...extra,
  };
}

describe.each(PERSONA_TIERS)('common governance, admin, and resilience: %s', (tier: PersonaTier) => {
  it('governs team membership, SSO, SCIM provisioning, and audit integrity', async () => {
    const persona = await registerVerifiedHumanPersona(h.app, tier, 'governance');
    const memberEmail = `${tier}-developer-${persona.runId}@example.net`;

    const invite = await h.app.inject({
      method: 'POST', url: '/v1/team/invites', headers: sessionHeaders(persona.sessionToken, true),
      payload: { email: memberEmail, role: 'developer' },
    });
    expect(invite.statusCode).toBe(201);
    const accept = await h.app.inject({
      method: 'POST', url: '/v1/team/invites/accept', headers: { 'content-type': 'application/json' },
      payload: {
        token: invite.json()._dev_invite_token,
        name: `${tier} developer`, password: 'Persona-Developer-Password-123!',
      },
    });
    expect(accept.statusCode).toBe(201);
    const developerToken = accept.json().token as string;

    const members = await h.app.inject({
      method: 'GET', url: '/v1/team/members', headers: sessionHeaders(developerToken),
    });
    expect(members.statusCode).toBe(200);
    expect(members.json().members).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: persona.email, role: 'owner' }),
      expect.objectContaining({ email: memberEmail, role: 'developer' }),
    ]));
    const denied = await h.app.inject({
      method: 'POST', url: '/v1/team/scim-tokens', headers: sessionHeaders(developerToken, true),
      payload: { label: 'Developer must not mint this' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe('insufficient_role');

    const enableSso = await h.app.inject({
      method: 'PATCH', url: '/v1/account/settings/sso', headers: sessionHeaders(persona.sessionToken, true),
      payload: { enforced: true },
    });
    expect(enableSso.statusCode).toBe(200);
    const blockedLogin = await passwordLogin(h.app, persona.email, persona.password);
    expect(blockedLogin.statusCode).toBe(403);
    expect(blockedLogin.json().error).toBe('password_login_disabled');
    expect((await h.app.inject({
      method: 'PATCH', url: '/v1/account/settings/sso', headers: sessionHeaders(persona.sessionToken, true),
      payload: { enforced: false },
    })).statusCode).toBe(200);

    const token = await h.app.inject({
      method: 'POST', url: '/v1/team/scim-tokens', headers: sessionHeaders(persona.sessionToken, true),
      payload: { label: `${tier} identity provider` },
    });
    expect(token.statusCode).toBe(201);
    const scimHeaders = apiHeaders(token.json().token, true);
    const scimEmail = `${tier}-scim-${persona.runId}@example.net`;
    const provision = await h.app.inject({
      method: 'POST', url: '/scim/v2/Users', headers: scimHeaders,
      payload: {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: scimEmail, externalId: `idp-${persona.runId}`,
        name: { givenName: tier, familyName: 'SCIM User' }, active: true,
      },
    });
    expect(provision.statusCode).toBe(201);
    expect(provision.json()).toMatchObject({ userName: scimEmail, active: true });
    const scimUserId = provision.json().id as string;

    const directory = await h.app.inject({
      method: 'GET',
      url: `/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${scimEmail}"`)}`,
      headers: apiHeaders(token.json().token),
    });
    expect(directory.statusCode).toBe(200);
    expect(directory.json()).toMatchObject({ totalResults: 1 });

    const deactivate = await h.app.inject({
      method: 'PATCH', url: `/scim/v2/Users/${scimUserId}`, headers: scimHeaders,
      payload: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      },
    });
    expect(deactivate.statusCode).toBe(200);
    expect(deactivate.json().active).toBe(false);

    const audit = await h.app.inject({
      method: 'GET', url: '/v1/account/audit/verify', headers: sessionHeaders(persona.sessionToken),
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).toMatchObject({ chain_key: persona.customerId, ok: true });
  });

  it('makes tenant activity visible to the support admin APIs and fleet overview', async () => {
    const persona = await provisionSendingPersona(h.app, tier, 'admin-visibility', [
      'send', 'messages', 'suppressions',
    ]);
    const recipient = `${tier}-admin-visible-${persona.runId}@example.net`;
    const send = await h.app.inject({
      method: 'POST', url: '/v1/send', headers: apiHeaders(persona.apiKey, true),
      payload: {
        from: `admin-check@${persona.domain}`, to: recipient,
        subject: `${tier} admin visibility`, text: 'This should appear in tenant support detail.',
      },
    });
    expect(send.statusCode).toBe(202);
    const messageId = send.json().message_ids[0] as string;
    expect(['accepted', 'sent']).toContain(await waitForStatus(messageId, ['accepted', 'sent']));
    expect((await h.app.inject({
      method: 'POST', url: '/v1/suppressions', headers: apiHeaders(persona.apiKey, true),
      payload: { email: `${tier}-admin-suppression-${persona.runId}@example.net`, reason: 'manual' },
    })).statusCode).toBe(201);

    const admin = await seedAdminSession('support');
    const adminHeaders = apiHeaders(admin.token);
    const search = await h.app.inject({
      method: 'GET', url: `/admin/customers?q=${encodeURIComponent(persona.email)}`, headers: adminHeaders,
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().customers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: persona.customerId, email: persona.email, tier }),
    ]));

    const detail = await h.app.inject({
      method: 'GET', url: `/admin/customers/${persona.customerId}`, headers: adminHeaders,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().customer).toMatchObject({ id: persona.customerId, tier, status: 'active' });
    expect(detail.json().domains.map((domain: any) => domain.domain)).toContain(persona.domain);
    expect(detail.json().recent_messages.map((message: any) => message.message_id)).toContain(messageId);

    const overview = await h.app.inject({ method: 'GET', url: '/admin/overview', headers: adminHeaders });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().messages_24h.total).toBeGreaterThanOrEqual(1);
    expect(overview.json().customers_by_status.active).toBeGreaterThanOrEqual(1);
    expect(overview.json().suppressions_total).toBeGreaterThanOrEqual(1);

    const timeseries = await h.app.inject({
      method: 'GET', url: '/admin/overview/timeseries?days=7', headers: adminHeaders,
    });
    expect(timeseries.statusCode).toBe(200);
    expect(timeseries.json().series).toHaveLength(7);
  });

  it('isolates parent, child, and unrelated tenants while failing safely under invalid or suspended access', async () => {
    const parent = await provisionSendingPersona(h.app, tier, 'isolation-parent', [
      'send', 'messages', 'subaccounts',
    ]);
    const stranger = await provisionSendingPersona(h.app, tier, 'isolation-stranger', ['send', 'messages']);

    const childCreate = await h.app.inject({
      method: 'POST', url: '/v1/subaccounts', headers: apiHeaders(parent.apiKey, true),
      payload: { name: `${tier} isolated child`, daily_quota: 10, monthly_quota: 100 },
    });
    expect(childCreate.statusCode).toBe(201);
    expect(childCreate.json().subaccount.tier).toBe(tier);
    const childId = childCreate.json().subaccount.id as string;
    const childKeyResponse = await h.app.inject({
      method: 'POST', url: `/v1/subaccounts/${childId}/keys`, headers: apiHeaders(parent.apiKey, true),
      payload: { name: `${tier} child relay`, scopes: ['send', 'messages', 'smtp'] },
    });
    expect(childKeyResponse.statusCode).toBe(201);
    const childKey = childKeyResponse.json().api_key as string;
    expect((await h.app.inject({
      method: 'PATCH', url: '/v1/profile', headers: apiHeaders(childKey, true),
      payload: { physical_address: '200 Child Tenant Way, Test City, CA 94105' },
    })).statusCode).toBe(200);
    const childDomain = await seedVerifiedDomain(childId, `${tier}-child-${parent.runId}.example.com`);

    const childSend = await h.app.inject({
      method: 'POST', url: '/v1/send', headers: apiHeaders(childKey, true),
      payload: {
        from: `child@${childDomain}`, to: `${tier}-child-recipient-${parent.runId}@example.net`,
        subject: 'Child tenant message', text: 'Owned by the child tenant.',
      },
    });
    expect(childSend.statusCode).toBe(202);
    const childMessageId = childSend.json().message_ids[0] as string;

    const crossRead = await h.app.inject({
      method: 'GET', url: `/v1/messages/${childMessageId}`, headers: apiHeaders(stranger.apiKey),
    });
    expect(crossRead.statusCode).toBe(404);

    const childUsingParentDomain = await h.app.inject({
      method: 'POST', url: '/v1/send', headers: apiHeaders(childKey, true),
      payload: {
        from: `blocked@${parent.domain}`, to: 'blocked@example.net',
        subject: 'Cross-tenant sender', text: 'Must be rejected.',
      },
    });
    expect(childUsingParentDomain.statusCode).toBe(403);
    expect(childUsingParentDomain.json().error).toBe('domain_not_registered');

    const invalidDelegation = await h.app.inject({
      method: 'POST', url: '/v1/send',
      headers: apiHeaders(stranger.apiKey, true, { 'x-on-behalf-of': childId }),
      payload: {
        from: `stranger@${stranger.domain}`, to: 'blocked@example.net',
        subject: 'Invalid delegation', text: 'Must be rejected.',
      },
    });
    expect(invalidDelegation.statusCode).toBe(403);
    expect(invalidDelegation.json().error).toBe('invalid_on_behalf_of');

    const limited = await h.app.inject({
      method: 'POST', url: '/v1/account/api-keys', headers: sessionHeaders(parent.sessionToken, true),
      payload: { name: 'Read-only resilience key', key_type: 'secret', scopes: ['messages'] },
    });
    expect(limited.statusCode).toBe(201);
    const scopeDenied = await h.app.inject({
      method: 'POST', url: '/v1/send', headers: apiHeaders(limited.json().api_key, true),
      payload: {
        from: `parent@${parent.domain}`, to: 'blocked@example.net', subject: 'No scope', text: 'No scope.',
      },
    });
    expect(scopeDenied.statusCode).toBe(403);
    expect(scopeDenied.json().error).toBe('insufficient_scope');

    const unsafeAttachment = await h.app.inject({
      method: 'POST', url: '/v1/send', headers: apiHeaders(parent.apiKey, true),
      payload: {
        from: `parent@${parent.domain}`, to: 'blocked@example.net', subject: 'Unsafe attachment', text: 'Blocked.',
        attachments: [{ filename: 'payload.exe', content: Buffer.from('MZ').toString('base64') }],
      },
    });
    expect(unsafeAttachment.statusCode).toBe(422);

    const admin = await seedAdminSession('admin');
    expect((await h.app.inject({
      method: 'POST', url: '/admin/customers/suspend', headers: apiHeaders(admin.token, true),
      payload: { customer_id: parent.customerId, reason: 'Persona resilience check' },
    })).statusCode).toBe(200);
    const suspended = await h.app.inject({
      method: 'POST', url: '/v1/send', headers: apiHeaders(parent.apiKey, true),
      payload: {
        from: `parent@${parent.domain}`, to: 'blocked@example.net', subject: 'Suspended', text: 'Blocked.',
      },
    });
    expect(suspended.statusCode).toBe(403);
    expect((await h.app.inject({
      method: 'POST', url: '/admin/customers/reinstate', headers: apiHeaders(admin.token, true),
      payload: { customer_id: parent.customerId },
    })).statusCode).toBe(200);
  });
});
