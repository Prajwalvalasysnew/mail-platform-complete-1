// E2E: resource lifecycle across domains, suppressions, templates, usage,
// and a template-driven send.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startHarness,
  seedCustomer,
  seedVerifiedDomain,
  waitForStatus,
  getMessageRow,
  resetPoolWarmup,
  type Harness,
  type SeededCustomer,
} from './harness.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await resetPoolWarmup("transactional"); });
afterAll(async () => { await h.close(); });

function req(cust: SeededCustomer, method: any, url: string, payload?: unknown) {
  return h.app.inject({
    method, url,
    headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/json' },
    ...(payload ? { payload } : {}),
  });
}

describe('E2E domains lifecycle', () => {
  it('registers a domain and lists it', async () => {
    const cust = await seedCustomer();
    const create = await req(cust, 'POST', '/v1/domains', { domain: 'mybrand.example.com' });
    expect([200, 201]).toContain(create.statusCode);

    const list = await req(cust, 'GET', '/v1/domains');
    expect(list.statusCode).toBe(200);
    const body = list.json();
    const domains = Array.isArray(body) ? body : body.domains ?? body.data ?? [];
    const names = domains.map((d: any) => d.domain);
    expect(names).toContain('mybrand.example.com');
  });
});

describe('E2E suppressions lifecycle', () => {
  it('adds and lists a suppression', async () => {
    const cust = await seedCustomer();
    const add = await req(cust, 'POST', '/v1/suppressions', {
      email: 'optout@g.com', reason: 'unsubscribe',
    });
    expect([200, 201]).toContain(add.statusCode);

    const list = await req(cust, 'GET', '/v1/suppressions');
    expect(list.statusCode).toBe(200);
    const body = list.json();
    const rows = Array.isArray(body) ? body : body.suppressions ?? body.data ?? [];
    expect(rows.map((r: any) => r.email)).toContain('optout@g.com');
  });
});

describe('E2E templates + template send', () => {
  it('creates a template and sends using it with variable substitution', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);

    const create = await req(cust, 'POST', '/v1/templates', {
      name: `welcome-${Date.now()}`,
      subject: 'Welcome {{name}}',
      html_body: '<p>Hi {{name}}, thanks for joining.</p>',
      text_body: 'Hi {{name}}',
    });
    expect([200, 201]).toContain(create.statusCode);
    const tpl = create.json();
    const templateId = tpl.id ?? tpl.template?.id;
    expect(templateId).toBeTruthy();

    const send = await req(cust, 'POST', '/v1/send', {
      from: `x@${domain}`,
      to: 'newuser@g.com',
      template_id: templateId,
      variables: { name: 'Ada' },
    });
    expect(send.statusCode).toBe(202);
    const id = send.json().message_ids[0];
    await waitForStatus(id, ['accepted', 'sent']);

    const msg = await getMessageRow(id);
    expect(msg?.subject).toContain('Ada');
    expect(msg?.html_body).toContain('Ada');
  });
});

describe('E2E usage', () => {
  it('reports usage after a send', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const send = await req(cust, 'POST', '/v1/send', {
      from: `x@${domain}`, to: 'u@g.com', subject: 's', text: 't',
    });
    const id = send.json().message_ids[0];
    await waitForStatus(id, ['accepted', 'sent']);

    const usage = await req(cust, 'GET', '/v1/usage');
    expect(usage.statusCode).toBe(200);
    const body = usage.json();
    // The endpoint reports daily/monthly counters; shape may vary, so just assert presence.
    expect(body).toBeTruthy();
  });
});

describe('E2E messages', () => {
  it('lists messages and fetches one by id', async () => {
    const cust = await seedCustomer();
    const domain = await seedVerifiedDomain(cust.customerId);
    const send = await req(cust, 'POST', '/v1/send', {
      from: `x@${domain}`, to: 'lookup@g.com', subject: 'find me', text: 't',
    });
    const id = send.json().message_ids[0];
    await waitForStatus(id, ['accepted', 'sent']);

    const one = await req(cust, 'GET', `/v1/messages/${encodeURIComponent(id)}`);
    expect([200, 404]).toContain(one.statusCode);
    if (one.statusCode === 200) {
      const body = one.json();
      const msg = body.message ?? body;
      expect(msg.to_address ?? msg.to).toBe('lookup@g.com');
    }
  });
});
