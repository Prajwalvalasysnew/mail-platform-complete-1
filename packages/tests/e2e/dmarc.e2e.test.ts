// DMARC monitoring API + scanner compound finding — e2e over live PG.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import zlib from 'node:zlib';
import { buildTestApp, seedCustomer, type SeededCustomer } from './harness.js';
import { scanDomain, type ScanResolver } from '@platform/shared';

let app: FastifyInstance;
let cust: SeededCustomer;

function report(reportId: string, domain = 'acme.com', p = 'quarantine') {
  return `<?xml version="1.0"?>
<feedback>
  <report_metadata><org_name>google.com</org_name><report_id>${reportId}</report_id>
    <date_range><begin>${Math.floor(Date.now() / 1000) - 3600}</begin><end>${Math.floor(Date.now() / 1000)}</end></date_range>
  </report_metadata>
  <policy_published><domain>${domain}</domain><p>${p}</p><pct>100</pct></policy_published>
  <record><row><source_ip>209.85.220.41</source_ip><count>1000</count>
    <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated></row>
    <identifiers><header_from>${domain}</header_from></identifiers>
    <auth_results><dkim><domain>${domain}</domain><result>pass</result></dkim><spf><domain>${domain}</domain><result>pass</result></spf></auth_results>
  </record>
  <record><row><source_ip>45.83.12.9</source_ip><count>250</count>
    <policy_evaluated><disposition>quarantine</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row>
    <identifiers><header_from>${domain}</header_from></identifiers>
    <auth_results><dkim><domain>evil.example</domain><result>fail</result></dkim><spf><domain>evil.example</domain><result>fail</result></spf></auth_results>
  </record>
</feedback>`;
}

function authed() {
  return { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/xml' };
}

beforeAll(async () => {
  app = await buildTestApp();
  cust = await seedCustomer();
});
afterAll(async () => {
  await app.close();
});

describe('DMARC monitoring API', () => {
  it('issues a stable reporting address', async () => {
    const a = await app.inject({ method: 'GET', url: '/v1/dmarc/reporting-address', headers: { authorization: `Bearer ${cust.apiKey}` } });
    expect(a.statusCode).toBe(200);
    expect(a.json().rua_address).toMatch(/^dmarc_[\w-]+@/);
    const b = await app.inject({ method: 'GET', url: '/v1/dmarc/reporting-address', headers: { authorization: `Bearer ${cust.apiKey}` } });
    expect(b.json().rua_address).toBe(a.json().rua_address); // stable
  });

  it('ingests a report, dedups replays, and builds the summary + sources', async () => {
    const rid = `r-${Date.now()}`;
    const ing = await app.inject({ method: 'POST', url: '/v1/dmarc/reports', headers: authed(), payload: report(rid) });
    expect(ing.statusCode).toBe(201);
    expect(ing.json().ingested).toBe(true);
    expect(ing.json().total_messages).toBe(1250);
    expect(ing.json().aligned_messages).toBe(1000);

    // Replay of the same report is a no-op.
    const dup = await app.inject({ method: 'POST', url: '/v1/dmarc/reports', headers: authed(), payload: report(rid) });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().duplicate).toBe(true);

    const summary = await app.inject({ method: 'GET', url: '/v1/dmarc/summary?days=30', headers: { authorization: `Bearer ${cust.apiKey}` } });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().total_messages).toBeGreaterThanOrEqual(1250);
    expect(summary.json().pass_rate).toBeGreaterThan(0);
    expect(summary.json().latest_policy.p).toBe('quarantine');

    const sources = await app.inject({ method: 'GET', url: '/v1/dmarc/sources?days=30', headers: { authorization: `Bearer ${cust.apiKey}` } });
    expect(sources.statusCode).toBe(200);
    const spoof = sources.json().sources.find((s: any) => s.source_ip === '45.83.12.9');
    expect(spoof).toBeTruthy();
    expect(spoof.likely_spoof).toBe(true); // 250 msgs, 0 aligned
    expect(spoof.pass_rate).toBe(0);
    const legit = sources.json().sources.find((s: any) => s.source_ip === '209.85.220.41');
    expect(legit.likely_spoof).toBe(false);
    expect(legit.pass_rate).toBe(1);
  });

  it('ingests gzip-compressed reports over the API', async () => {
    const gz = zlib.gzipSync(Buffer.from(report(`gz-${Date.now()}`)));
    const res = await app.inject({
      method: 'POST', url: '/v1/dmarc/reports',
      headers: { authorization: `Bearer ${cust.apiKey}`, 'content-type': 'application/gzip' },
      payload: gz,
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects an unsafe report body with 422', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/dmarc/reports', headers: authed(),
      payload: `<!DOCTYPE feedback [<!ENTITY x "y">]><feedback></feedback>`,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('unsafe_xml');
  });

  it('keeps reports tenant-isolated', async () => {
    const other = await seedCustomer();
    const summary = await app.inject({ method: 'GET', url: '/v1/dmarc/summary?days=30', headers: { authorization: `Bearer ${other.apiKey}` } });
    expect(summary.json().total_messages).toBe(0); // sees none of cust's reports
  });
});

describe('scanner: DMARC-enforced-but-SPF-broken compound finding', () => {
  function resolver(zones: { txt?: Record<string, string[]> }): ScanResolver {
    return {
      async resolveTxt(h) { const r = zones.txt?.[h]; if (!r) throw Object.assign(new Error('NX'), { code: 'ENOTFOUND' }); return r.map((x) => [x]); },
      async resolveMx() { throw Object.assign(new Error('NX'), { code: 'ENOTFOUND' }); },
      async resolve4() { throw Object.assign(new Error('NX'), { code: 'ENOTFOUND' }); },
    };
  }

  it('flags the Vanda pattern (p=quarantine + no SPF) as a top critical', async () => {
    const report = await scanDomain('vanda.example', {
      resolver: resolver({ txt: { '_dmarc.vanda.example': ['v=DMARC1; p=quarantine; rua=mailto:x@vanda.example'] } }),
      checkBlocklists: false,
    });
    expect(report.issues[0]!.code).toBe('dmarc_enforced_spf_broken');
    expect(report.issues[0]!.severity).toBe('critical');
    expect(report.remediation.join(' ')).toMatch(/fix SPF\/DKIM/i);
  });

  it('gives a staged rollout plan when DMARC is missing', async () => {
    const report = await scanDomain('none.example', {
      resolver: resolver({ txt: { 'none.example': ['v=spf1 include:_spf.google.com -all'], '_spf.google.com': ['v=spf1 ip4:1.2.3.4 -all'] } }),
      checkBlocklists: false,
    });
    expect(report.remediation[0]).toMatch(/p=none/i);
    expect(report.remediation.some((r) => /quarantine.*reject|reject/i.test(r))).toBe(true);
  });
});
