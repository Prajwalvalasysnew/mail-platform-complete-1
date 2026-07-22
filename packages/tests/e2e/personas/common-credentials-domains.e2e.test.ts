// Common credential and domain management for every current plan.
// These features are scope/capability controlled today, not tier gated.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CapturingPlatformMailer, setPlatformMailer } from '@platform/shared';
import { buildTestApp } from '../harness.js';
import {
  PERSONA_TIERS,
  personaRunId,
  registerVerifiedHumanPersona,
  sessionHeaders,
  type PersonaTier,
} from './persona-helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
  setPlatformMailer(new CapturingPlatformMailer());
});

afterAll(async () => {
  setPlatformMailer(null);
  await app.close();
});

function apiHeaders(apiKey: string, withJsonBody = false): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    ...(withJsonBody ? { 'content-type': 'application/json' } : {}),
  };
}

describe.each(PERSONA_TIERS)('common credentials and domains: %s', (tier: PersonaTier) => {
  it('creates, uses, rotates, and revokes scoped API keys', async () => {
    const persona = await registerVerifiedHumanPersona(app, tier, 'credentials');
    const create = await app.inject({
      method: 'POST',
      url: '/v1/account/api-keys',
      headers: sessionHeaders(persona.sessionToken, true),
      payload: {
        name: `${tier} observability integration`,
        key_type: 'secret',
        scopes: ['messages'],
        expires_in_days: 90,
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({
      key_type: 'secret', scopes: ['messages'], status: 'active',
    });
    expect(create.json().api_key).toMatch(/^mp_live_/);
    const originalKey = create.json().api_key as string;

    const list = await app.inject({
      method: 'GET', url: '/v1/account/api-keys', headers: sessionHeaders(persona.sessionToken),
    });
    expect(list.statusCode).toBe(200);
    const listed = list.json().keys.find((key: { id: string }) => key.id === create.json().id);
    expect(listed).toMatchObject({ name: `${tier} observability integration`, status: 'active' });
    expect(listed.api_key).toBeUndefined();
    expect(listed.key_hash).toBeUndefined();

    const authenticate = await app.inject({
      method: 'GET', url: '/v1/messages?limit=1', headers: apiHeaders(originalKey),
    });
    expect(authenticate.statusCode).toBe(200);

    const deniedSend = await app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: apiHeaders(originalKey, true),
      payload: { from: 'sender@example.com', to: 'recipient@example.net', text: 'scope check' },
    });
    expect(deniedSend.statusCode).toBe(403);
    expect(deniedSend.json().error).toBe('insufficient_scope');

    const rotate = await app.inject({
      method: 'POST',
      url: `/v1/account/api-keys/${create.json().id}/rotate`,
      headers: sessionHeaders(persona.sessionToken),
    });
    expect(rotate.statusCode).toBe(201);
    expect(rotate.json()).toMatchObject({
      rotated_from_id: create.json().id,
      scopes: ['messages'],
      key_type: 'secret',
    });
    expect(rotate.json().api_key).toMatch(/^mp_live_/);
    const replacementKey = rotate.json().api_key as string;

    // Rotation has an overlap window: both credentials work until the old key
    // is explicitly revoked or reaches its shortened expiry.
    for (const key of [originalKey, replacementKey]) {
      expect((await app.inject({
        method: 'GET', url: '/v1/messages?limit=1', headers: apiHeaders(key),
      })).statusCode).toBe(200);
    }

    const revokeOld = await app.inject({
      method: 'DELETE',
      url: `/v1/account/api-keys/${create.json().id}`,
      headers: sessionHeaders(persona.sessionToken),
    });
    expect(revokeOld.statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET', url: '/v1/messages?limit=1', headers: apiHeaders(originalKey),
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'GET', url: '/v1/messages?limit=1', headers: apiHeaders(replacementKey),
    })).statusCode).toBe(200);

    const revokeReplacement = await app.inject({
      method: 'DELETE',
      url: `/v1/account/api-keys/${rotate.json().id}`,
      headers: sessionHeaders(persona.sessionToken),
    });
    expect(revokeReplacement.statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET', url: '/v1/messages?limit=1', headers: apiHeaders(replacementKey),
    })).statusCode).toBe(401);

    const invalidPublishable = await app.inject({
      method: 'POST',
      url: '/v1/account/api-keys',
      headers: sessionHeaders(persona.sessionToken, true),
      payload: { name: 'unsafe browser key', key_type: 'publishable', scopes: ['send'] },
    });
    expect(invalidPublishable.statusCode).toBe(400);
    expect(invalidPublishable.json().error).toBe('publishable_cannot_send');
  });

  it('manages the same tenant domain through dashboard and scoped API surfaces', async () => {
    const persona = await registerVerifiedHumanPersona(app, tier, 'domains');
    const domain = `${personaRunId(`domain-${tier}`)}.example.com`;

    const add = await app.inject({
      method: 'POST',
      url: '/v1/account/domains',
      headers: sessionHeaders(persona.sessionToken, true),
      payload: { domain, dkim_selector: 'persona' },
    });
    expect(add.statusCode).toBe(201);
    expect(add.json()).toMatchObject({ domain, dkim_selector: 'persona' });
    expect(add.json().verification_token).toBeTruthy();
    expect(add.json().dns_records).toHaveLength(5);
    const domainId = add.json().id as string;

    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/account/domains',
      headers: sessionHeaders(persona.sessionToken, true),
      payload: { domain },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: 'domain_exists', domain_id: domainId });

    const detail = await app.inject({
      method: 'GET', url: `/v1/account/domains/${domainId}`, headers: sessionHeaders(persona.sessionToken),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().dns_records).toHaveLength(5);

    const domainKey = await app.inject({
      method: 'POST',
      url: '/v1/account/api-keys',
      headers: sessionHeaders(persona.sessionToken, true),
      payload: { name: `${tier} domain automation`, scopes: ['domains'] },
    });
    expect(domainKey.statusCode).toBe(201);
    const apiList = await app.inject({
      method: 'GET', url: '/v1/domains', headers: apiHeaders(domainKey.json().api_key),
    });
    expect(apiList.statusCode).toBe(200);
    expect(apiList.json().domains).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: domainId, domain }),
    ]));

    // Reserved example.com names have no published platform records, so the
    // real DNS verification path deterministically remains pending.
    const verify = await app.inject({
      method: 'POST',
      url: `/v1/account/domains/${domainId}/verify`,
      headers: sessionHeaders(persona.sessionToken),
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().verified).toBe(false);
    expect(verify.json().results).toEqual(expect.objectContaining({
      ownership: false, spf: false, dkim: false,
    }));

    const remove = await app.inject({
      method: 'DELETE',
      url: `/v1/account/domains/${domainId}`,
      headers: sessionHeaders(persona.sessionToken),
    });
    expect(remove.statusCode).toBe(200);
    expect(remove.json().ok).toBe(true);
    expect((await app.inject({
      method: 'GET', url: `/v1/account/domains/${domainId}`, headers: sessionHeaders(persona.sessionToken),
    })).statusCode).toBe(404);
  });
});
