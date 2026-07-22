// Persona E2E: an enterprise organization operates a governed mail estate.
//
// owner/org registration -> enterprise contract activation -> team RBAC + SSO
// -> SCIM credential -> scoped parent integration -> capped subaccount ->
// child and on-behalf-of delivery -> quota roll-up -> tamper-evident audit log.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applySubscriptionState,
  db,
  MockBillingProvider,
  setBillingProvider,
} from '@platform/shared';
import {
  getEventTypes,
  getUsageSent,
  resetPoolWarmup,
  resetQuota,
  seedVerifiedDomain,
  startHarness,
  waitForStatus,
  type Harness,
} from '../harness.js';

let h: Harness;
let billing: MockBillingProvider;

beforeAll(async () => {
  billing = new MockBillingProvider('stripe');
  setBillingProvider(billing);
  h = await startHarness();
  await resetPoolWarmup('transactional');
});

afterAll(async () => {
  setBillingProvider(null);
  await h.close();
});

function sessionAuth(token: string, withBody = true) {
  return {
    authorization: `Bearer ${token}`,
    ...(withBody ? { 'content-type': 'application/json' } : {}),
  };
}

function apiAuth(apiKey: string, extra?: Record<string, string>) {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    ...extra,
  };
}

async function waitForAuditActions(customerId: string, expected: string[], timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.selectFrom('audit_log').select('action')
      .where('customer_id', '=', customerId).execute();
    const actions = new Set(rows.map((row) => row.action));
    if (expected.every((action) => actions.has(action))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for enterprise audit actions: ${expected.join(', ')}`);
}

describe('persona: enterprise organization', () => {
  it('governs team access, subaccounts, priority sending, quotas, and audit integrity', async () => {
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ownerEmail = `enterprise-owner-${run}@global.example.com`;

    // 1. The enterprise owner creates and verifies the initial organization.
    const registration = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        email: ownerEmail,
        password: 'enterprise-owner-password',
        name: 'Enterprise Owner',
        org_name: 'Global Enterprise Persona',
      },
    });
    expect(registration.statusCode).toBe(201);
    const registered = registration.json();
    const ownerToken = registered.token as string;
    const customerId = registered.customer_id as string;

    const verify = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers: { 'content-type': 'application/json' },
      payload: { token: registered._dev_email_verify_token },
    });
    expect(verify.statusCode).toBe(200);

    // 2. A provider-governed contract change activates enterprise quotas only
    // after the authenticated subscription state is applied.
    const providerSubscriptionId = `sub_enterprise_${run}`;
    await db.insertInto('subscriptions').values({
      customer_id: customerId,
      provider: 'stripe',
      provider_subscription_id: providerSubscriptionId,
      provider_plan_item_id: 'si_enterprise_base',
      plan: 'free',
      status: 'active',
      price_id: 'price_free',
    }).execute();

    const preview = await h.app.inject({
      method: 'POST',
      url: '/v1/account/billing/plan-change/preview',
      headers: sessionAuth(ownerToken),
      payload: { price_id: 'price_enterprise' },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      current_plan: 'free', target_plan: 'enterprise', direction: 'upgrade',
    });

    const requestId = preview.json().request_id as string;
    const confirm = await h.app.inject({
      method: 'POST',
      url: `/v1/account/billing/plan-change/${requestId}/confirm`,
      headers: sessionAuth(ownerToken, false),
    });
    expect(confirm.statusCode).toBe(202);
    expect(confirm.json().status).toBe('pending_provider_confirmation');

    await applySubscriptionState({
      provider: 'stripe',
      provider_event_id: `evt_enterprise_upgrade_${run}`,
      type: 'customer.subscription.updated',
      internal_customer_id: customerId,
      provider_subscription_id: providerSubscriptionId,
      plan_item_id: 'si_enterprise_base',
      price_id: 'price_enterprise',
      status: 'active',
    });

    const enterprise = await db.selectFrom('customers')
      .select(['tier', 'daily_quota', 'monthly_quota'])
      .where('id', '=', customerId).executeTakeFirstOrThrow();
    expect(enterprise).toMatchObject({
      tier: 'enterprise', daily_quota: 1_000_000, monthly_quota: 50_000_000,
    });
    expect(await db.selectFrom('billing_plan_change_requests').select('status')
      .where('id', '=', requestId).executeTakeFirstOrThrow()).toMatchObject({ status: 'applied' });

    // 3. The owner invites a developer. The developer can inspect operations,
    // but cannot access contract and invoice controls.
    const developerEmail = `enterprise-developer-${run}@global.example.com`;
    const invite = await h.app.inject({
      method: 'POST',
      url: '/v1/team/invites',
      headers: sessionAuth(ownerToken),
      payload: { email: developerEmail, role: 'developer' },
    });
    expect(invite.statusCode).toBe(201);
    expect(invite.json()._dev_invite_token).toBeTruthy();

    const acceptedInvite = await h.app.inject({
      method: 'POST',
      url: '/v1/team/invites/accept',
      headers: { 'content-type': 'application/json' },
      payload: {
        token: invite.json()._dev_invite_token,
        name: 'Enterprise Developer',
        password: 'enterprise-developer-password',
      },
    });
    expect(acceptedInvite.statusCode).toBe(201);
    const developerToken = acceptedInvite.json().token as string;

    const members = await h.app.inject({
      method: 'GET', url: '/v1/team/members', headers: sessionAuth(developerToken, false),
    });
    expect(members.statusCode).toBe(200);
    expect(members.json().members).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: ownerEmail, role: 'owner' }),
      expect.objectContaining({ email: developerEmail, role: 'developer' }),
    ]));

    const blockedBilling = await h.app.inject({
      method: 'GET', url: '/v1/account/billing', headers: sessionAuth(developerToken, false),
    });
    expect(blockedBilling.statusCode).toBe(403);
    expect(blockedBilling.json().error).toBe('insufficient_role');

    // Enterprise identity controls: enforce SSO and mint a one-time SCIM token
    // for an external identity provider.
    const sso = await h.app.inject({
      method: 'PATCH',
      url: '/v1/account/settings/sso',
      headers: sessionAuth(ownerToken),
      payload: { enforced: true },
    });
    expect(sso.statusCode).toBe(200);
    expect(sso.json().sso_enforced).toBe(true);

    const scim = await h.app.inject({
      method: 'POST',
      url: '/v1/team/scim-tokens',
      headers: sessionAuth(ownerToken),
      payload: { label: 'Corporate identity provider' },
    });
    expect(scim.statusCode).toBe(201);
    expect(scim.json().token).toBeTruthy();
    const scimList = await h.app.inject({
      method: 'GET', url: '/v1/team/scim-tokens', headers: sessionAuth(ownerToken, false),
    });
    expect(scimList.statusCode).toBe(200);
    expect(scimList.json().tokens).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: scim.json().id, label: 'Corporate identity provider' }),
    ]));

    // 4. Create a scoped production integration for the parent estate.
    const keyResponse = await h.app.inject({
      method: 'POST',
      url: '/v1/account/api-keys',
      headers: sessionAuth(ownerToken),
      payload: {
        name: 'Enterprise mail control plane',
        key_type: 'secret',
        scopes: ['send', 'messages', 'domains', 'templates', 'subaccounts'],
      },
    });
    expect(keyResponse.statusCode).toBe(201);
    const parentKey = keyResponse.json().api_key as string;

    const parentProfile = await h.app.inject({
      method: 'PATCH',
      url: '/v1/profile',
      headers: apiAuth(parentKey),
      payload: {
        physical_address: '1 Enterprise Plaza, New York, NY 10001',
        tls_required: true,
      },
    });
    expect(parentProfile.statusCode).toBe(200);
    const parentDomain = await seedVerifiedDomain(customerId, `enterprise-${run}.example.com`);

    // 5. The control-plane key creates a capped regional workload identity
    // with separate credentials, compliance profile, and sender domain.
    const createChild = await h.app.inject({
      method: 'POST',
      url: '/v1/subaccounts',
      headers: apiAuth(parentKey),
      payload: {
        name: 'Enterprise EU Region',
        daily_quota: 10_000,
        monthly_quota: 250_000,
      },
    });
    expect(createChild.statusCode).toBe(201);
    expect(createChild.json().subaccount).toMatchObject({
      tier: 'enterprise', daily_quota: 10_000, monthly_quota: 250_000,
    });
    const childId = createChild.json().subaccount.id as string;

    const childKeyResponse = await h.app.inject({
      method: 'POST',
      url: `/v1/subaccounts/${childId}/keys`,
      headers: apiAuth(parentKey),
      payload: { name: 'EU transactional relay', scopes: ['send', 'messages', 'smtp'] },
    });
    expect(childKeyResponse.statusCode).toBe(201);
    const childKey = childKeyResponse.json().api_key as string;

    const childProfile = await h.app.inject({
      method: 'PATCH',
      url: '/v1/profile',
      headers: apiAuth(childKey),
      payload: { physical_address: '10 Europe Street, Dublin, D02 Ireland', tls_required: true },
    });
    expect(childProfile.statusCode).toBe(200);
    const childDomain = await seedVerifiedDomain(childId, `enterprise-eu-${run}.example.com`);
    await resetQuota(customerId);
    await resetQuota(childId);

    // 6. Send one critical parent alert, one child transaction, and one parent
    // on-behalf-of child transaction through the real queue and worker.
    const critical = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: apiAuth(parentKey, { 'idempotency-key': `enterprise-critical-${run}` }),
      payload: {
        from: `security@${parentDomain}`,
        to: 'security-team@example.net',
        subject: 'Enterprise security alert',
        text: 'A high-priority security event requires review.',
        priority: 'critical',
        tags: ['persona', 'enterprise', 'security'],
      },
    });
    expect(critical.statusCode).toBe(202);
    expect(critical.json().priority_applied).toBe('critical');

    const childSend = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: apiAuth(childKey, { 'idempotency-key': `enterprise-child-${run}` }),
      payload: {
        from: `receipts@${childDomain}`,
        to: 'eu-customer@example.net',
        subject: 'Enterprise EU receipt',
        html: '<p>Your enterprise receipt is ready.</p>',
        tags: ['persona', 'enterprise', 'regional'],
      },
    });
    expect(childSend.statusCode).toBe(202);

    const onBehalfOf = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: apiAuth(parentKey, {
        'x-on-behalf-of': childId,
        'idempotency-key': `enterprise-obo-${run}`,
      }),
      payload: {
        from: `operations@${childDomain}`,
        to: 'eu-operations@example.net',
        subject: 'Enterprise regional operations',
        text: 'Regional processing completed.',
        tags: ['persona', 'enterprise', 'on-behalf-of'],
      },
    });
    expect(onBehalfOf.statusCode).toBe(202);

    const invalidCrossTenant = await h.app.inject({
      method: 'POST',
      url: '/v1/send',
      headers: apiAuth(childKey),
      payload: {
        from: `security@${parentDomain}`,
        to: 'blocked@example.net',
        subject: 'Cross-tenant sender attempt',
        text: 'This must be blocked.',
      },
    });
    expect(invalidCrossTenant.statusCode).toBe(403);
    expect(invalidCrossTenant.json().error).toBe('domain_not_registered');

    const parentMessageId = critical.json().message_ids[0] as string;
    const childMessageIds = [
      childSend.json().message_ids[0] as string,
      onBehalfOf.json().message_ids[0] as string,
    ];
    for (const messageId of [parentMessageId, ...childMessageIds]) {
      expect(['accepted', 'sent']).toContain(await waitForStatus(messageId, ['accepted', 'sent']));
      expect(await getEventTypes(messageId)).toEqual(expect.arrayContaining(['queued', 'sent']));
    }
    expect(await getUsageSent(customerId)).toBe(1);
    expect(await getUsageSent(childId)).toBe(2);

    const parentQuota = await h.app.inject({
      method: 'GET', url: '/v1/usage/quota', headers: apiAuth(parentKey),
    });
    expect(parentQuota.statusCode).toBe(200);
    expect(parentQuota.json()).toMatchObject({
      daily: { used: 1, limit: 1_000_000 },
      monthly: { used: 1, limit: 50_000_000 },
    });

    const rollup = await h.app.inject({
      method: 'GET', url: '/v1/subaccounts/usage?days=30', headers: apiAuth(parentKey),
    });
    expect(rollup.statusCode).toBe(200);
    expect(rollup.json().children).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: childId, sent: 2 }),
    ]));
    expect(rollup.json().totals.sent).toBe(2);

    // 7. Both owner and developer can read the customer activity feed, while
    // only the owner can verify the organization's tamper-evident audit chain.
    const expectedAuditActions = [
      'team.invite_created',
      'team.invite_accepted',
      'org.sso_enforcement_enabled',
      'scim.token_created',
      'apikey.created',
      'subaccount:created',
      'subaccount:key_created',
    ];
    await waitForAuditActions(customerId, expectedAuditActions);

    const developerAudit = await h.app.inject({
      method: 'GET', url: '/v1/account/audit?days=1&limit=100', headers: sessionAuth(developerToken, false),
    });
    expect(developerAudit.statusCode).toBe(200);
    const visibleActions = developerAudit.json().entries.map((entry: { action: string }) => entry.action);
    expect(visibleActions).toEqual(expect.arrayContaining(expectedAuditActions));

    const developerIntegrity = await h.app.inject({
      method: 'GET', url: '/v1/account/audit/verify', headers: sessionAuth(developerToken, false),
    });
    expect(developerIntegrity.statusCode).toBe(403);

    const ownerIntegrity = await h.app.inject({
      method: 'GET', url: '/v1/account/audit/verify', headers: sessionAuth(ownerToken, false),
    });
    expect(ownerIntegrity.statusCode).toBe(200);
    expect(ownerIntegrity.json()).toMatchObject({ chain_key: customerId, ok: true });
    expect(ownerIntegrity.json().links_checked).toBeGreaterThanOrEqual(expectedAuditActions.length);
  }, 75_000);
});
