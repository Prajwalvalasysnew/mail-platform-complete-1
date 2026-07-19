// Sub-accounts: reseller/franchise tenancy — isolation, credentials,
// on-behalf-of, spend caps, suspension, roll-up, template push.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer, seedVerifiedDomain, resetQuota, type SeededCustomer } from './harness.js';
import { db } from '@platform/shared';

let app: FastifyInstance;
let parent: SeededCustomer;
let parentDomain: string;
let childId: string;
let childKey: string;
let childDomain: string;

function authed(key = parent.apiKey) {
  return { authorization: `Bearer ${key}` };
}

beforeAll(async () => {
  app = await buildTestApp();
  parent = await seedCustomer({ scopes: ['send', 'domains', 'suppressions', 'messages', 'templates', 'subaccounts'] });
  parentDomain = await seedVerifiedDomain(parent.customerId);
});

afterAll(async () => {
  await app.close();
});

describe('sub-accounts', () => {
  it('creates a sub-account with spend caps and lists it', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/subaccounts', headers: authed(),
      payload: { name: 'District North', daily_quota: 2, monthly_quota: 100 },
    });
    expect(res.statusCode).toBe(201);
    const sub = res.json().subaccount;
    childId = sub.id;
    expect(sub.daily_quota).toBe(2);
    expect(sub.status).toBe('active');

    const list = await app.inject({ method: 'GET', url: '/v1/subaccounts', headers: authed() });
    expect(list.json().subaccounts.some((s: any) => s.id === childId)).toBe(true);

    const row = await db.selectFrom('customers').select('parent_customer_id').where('id', '=', childId).executeTakeFirstOrThrow();
    expect(row.parent_customer_id).toBe(parent.customerId);
  });

  it('mints child credentials and the child sends under its own tenant', async () => {
    const keyRes = await app.inject({
      method: 'POST', url: `/v1/subaccounts/${childId}/keys`, headers: authed(),
      payload: { name: 'district-relay' },
    });
    expect(keyRes.statusCode).toBe(201);
    childKey = keyRes.json().api_key;
    expect(keyRes.json().scopes).toEqual(['send', 'smtp']);

    childDomain = await seedVerifiedDomain(childId);
    const send = await app.inject({
      method: 'POST', url: '/v1/send', headers: authed(childKey),
      payload: { from: `news@${childDomain}`, to: 'parent1@example.com', subject: 'Snow day', text: 'Closed tomorrow.' },
    });
    expect(send.statusCode).toBe(202);
    const msg = await db
      .selectFrom('messages')
      .select('customer_id')
      .where('message_id', '=', send.json().message_ids[0])
      .executeTakeFirstOrThrow();
    expect(msg.customer_id).toBe(childId);
  });

  it("keeps tenants isolated: the child cannot use the parent's domain", async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/send', headers: authed(childKey),
      payload: { from: `news@${parentDomain}`, to: 'x@example.com', subject: 'x', text: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('domain_not_registered');
  });

  it('enforces the child spend cap (daily_quota) independently of the parent', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/send', headers: authed(childKey),
      payload: { from: `news@${childDomain}`, to: ['a@example.com', 'b@example.com'], subject: 'x', text: 'x' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('quota_exceeded');
    await resetQuota(childId);
  });

  it('lets a parent key act as the child via X-On-Behalf-Of (and only as its own children)', async () => {
    const send = await app.inject({
      method: 'POST', url: '/v1/send',
      headers: { ...authed(), 'x-on-behalf-of': childId },
      payload: { from: `news@${childDomain}`, to: 'obo@example.com', subject: 'OBO', text: 'x' },
    });
    expect(send.statusCode).toBe(202);
    const msg = await db
      .selectFrom('messages')
      .select('customer_id')
      .where('message_id', '=', send.json().message_ids[0])
      .executeTakeFirstOrThrow();
    expect(msg.customer_id).toBe(childId);

    // A random org (not our child) must be refused.
    const stranger = await seedCustomer();
    const bad = await app.inject({
      method: 'POST', url: '/v1/send',
      headers: { ...authed(), 'x-on-behalf-of': stranger.customerId },
      payload: { from: `news@${childDomain}`, to: 'x@example.com', subject: 'x', text: 'x' },
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error).toBe('invalid_on_behalf_of');
  });

  it('suspending a child blocks its sends immediately', async () => {
    const patch = await app.inject({
      method: 'PATCH', url: `/v1/subaccounts/${childId}`, headers: authed(),
      payload: { status: 'suspended' },
    });
    expect(patch.statusCode).toBe(200);

    const viaChildKey = await app.inject({
      method: 'POST', url: '/v1/send', headers: authed(childKey),
      payload: { from: `news@${childDomain}`, to: 'x@example.com', subject: 'x', text: 'x' },
    });
    expect(viaChildKey.statusCode).toBe(403);

    const viaObo = await app.inject({
      method: 'POST', url: '/v1/send',
      headers: { ...authed(), 'x-on-behalf-of': childId },
      payload: { from: `news@${childDomain}`, to: 'x@example.com', subject: 'x', text: 'x' },
    });
    expect(viaObo.statusCode).toBe(403);
    expect(viaObo.json().error).toBe('subaccount_suspended');

    await app.inject({
      method: 'PATCH', url: `/v1/subaccounts/${childId}`, headers: authed(),
      payload: { status: 'active' },
    });
  });

  it('rolls up per-child usage for the parent', async () => {
    // usage_daily.sent is written by the send worker at handoff (not running
    // in this harness), so seed the child's usage directly and verify the
    // roll-up aggregates it.
    const today = new Date().toISOString().slice(0, 10);
    await db
      .insertInto('usage_daily')
      .values({ customer_id: childId, usage_date: today, sent: 3, delivered: 2 } as any)
      .onConflict((oc) => oc.columns(['customer_id', 'usage_date']).doUpdateSet({ sent: 3, delivered: 2 } as any))
      .execute();

    const res = await app.inject({ method: 'GET', url: '/v1/subaccounts/usage?days=30', headers: authed() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const child = body.children.find((c: any) => c.id === childId);
    expect(child).toBeTruthy();
    expect(child.sent).toBe(3);
    expect(child.delivered).toBe(2);
    expect(body.totals.sent).toBeGreaterThanOrEqual(3);
  });

  it('pushes a parent template to children (franchise model)', async () => {
    const tpl = await app.inject({
      method: 'POST', url: '/v1/templates', headers: authed(),
      payload: { name: 'corp-booking', subject: 'Your booking {{ref}}', html_body: '<p>Corporate template</p>' },
    });
    expect(tpl.statusCode).toBe(201);

    const push = await app.inject({
      method: 'POST', url: '/v1/subaccounts/templates/push', headers: authed(),
      payload: { template_id: tpl.json().id, subaccount_ids: 'all' },
    });
    expect(push.statusCode).toBe(200);
    expect(push.json().pushed).toContain(childId);

    const childTpl = await db
      .selectFrom('templates')
      .select(['name', 'subject'])
      .where('customer_id', '=', childId)
      .where('name', '=', 'corp-booking')
      .executeTakeFirst();
    expect(childTpl?.subject).toBe('Your booking {{ref}}');
  });

  it('refuses nesting: a child cannot create its own sub-accounts', async () => {
    const grandchildKey = await app.inject({
      method: 'POST', url: `/v1/subaccounts/${childId}/keys`, headers: authed(),
      payload: { name: 'child-mgmt', scopes: ['subaccounts'] },
    });
    expect(grandchildKey.statusCode).toBe(201);
    const res = await app.inject({
      method: 'POST', url: '/v1/subaccounts', headers: authed(grandchildKey.json().api_key),
      payload: { name: 'Grandchild Inc' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('subaccounts_cannot_nest');
  });
});
