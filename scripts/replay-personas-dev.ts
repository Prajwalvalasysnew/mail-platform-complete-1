// Safe, additive development replay for Free/Paid/Enterprise customer activity.
// Refuses non-local/test databases and creates unique records without cleanup.

import 'dotenv/config';
import {
  applySubscriptionState,
  closeDb,
  closeQueues,
  closeRedis,
  db,
} from '../packages/shared/src/index.js';

const apiBase = process.env.DEV_REPLAY_API_BASE ?? 'http://localhost:3000';
const databaseUrl = process.env.DATABASE_URL ?? '';

function assertSafeTarget() {
  if (process.env.DEV_REPLAY_CONFIRM !== '1') {
    throw new Error('Set DEV_REPLAY_CONFIRM=1 to run the additive development replay.');
  }
  const api = new URL(apiBase);
  if (!['localhost', '127.0.0.1', '::1'].includes(api.hostname)) {
    throw new Error(`Refusing non-local API target: ${api.hostname}`);
  }
  const database = new URL(databaseUrl);
  if (!['localhost', '127.0.0.1', '::1'].includes(database.hostname)) {
    throw new Error(`Refusing non-local database target: ${database.hostname}`);
  }
  if (database.port === '5434' || /test/i.test(database.pathname)) {
    throw new Error(`Refusing isolated test database: ${database.host}${database.pathname}`);
  }
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${apiBase}${path}`, init);
  const text = await response.text();
  let body: any = {};
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed (${response.status}): ${text}`);
  }
  return { response, body };
}

function jsonHeaders(token?: string) {
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function activateTier(customerId: string, tier: 'paid' | 'enterprise', runId: string) {
  const priceId = tier === 'paid' ? 'price_pro' : 'price_enterprise';
  await applySubscriptionState({
    provider: 'stripe',
    provider_event_id: `evt_dev_replay_${tier}_${runId}`,
    type: 'customer.subscription.updated',
    internal_customer_id: customerId,
    provider_subscription_id: `sub_dev_replay_${tier}_${runId}`,
    plan_item_id: `si_dev_replay_${tier}_${runId}`,
    price_id: priceId,
    status: 'active',
  });
}

async function waitForTerminal(apiKey: string, messageId: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { body } = await request(`/v1/messages/${encodeURIComponent(messageId)}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const status = body.message?.status as string;
    if (['accepted', 'sent', 'delivered', 'failed', 'hard_bounced', 'soft_bounced'].includes(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return 'timeout';
}

async function replayTier(tier: 'free' | 'paid' | 'enterprise', runId: string) {
  const email = `dev-replay-${tier}-${runId}@local.test`;
  const password = 'Dev-Replay-Password-123!';
  const registration = await request('/v1/auth/register', {
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({
      email, password, name: `${tier} replay owner`, org_name: `DEV Replay ${tier.toUpperCase()}`,
    }),
  });
  const sessionToken = registration.body.token as string;
  const customerId = registration.body.customer_id as string;
  await request('/v1/auth/verify-email', {
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ token: registration.body._dev_email_verify_token }),
  });
  if (tier !== 'free') await activateTier(customerId, tier, runId);

  const key = await request('/v1/account/api-keys', {
    method: 'POST', headers: jsonHeaders(sessionToken),
    body: JSON.stringify({
      name: `${tier} development replay`, key_type: 'secret',
      scopes: ['send', 'messages', 'domains', 'templates', 'suppressions', 'webhooks', 'workflows'],
    }),
  });
  const apiKey = key.body.api_key as string;
  await request('/v1/profile', {
    method: 'PATCH', headers: jsonHeaders(apiKey),
    body: JSON.stringify({ physical_address: '100 Development Replay Way, Test City, CA 94105' }),
  });

  const domain = `${tier}-${runId}.dev-replay.test`;
  await db.insertInto('sending_domains').values({
    customer_id: customerId,
    domain,
    dkim_selector: 'mail',
    dkim_public_key: 'dev-replay-public-key',
    dkim_private_key: 'dev-replay-private-key',
    verified_at: new Date(),
    dkim_verified: true,
    spf_verified: true,
    dmarc_verified: true,
  } as any).execute();

  const recipients = [
    `mailpit-${tier}-welcome-${runId}@example.net`,
    `mailpit-${tier}-invoice-${runId}@example.net`,
  ];
  const welcome = await request('/v1/send', {
    method: 'POST', headers: jsonHeaders(apiKey),
    body: JSON.stringify({
      from: `welcome@${domain}`, to: recipients[0],
      subject: `[DEV REPLAY] ${tier.toUpperCase()} welcome journey`,
      html: `<h1>${tier.toUpperCase()} persona</h1><p>This message verifies the real local API, queue, worker, and Mailpit path.</p>`,
      text: `${tier} persona development replay`,
      tags: ['dev-replay', 'persona', tier, 'welcome'],
    }),
  });
  const invoice = await request('/v1/send', {
    method: 'POST', headers: jsonHeaders(apiKey),
    body: JSON.stringify({
      from: `billing@${domain}`, to: recipients[1],
      subject: `[DEV REPLAY] ${tier.toUpperCase()} invoice`,
      html: `<p>Invoice generated for the ${tier} development persona.</p>`,
      text: `${tier} invoice replay`,
      tags: ['dev-replay', 'persona', tier, 'invoice'],
      attachments: [{
        filename: `${tier}-invoice.txt`,
        content_type: 'text/plain',
        content: Buffer.from(`development replay invoice for ${tier}`).toString('base64'),
      }],
    }),
  });

  const messageIds = [...welcome.body.message_ids, ...invoice.body.message_ids] as string[];
  const statuses = await Promise.all(messageIds.map((id) => waitForTerminal(apiKey, id)));
  return { tier, customerId, email, domain, recipients, messageIds, statuses };
}

async function main() {
  assertSafeTarget();
  await request('/ready');
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const results = [];
  for (const tier of ['free', 'paid', 'enterprise'] as const) {
    results.push(await replayTier(tier, runId));
  }
  console.log(JSON.stringify({ runId, results }, null, 2));
}

async function closeResources() {
  await Promise.allSettled([closeQueues(), closeRedis(), closeDb()]);
}

main()
  .then(() => closeResources())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await closeResources();
    process.exitCode = 1;
  });
