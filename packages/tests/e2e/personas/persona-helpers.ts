import type { FastifyInstance } from 'fastify';
import { applySubscriptionState, db, seedVerifiedDomain } from '@platform/shared';

export const PERSONA_TIERS = ['free', 'paid', 'enterprise'] as const;
export type PersonaTier = (typeof PERSONA_TIERS)[number];

export const PERSONA_PLAN = {
  free: { priceId: 'price_free', plan: 'free', daily: 100, monthly: 3_000 },
  paid: { priceId: 'price_pro', plan: 'pro', daily: 50_000, monthly: 1_000_000 },
  enterprise: { priceId: 'price_enterprise', plan: 'enterprise', daily: 1_000_000, monthly: 50_000_000 },
} as const;

export interface HumanPersona {
  tier: PersonaTier;
  runId: string;
  email: string;
  password: string;
  customerId: string;
  userId: string;
  sessionToken: string;
}

export interface SendingPersona extends HumanPersona {
  apiKeyId: string;
  apiKey: string;
  domain: string;
}

export function personaRunId(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sessionHeaders(token: string, withJsonBody = false): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(withJsonBody ? { 'content-type': 'application/json' } : {}),
  };
}

export async function activatePersonaTier(customerId: string, tier: PersonaTier, runId: string): Promise<void> {
  if (tier === 'free') return;
  const plan = PERSONA_PLAN[tier];
  const applied = await applySubscriptionState({
    provider: 'stripe',
    provider_event_id: `evt_persona_fixture_${runId}`,
    type: 'customer.subscription.updated',
    internal_customer_id: customerId,
    provider_subscription_id: `sub_persona_fixture_${runId}`,
    plan_item_id: `si_persona_fixture_${runId}`,
    price_id: plan.priceId,
    status: 'active',
  });
  if (!applied) throw new Error(`Persona tier event was unexpectedly deduplicated: ${runId}`);
}

export async function registerVerifiedHumanPersona(
  app: FastifyInstance,
  tier: PersonaTier,
  label: string,
): Promise<HumanPersona> {
  const runId = personaRunId(`${label}-${tier}`);
  const email = `${runId}@persona.example.com`;
  const password = 'Persona-Initial-Password-123!';
  const registration = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: {
      email,
      password,
      name: `${tier} persona owner`,
      org_name: `${tier} persona organization`,
    },
  });
  if (registration.statusCode !== 201) {
    throw new Error(`Persona registration failed (${registration.statusCode}): ${registration.body}`);
  }
  const body = registration.json();
  const verification = await app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    headers: { 'content-type': 'application/json' },
    payload: { token: body._dev_email_verify_token },
  });
  if (verification.statusCode !== 200) {
    throw new Error(`Persona verification failed (${verification.statusCode}): ${verification.body}`);
  }

  await activatePersonaTier(body.customer_id, tier, runId);
  const user = await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirstOrThrow();
  return {
    tier,
    runId,
    email,
    password,
    customerId: body.customer_id,
    userId: user.id,
    sessionToken: body.token,
  };
}

export async function passwordLogin(
  app: FastifyInstance,
  email: string,
  password: string,
  userAgent?: string,
) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: {
      'content-type': 'application/json',
      ...(userAgent ? { 'user-agent': userAgent } : {}),
    },
    payload: { email, password },
  });
}

export async function provisionSendingPersona(
  app: FastifyInstance,
  tier: PersonaTier,
  label: string,
  scopes: string[] = ['send', 'messages', 'domains', 'templates'],
): Promise<SendingPersona> {
  const persona = await registerVerifiedHumanPersona(app, tier, label);
  const key = await app.inject({
    method: 'POST',
    url: '/v1/account/api-keys',
    headers: sessionHeaders(persona.sessionToken, true),
    payload: { name: `${tier} ${label} integration`.slice(0, 100), key_type: 'secret', scopes },
  });
  if (key.statusCode !== 201) {
    throw new Error(`Persona API-key creation failed (${key.statusCode}): ${key.body}`);
  }
  const profile = await app.inject({
    method: 'PATCH',
    url: '/v1/profile',
    headers: { authorization: `Bearer ${key.json().api_key}`, 'content-type': 'application/json' },
    payload: { physical_address: '100 Persona Test Way, Test City, CA 94105' },
  });
  if (profile.statusCode !== 200) {
    throw new Error(`Persona compliance profile failed (${profile.statusCode}): ${profile.body}`);
  }
  const domain = await seedVerifiedDomain(persona.customerId, `${persona.runId}.example.com`);
  return {
    ...persona,
    apiKeyId: key.json().id,
    apiKey: key.json().api_key,
    domain,
  };
}
