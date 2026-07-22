// DMARC monitoring API + scanner compound finding — e2e over live PG.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { buildTestApp, seedCustomer, type SeededCustomer } from './harness.js';
import { db, placeLegalHold, releaseLegalHold, runRetention, scanDomain, type ScanResolver } from '@platform/shared';

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

async function seedDmarcReport(customerId: string, daysAgo: number, recordCount = 2): Promise<string> {
  const end = new Date(Date.now() - daysAgo * 86_400_000);
  const row = await db.insertInto('dmarc_reports').values({
    customer_id: customerId,
    domain: 'retention.example',
    org_name: 'retention-reporter.example',
    report_id: `retention-${randomUUID()}`,
    date_range_begin: new Date(end.getTime() - 86_400_000),
    date_range_end: end,
    policy_p: 'reject',
    policy_sp: null,
    policy_pct: 100,
    policy_adkim: 'r',
    policy_aspf: 'r',
    total_messages: recordCount,
    aligned_messages: recordCount,
  }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('dmarc_report_records').values(
    Array.from({ length: recordCount }, (_, i) => ({
      report_id: row.id,
      customer_id: customerId,
      domain: 'retention.example',
      source_ip: `192.0.2.${i + 1}`,
      message_count: 1,
      disposition: 'none',
      dkim_result: 'pass',
      spf_result: 'pass',
      header_from: 'retention.example',
      spf_domain: 'retention.example',
      dkim_domain: 'retention.example',
      dmarc_pass: true,
    })),
  ).execute();
  return row.id;
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

  it('purges expired report records in bounded batches and keeps recent data', async () => {
    const oldId = await seedDmarcReport(cust.customerId, 400, 3);
    const recentId = await seedDmarcReport(cust.customerId, 30, 1);

    const result = await runRetention({ dmarcRetentionDays: 365, batchSize: 1 });

    expect(result.dmarc_records_purged).toBeGreaterThanOrEqual(3);
    expect(result.dmarc_reports_purged).toBeGreaterThanOrEqual(1);
    expect(await db.selectFrom('dmarc_reports').select('id').where('id', '=', oldId).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('dmarc_report_records').select('id').where('report_id', '=', oldId).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('dmarc_reports').select('id').where('id', '=', recentId).executeTakeFirst()).toBeTruthy();
  });

  it('preserves expired DMARC evidence under a tenant-wide legal hold', async () => {
    const heldReportId = await seedDmarcReport(cust.customerId, 400, 1);
    const hold = await placeLegalHold({ customerId: cust.customerId, scope: 'customer', reason: 'DMARC retention test' });

    const heldResult = await runRetention({ dmarcRetentionDays: 365, batchSize: 1 });
    expect(heldResult.held_rows_skipped).toBeGreaterThanOrEqual(2);
    expect(await db.selectFrom('dmarc_reports').select('id').where('id', '=', heldReportId).executeTakeFirst()).toBeTruthy();

    await releaseLegalHold(cust.customerId, hold.id, 'test');
    await runRetention({ dmarcRetentionDays: 365, batchSize: 1 });
    expect(await db.selectFrom('dmarc_reports').select('id').where('id', '=', heldReportId).executeTakeFirst()).toBeUndefined();
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
