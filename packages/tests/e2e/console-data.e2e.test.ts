// E2E: customer-console data routes (human session, /v1/account/data):
// contacts (create, profile, import, bulk), audiences (lists, segments,
// membership) and the workflow builder document (save, conflicts, publish).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildTestApp } from './harness.js';
import { CapturingPlatformMailer, setPlatformMailer } from '@platform/shared';

let app: FastifyInstance;
let token: string;
const base = '/v1/account/data';
const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const get = (url: string) => app.inject({ method: 'GET', url: base + url, headers: { authorization: `Bearer ${token}` } });
const send = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: base + url, headers: payload === undefined ? { authorization: `Bearer ${token}` } : auth(), ...(payload === undefined ? {} : { payload: payload as any }) });
const email = (p: string) => `${p}-${randomUUID().slice(0, 8)}@example.com`;

beforeAll(async () => {
  app = await buildTestApp();
  setPlatformMailer(new CapturingPlatformMailer());
  const res = await app.inject({
    method: 'POST', url: '/v1/auth/register', headers: { 'content-type': 'application/json' },
    payload: { email: email('console-owner'), password: 'a-good-long-password', org_name: 'Console Org' },
  });
  expect(res.statusCode).toBe(201);
  token = res.json().token;
});
afterAll(async () => { await app.close(); setPlatformMailer(null); });

describe('E2E console contacts', () => {
  it('creates, lists, updates profiles, imports and bulk-updates contacts', async () => {
    const created = await send('POST', '/contacts', { email: email('Ada'), name: 'Ada', status: 'Subscribed', consent_confirmed: true, tags: ['VIP', 'vip'], attributes: { plan: 'pro' }, timezone: 'Europe/London' });
    expect(created.statusCode).toBe(201);
    const contact = created.json().contact;
    expect(contact.tags).toEqual(['vip']);

    expect((await send('POST', '/contacts', { email: contact.email, name: 'Again' })).statusCode).toBe(409);
    expect((await send('POST', '/contacts', { email: email('noconsent'), name: 'No consent', status: 'Subscribed' })).statusCode).toBe(400);
    expect((await send('POST', '/contacts', { email: 'not-an-email', name: 'Bad' })).statusCode).toBe(400);

    const profile = await send('PATCH', `/contacts/${contact.id}/profile`, { tags: ['vip', 'beta'], attributes: { plan: null, renewal_date: '2027-01-01' }, timezone: null });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().contact.attributes).toEqual({ renewal_date: '2027-01-01' });
    expect((await send('PATCH', `/contacts/${randomUUID()}/profile`, { tags: ['x'] })).statusCode).toBe(404);
    expect((await send('PATCH', `/contacts/${contact.id}/profile`, { timezone: 'Mars/Base' })).statusCode).toBe(400);

    const importedEmails = [email('imp1'), email('imp2')];
    const imported = await send('POST', '/contacts/import', { contacts: importedEmails.map((e, i) => ({ email: e, name: `Imported ${i}`, status: i ? 'Unsubscribed' : 'Pending' })) });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().imported).toBe(2);
    expect((await send('POST', '/contacts/import', { contacts: [{ email: importedEmails[0], name: 'Duplicate' }] })).statusCode).toBe(409);
    expect((await send('POST', '/contacts/import', { contacts: [] })).statusCode).toBe(400);

    const list = await get('/contacts?limit=50');
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.stats.total).toBe(3);
    expect(body.contacts.find((c: any) => c.email === importedEmails[1]).effective_status).toBe('Unsubscribed');
    expect((await get('/contacts?limit=0')).statusCode).toBe(400);

    const ids = body.contacts.filter((c: any) => importedEmails.includes(c.email)).map((c: any) => c.id);
    const unsub = await send('POST', '/contacts/bulk', { ids: [contact.id], action: 'unsubscribe' });
    expect(unsub.json().changed).toBe(1);
    // A suppressed address cannot be re-created as subscribed.
    await send('POST', '/contacts/bulk', { ids: [contact.id], action: 'delete' });
    expect((await send('POST', '/contacts', { email: contact.email, name: 'Back', status: 'Subscribed', consent_confirmed: true })).json().error).toBe('suppressed_contact');
    expect((await send('POST', '/contacts/bulk', { ids: [randomUUID()], action: 'delete' })).statusCode).toBe(404);
    expect((await send('POST', '/contacts/bulk', { ids, action: 'archive' })).statusCode).toBe(400);
    expect((await send('POST', '/contacts/bulk', { ids, action: 'delete' })).json().changed).toBe(2);
  });
});

describe('E2E console audiences', () => {
  it('manages lists and segments and their members', async () => {
    const people = await Promise.all([1, 2].map(async n => (await send('POST', '/contacts', { email: email(`member${n}`), name: `Member ${n}` })).json().contact));
    const list = await send('POST', '/audiences', { kind: 'list', name: `Newsletter ${randomUUID().slice(0, 6)}` });
    expect(list.statusCode).toBe(201);
    const listId = list.json().id;
    expect((await send('POST', '/audiences', { kind: 'list', name: list.json().name })).statusCode).toBe(409);
    expect((await send('POST', '/audiences', { kind: 'segment', name: 'No rules' })).statusCode).toBe(400);
    const segment = await send('POST', '/audiences', { kind: 'segment', name: `Engaged ${randomUUID().slice(0, 6)}`, rules: [{ field: 'Created', op: 'in last', val: '7 days' }, { field: 'Opened any email', op: 'not in last', val: '30 days' }] });
    expect(segment.statusCode).toBe(201);

    const add = await send('POST', `/audiences/${listId}/members`, { ids: people.map(p => p.id), action: 'add' });
    expect(add.statusCode).toBe(200);
    expect(add.json()).toMatchObject({ processed: 2 });
    expect((await send('POST', `/audiences/${segment.json().id}/members`, { ids: [people[0].id], action: 'add' })).statusCode).toBe(404);
    expect((await send('POST', `/audiences/${listId}/members`, { ids: [randomUUID()], action: 'add' })).statusCode).toBe(404);
    expect((await send('POST', `/audiences/${listId}/members`, { ids: [], action: 'add' })).statusCode).toBe(400);

    const members = await get(`/audiences/${listId}/members`);
    expect(members.json().contacts).toHaveLength(2);
    expect((await get(`/audiences/${segment.json().id}/members`)).json().contacts.length).toBeGreaterThanOrEqual(2);
    expect((await get(`/audiences/${randomUUID()}/members`)).statusCode).toBe(404);
    expect((await get('/audiences/not-a-uuid/members')).statusCode).toBe(400);

    await send('POST', `/audiences/${listId}/members`, { ids: [people[0].id], action: 'remove' });
    const all = (await get('/audiences')).json().collections;
    expect(all.find((c: any) => c.id === listId).count).toBe(1);

    expect((await send('DELETE', `/audiences/${listId}`)).json().deleted).toBe(true);
    expect((await send('DELETE', `/audiences/${listId}`)).statusCode).toBe(404);
    expect((await send('DELETE', '/audiences/nope')).statusCode).toBe(400);
  });
});

describe('E2E console workflow builder', () => {
  it('saves builder documents with revision checks and publishes', async () => {
    const created = await send('POST', '/workflows', { name: `Builder ${randomUUID().slice(0, 6)}` });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const graph = { nodes: [{ id: 'trigger', t: 'trigger', x: 0, y: 0 }, { id: 'w1', t: 'wait', mode: 'duration', amount: 1, unit: 'hours' }], edges: [{ id: 'e1', from: 'trigger', to: 'w1', port: 'out' }] };

    const loaded = await get(`/workflows/${id}/builder`);
    expect(loaded.statusCode).toBe(200);
    const revision = loaded.json().builder_revision;
    expect((await get(`/workflows/${randomUUID()}/builder`)).statusCode).toBe(404);
    expect((await get('/workflows/bad/builder')).statusCode).toBe(400);

    const saved = await send('PUT', `/workflows/${id}/builder`, { expected_revision: revision, name: 'Welcome journey', document: { graph, tkey: 'api' } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().builder_revision).toBe(revision + 1);
    expect((await send('PUT', `/workflows/${id}/builder`, { expected_revision: revision, name: 'Stale', document: { graph } })).json().error).toBe('stale_revision');
    expect((await send('PUT', `/workflows/${id}/builder`, { expected_revision: revision + 1, name: 'No trigger', document: { graph: { nodes: [{ id: 'w1', t: 'wait' }], edges: [] } } })).statusCode).toBe(400);

    const definition = { trigger: { type: 'api' }, entry_step_id: 's1', steps: [{ id: 's1', type: 'delay', duration_seconds: 3600, next: null }], settings: { allow_reentry: false, reentry_cooldown_seconds: 0 } };
    expect((await send('POST', `/workflows/${id}/builder/publish`, { expected_revision: revision + 5, definition })).json().error).toBe('stale_revision');
    const invalid = await send('POST', `/workflows/${id}/builder/publish`, { expected_revision: revision + 1, definition: { trigger: { type: 'api' }, entry_step_id: 'ghost', steps: [] } });
    expect(invalid.statusCode).toBe(422);
    const published = await send('POST', `/workflows/${id}/builder/publish`, { expected_revision: revision + 1, definition });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json().builder_revision).toBe(revision + 2);
  });
});

describe('E2E console campaigns', () => {
  it('drafts, edits with revision checks, validates launch and cancels', async () => {
    expect((await send('POST', '/campaigns', { name: '' })).statusCode).toBe(400);
    expect((await send('POST', '/campaigns', { name: 'Ghost audience', audience_id: randomUUID() })).json().error).toBe('audience_not_found');
    const created = await send('POST', '/campaigns', { name: 'Spring update', campaign_type: 'ab_subject' });
    expect(created.statusCode).toBe(201);
    const campaign = created.json();
    expect(campaign).toMatchObject({ status: 'draft', revision: 0 });

    const listed = (await get('/campaigns')).json().campaigns.find((c: any) => c.id === campaign.id);
    expect(listed.stats).toEqual({ total: 0, delivered: 0, opened: 0, clicked: 0, pending: 0 });

    const draft = { name: 'Spring update', audience_id: null, template_id: null, from_email: 'not-an-email', from_name: 'Acme', reply_to: '', subject: 'Hello', subject_b: 'Hello' };
    const saved = await send('PUT', `/campaigns/${campaign.id}`, { ...draft, expected_revision: 0 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().revision).toBe(1);
    expect((await send('PUT', `/campaigns/${campaign.id}`, { ...draft, expected_revision: 0 })).json().error).toBe('stale_revision');
    expect((await send('PUT', `/campaigns/${campaign.id}`, { ...draft, template_id: randomUUID(), expected_revision: 1 })).statusCode).toBe(409);
    expect((await send('PUT', `/campaigns/${campaign.id}`, { ...draft, subject: 'line\nbreak', expected_revision: 1 })).statusCode).toBe(400);

    expect((await send('POST', `/campaigns/${campaign.id}/launch`, { expected_revision: 1 })).statusCode).toBe(400);
    expect((await send('POST', `/campaigns/${campaign.id}/launch`, { expected_revision: 0, ad_identified: true })).json().error).toBe('stale_revision');
    expect((await send('POST', `/campaigns/${campaign.id}/launch`, { expected_revision: 1, ad_identified: true })).json().error).toBe('incomplete_campaign');
    expect((await send('POST', `/campaigns/${randomUUID()}/launch`, { expected_revision: 0, ad_identified: true })).statusCode).toBe(404);

    expect((await send('POST', `/campaigns/${campaign.id}/reconcile`, {})).json()).toMatchObject({ status: 'draft', reconciled: false });
    expect((await send('POST', `/campaigns/${randomUUID()}/reconcile`, {})).statusCode).toBe(404);
    expect((await send('POST', `/campaigns/${campaign.id}/cancel-scheduled`, { expected_revision: 1 })).json().error).toBe('not_cancellable');
    expect((await send('POST', `/campaigns/${randomUUID()}/cancel-scheduled`, { expected_revision: 0 })).statusCode).toBe(404);

    expect((await send('POST', `/campaigns/${campaign.id}/cancel`, { expected_revision: 0 })).json().error).toBe('invalid_state');
    expect((await send('POST', `/campaigns/${campaign.id}/cancel`, { expected_revision: 1 })).json().status).toBe('cancelled');
    expect((await send('POST', `/campaigns/${campaign.id}/cancel-scheduled`, { expected_revision: 2 })).json()).toMatchObject({ already_cancelled: true });
  });
});
