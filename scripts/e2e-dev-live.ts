// Additive end-to-end validation against the running development stack.
// Refuses non-local/test targets and never deletes existing development data.

import 'dotenv/config';
import {
  applySubscriptionState,
  closeDb,
  closeQueues,
  closeRedis,
  db,
} from '../packages/shared/src/index.js';

const apiBase = process.env.DEV_REPLAY_API_BASE ?? 'http://localhost:3000';
const mailpitBase = process.env.DEV_REPLAY_MAILPIT_BASE ?? 'http://localhost:8025';
const databaseUrl = process.env.DATABASE_URL ?? '';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertSafeTarget() {
  assert(process.env.DEV_REPLAY_CONFIRM === '1', 'Set DEV_REPLAY_CONFIRM=1 to run live development E2E.');
  const api = new URL(apiBase);
  const database = new URL(databaseUrl);
  const local = ['localhost', '127.0.0.1', '::1'];
  assert(local.includes(api.hostname), `Refusing non-local API target: ${api.hostname}`);
  assert(local.includes(database.hostname), `Refusing non-local database target: ${database.hostname}`);
  assert(database.port !== '5434' && !/test/i.test(database.pathname), 'Refusing isolated test database');
}

type ApiResult = { status: number; body: any };

async function call(path: string, init: RequestInit = {}, expected: number | number[] = 200): Promise<ApiResult> {
  const response = await fetch(`${apiBase}${path}`, init);
  const text = await response.text();
  let body: any = {};
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(response.status)) {
    throw new Error(`${init.method ?? 'GET'} ${path}: expected ${allowed.join('/')}, got ${response.status}: ${text}`);
  }
  return { status: response.status, body };
}

function headers(token?: string, extra: Record<string, string> = {}) {
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function activateTier(customerId: string, tier: 'paid' | 'enterprise', runId: string) {
  const priceId = tier === 'paid' ? 'price_pro' : 'price_enterprise';
  await applySubscriptionState({
    provider: 'stripe',
    provider_event_id: `evt_live_e2e_${tier}_${runId}`,
    type: 'customer.subscription.updated',
    internal_customer_id: customerId,
    provider_subscription_id: `sub_live_e2e_${tier}_${runId}`,
    plan_item_id: `si_live_e2e_${tier}_${runId}`,
    price_id: priceId,
    status: 'active',
  });
}

async function seedDomain(customerId: string, domain: string) {
  await db.insertInto('sending_domains').values({
    customer_id: customerId,
    domain,
    dkim_selector: 'mail',
    dkim_public_key: 'live-e2e-public-key',
    dkim_private_key: 'live-e2e-private-key',
    verified_at: new Date(),
    dkim_verified: true,
    spf_verified: true,
    dmarc_verified: true,
  } as any).execute();
}

async function waitForMailpit(subjects: string[], timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${mailpitBase}/api/v1/messages?limit=100`);
    assert(response.ok, `Mailpit list failed: ${response.status}`);
    const mailbox = await response.json() as any;
    const present = new Set(mailbox.messages.map((message: any) => String(message.Subject)));
    if (subjects.every((subject) => present.has(subject))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Mailpit subjects: ${subjects.join(', ')}`);
}

async function runPersona(tier: 'free' | 'paid' | 'enterprise', runId: string) {
  const steps: string[] = [];
  const email = `live-e2e-${tier}-${runId}@local.test`;
  const password = 'Live-E2E-Password-123!';

  const registered = await call('/v1/auth/register', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ email, password, name: `${tier} live E2E owner`, org_name: `Live E2E ${tier}` }),
  }, 201);
  const session = registered.body.token as string;
  const customerId = registered.body.customer_id as string;
  steps.push('register');

  await call('/v1/auth/verify-email', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ token: registered.body._dev_email_verify_token }),
  });
  const me = await call('/v1/auth/me', { headers: headers(session) });
  assert(me.body.user.email === email, `${tier}: auth/me returned wrong user`);
  const sessions = await call('/v1/auth/sessions', { headers: headers(session) });
  assert(sessions.body.sessions.length >= 1, `${tier}: no active session`);
  steps.push('verify-and-session');

  if (tier !== 'free') await activateTier(customerId, tier, runId);

  const keyResult = await call('/v1/account/api-keys', {
    method: 'POST', headers: headers(session),
    body: JSON.stringify({
      name: `${tier} live E2E key`,
      key_type: 'secret',
      scopes: ['send', 'messages', 'domains', 'templates', 'suppressions', 'webhooks', 'workflows', 'subaccounts'],
    }),
  }, 201);
  const apiKey = keyResult.body.api_key as string;
  assert(apiKey.startsWith('mp_live_'), `${tier}: live API key not returned`);
  const keyList = await call('/v1/account/api-keys', { headers: headers(session) });
  assert(keyList.body.keys.some((row: any) => row.id === keyResult.body.id), `${tier}: API key absent from list`);
  steps.push('scoped-key');

  await call('/v1/profile', {
    method: 'PATCH', headers: headers(apiKey),
    body: JSON.stringify({ physical_address: '100 Live E2E Way, Test City, CA 94105' }),
  });
  const expectedQuota = tier === 'free' ? 100 : tier === 'paid' ? 50_000 : 1_000_000;
  const profile = await call('/v1/profile', { headers: headers(apiKey) });
  assert(profile.body.customer.tier === tier, `${tier}: wrong tier`);
  assert(profile.body.customer.daily_quota === expectedQuota, `${tier}: wrong daily quota`);

  const domain = `${tier}-${runId}.live-e2e.test`;
  await seedDomain(customerId, domain);
  const domains = await call('/v1/domains', { headers: headers(apiKey) });
  assert(domains.body.domains.some((row: any) => row.domain === domain), `${tier}: seeded domain not visible`);
  steps.push('profile-domain');

  const template = await call('/v1/templates', {
    method: 'POST', headers: headers(apiKey),
    body: JSON.stringify({
      name: `live-e2e-${runId}`,
      subject: `Hello {{name}} ${tier}`,
      html_body: '<p>Welcome {{name}}</p>',
    }),
  }, 201);
  assert(template.body.variables.includes('name'), `${tier}: template variables missing`);
  await call(`/v1/templates/${template.body.id}`, {
    method: 'PUT', headers: headers(apiKey),
    body: JSON.stringify({
      name: `live-e2e-${runId}`,
      subject: `Updated {{name}} ${tier}`,
      text_body: 'Updated {{name}}',
    }),
  });
  await call(`/v1/templates/${template.body.id}`, { headers: headers(apiKey) });
  steps.push('template-crud');

  const suppressed = `suppressed-${tier}-${runId}@example.net`;
  await call('/v1/suppressions', {
    method: 'POST', headers: headers(apiKey),
    body: JSON.stringify({ email: suppressed, reason: 'manual', notes: 'live E2E' }),
  }, 201);
  const suppressions = await call('/v1/suppressions', { headers: headers(apiKey) });
  assert(suppressions.body.suppressions.some((row: any) => row.email === suppressed), `${tier}: suppression absent`);
  const consent = await call(`/v1/suppressions/${encodeURIComponent(suppressed)}/consent-history`, {
    headers: headers(apiKey),
  });
  assert(consent.body.history.length >= 1, `${tier}: consent history absent`);
  await call(`/v1/suppressions/${encodeURIComponent(suppressed)}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${apiKey}` },
  }, 204);
  steps.push('suppression-consent');

  const processing = await call('/v1/privacy/processing-record', { headers: headers(apiKey) });
  assert(Array.isArray(processing.body.security_measures), `${tier}: processing record measures absent`);
  steps.push('processing-record');

  const ticket = await call('/v1/support/tickets', {
    method: 'POST', headers: headers(session),
    body: JSON.stringify({
      subject: `${tier} live E2E support`,
      body: 'Validate the complete customer support path.',
      priority: 'normal',
      category: 'technical',
    }),
  }, 201);
  await call(`/v1/support/tickets/${ticket.body.ticket.id}/messages`, {
    method: 'POST', headers: headers(session),
    body: JSON.stringify({ body: 'Additional live E2E context.' }),
  }, 201);
  await call(`/v1/support/tickets/${ticket.body.ticket.id}`, { headers: headers(session) });
  steps.push('support');

  const welcomeSubject = `[LIVE E2E ${runId}] ${tier.toUpperCase()} welcome`;
  const invoiceSubject = `[LIVE E2E ${runId}] ${tier.toUpperCase()} invoice`;
  const sendPayload = {
    from: `welcome@${domain}`,
    to: `welcome-${tier}-${runId}@example.net`,
    subject: welcomeSubject,
    html: `<p>${tier} live E2E</p>`,
    tags: ['live-e2e', tier],
  };
  const idempotencyKey = `live-e2e-${tier}-${runId}`;
  const sent = await call('/v1/send', {
    method: 'POST', headers: headers(apiKey, { 'idempotency-key': idempotencyKey }),
    body: JSON.stringify(sendPayload),
  }, 202);
  const retried = await call('/v1/send', {
    method: 'POST', headers: headers(apiKey, { 'idempotency-key': idempotencyKey }),
    body: JSON.stringify(sendPayload),
  }, 202);
  assert(
    JSON.stringify(sent.body.message_ids) === JSON.stringify(retried.body.message_ids),
    `${tier}: idempotency returned different message IDs: first=${JSON.stringify(sent.body)} retry=${JSON.stringify(retried.body)}`,
  );

  const invoice = await call('/v1/send', {
    method: 'POST', headers: headers(apiKey),
    body: JSON.stringify({
      from: `billing@${domain}`,
      to: `invoice-${tier}-${runId}@example.net`,
      subject: invoiceSubject,
      text: `${tier} invoice`,
      attachments: [{
        filename: `${tier}-live-e2e.txt`,
        content_type: 'text/plain',
        content: Buffer.from(`${tier} live E2E attachment`).toString('base64'),
      }],
    }),
  }, 202);
  await waitForMailpit([welcomeSubject, invoiceSubject]);

  const messages = await call('/v1/messages?limit=20', { headers: headers(apiKey) });
  assert(messages.body.messages.some((row: any) => row.message_id === sent.body.message_ids[0]), `${tier}: message not listed`);
  await call(`/v1/messages/${encodeURIComponent(invoice.body.message_ids[0])}`, { headers: headers(apiKey) });
  const quota = await call('/v1/usage/quota', { headers: headers(apiKey) });
  assert(quota.body.daily.used >= 2, `${tier}: usage did not advance`);
  steps.push('idempotent-send-worker-mailpit-usage');

  if (tier === 'free') {
    const overQuota = await call('/v1/send', {
      method: 'POST', headers: headers(apiKey),
      body: JSON.stringify({
        ...sendPayload,
        subject: `${welcomeSubject} quota rejection`,
        to: Array.from({ length: 100 }, (_, index) => `quota-${runId}-${index}@example.net`),
      }),
    }, 429);
    assert(overQuota.body.error === 'quota_exceeded', 'free: quota rejection returned wrong error');
    steps.push('free-quota-boundary');
  }

  if (tier === 'enterprise') {
    const developerEmail = `live-e2e-developer-${runId}@local.test`;
    const invite = await call('/v1/team/invites', {
      method: 'POST', headers: headers(session),
      body: JSON.stringify({ email: developerEmail, role: 'developer' }),
    }, 201);
    const accepted = await call('/v1/team/invites/accept', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({
        token: invite.body._dev_invite_token,
        name: 'Live E2E Developer',
        password: 'Live-E2E-Developer-123!',
      }),
    }, 201);
    const members = await call('/v1/team/members', { headers: headers(accepted.body.token) });
    assert(members.body.members.some((row: any) => row.email === developerEmail), 'enterprise: invited member absent');
    const blockedBilling = await call('/v1/account/billing', { headers: headers(accepted.body.token) }, 403);
    assert(blockedBilling.body.error === 'insufficient_role', 'enterprise: developer billing was not blocked');

    const sso = await call('/v1/account/settings/sso', {
      method: 'PATCH', headers: headers(session),
      body: JSON.stringify({ enforced: true }),
    });
    assert(sso.body.sso_enforced === true, 'enterprise: SSO was not enabled');
    const scim = await call('/v1/team/scim-tokens', {
      method: 'POST', headers: headers(session),
      body: JSON.stringify({ label: `Live E2E ${runId}` }),
    }, 201);
    assert(Boolean(scim.body.token), 'enterprise: SCIM token absent');

    const child = await call('/v1/subaccounts', {
      method: 'POST', headers: headers(apiKey),
      body: JSON.stringify({ name: `Live E2E child ${runId}`, daily_quota: 1000, monthly_quota: 10000 }),
    }, 201);
    const childKeyResult = await call(`/v1/subaccounts/${child.body.subaccount.id}/keys`, {
      method: 'POST', headers: headers(apiKey),
      body: JSON.stringify({ name: 'Live E2E child key', scopes: ['send', 'messages'] }),
    }, 201);
    const childKey = childKeyResult.body.api_key as string;
    await call('/v1/profile', {
      method: 'PATCH', headers: headers(childKey),
      body: JSON.stringify({ physical_address: '200 Child E2E Way, Dublin, Ireland' }),
    });
    const childDomain = `child-${runId}.live-e2e.test`;
    await seedDomain(child.body.subaccount.id, childDomain);
    const childSubject = `[LIVE E2E ${runId}] ENTERPRISE child`;
    await call('/v1/send', {
      method: 'POST', headers: headers(childKey),
      body: JSON.stringify({
        from: `child@${childDomain}`,
        to: `child-${runId}@example.net`,
        subject: childSubject,
        text: 'Enterprise child delivery',
      }),
    }, 202);
    const crossTenant = await call('/v1/send', {
      method: 'POST', headers: headers(childKey),
      body: JSON.stringify({
        from: `blocked@${domain}`,
        to: `blocked-${runId}@example.net`,
        subject: 'Must be blocked',
        text: 'Cross-tenant sender',
      }),
    }, 403);
    assert(crossTenant.body.error === 'domain_not_registered', 'enterprise: cross-tenant sender was not blocked');
    await waitForMailpit([childSubject]);
    const integrity = await call('/v1/account/audit/verify', { headers: headers(session) });
    assert(integrity.body.ok === true, 'enterprise: audit chain verification failed');
    steps.push('enterprise-rbac-sso-scim-subaccount-isolation-audit');
  }

  return { tier, customerId, email, domain, steps };
}

async function main() {
  assertSafeTarget();
  await call('/ready');
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const results = [];
  for (const tier of ['free', 'paid', 'enterprise'] as const) {
    results.push(await runPersona(tier, runId));
  }
  console.log(JSON.stringify({ ok: true, runId, results }, null, 2));
}

async function closeResources() {
  await Promise.allSettled([closeQueues(), closeRedis(), closeDb()]);
}

main()
  .then(() => closeResources())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    await closeResources();
    process.exitCode = 1;
  });
