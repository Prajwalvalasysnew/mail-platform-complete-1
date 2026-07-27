// E2E: GDPR-13 (compliance implementation plan) — Article 32 security of
// processing and Article 28(3) processor assistance.
//
// The tests worth having here are the ones that keep the schedule HONEST,
// because both ways of corrupting it produce a document that still looks fine:
//
//   * a measure that is merely switched on must never be reported as
//     "enforced" — a setting an operator can flip is a weaker assurance than a
//     property the code makes structurally true, and a controller relies on
//     that distinction to decide whether the processing is appropriately
//     secured;
//   * a measure that is OFF must be listed as such, never dropped. A schedule
//     containing only what a tenant has reads as complete and is not.
//
// If either regresses, the platform is making a security representation it
// cannot support — which is exactly the kind of statement a regulator revisits
// after a breach.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, seedCustomer } from './harness.js';
import {
  db,
  securityMeasures,
  processingRecord,
  assistanceCommitments,
  configuredIntegrations,
  ProcessorAssistanceError,
} from '@platform/shared';

let app: FastifyInstance;

beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); });

async function setFlags(customerId: string, flags: { tls_required?: boolean; sso_enforced?: boolean }) {
  await db.updateTable('customers').set(flags as never).where('id', '=', customerId).execute();
}

describe('GDPR-13: the Art 32 schedule does not over-claim', () => {
  it('never reports a configuration-derived measure as enforced, however it is set', async () => {
    const cust = await seedCustomer();
    await setFlags(cust.customerId, { tls_required: true, sso_enforced: true });

    const measures = await securityMeasures(cust.customerId);

    // This is the load-bearing assertion of the whole module. 'enforced' is a
    // claim that the platform makes the measure true by construction; a
    // switch that an operator can flip cannot support it, even while it is on.
    for (const m of measures) {
      if (m.derivation === 'configured') expect(m.state).not.toBe('enforced');
      if (m.derivation === 'policy') expect(m.state).toBe('policy_only');
      if (m.state === 'enforced') expect(m.derivation).toBe('structural');
    }

    // ...and specifically: TLS is on for this tenant and still is not 'enforced'.
    const tls = measures.find((m) => m.id === 'downstream_tls')!;
    expect(tls.state).toBe('configured');
  });

  it('lists measures that are off rather than omitting them', async () => {
    const cust = await seedCustomer();
    await setFlags(cust.customerId, { tls_required: false, sso_enforced: false });

    const measures = await securityMeasures(cust.customerId);
    const ids = measures.map((m) => m.id);

    // The failure this guards: a schedule that only lists what the tenant has.
    // It reads as complete, and the controller never learns what is missing.
    expect(ids).toContain('downstream_tls');
    expect(ids).toContain('sso_enforced');
    expect(measures.find((m) => m.id === 'downstream_tls')!.state).toBe('not_enabled');
    expect(measures.find((m) => m.id === 'sso_enforced')!.state).toBe('not_enabled');
  });

  it('returns the same set of measures regardless of tenant configuration', async () => {
    const on = await seedCustomer();
    const off = await seedCustomer();
    await setFlags(on.customerId, { tls_required: true, sso_enforced: true });
    await setFlags(off.customerId, { tls_required: false, sso_enforced: false });

    const a = (await securityMeasures(on.customerId)).map((m) => m.id).sort();
    const b = (await securityMeasures(off.customerId)).map((m) => m.id).sort();
    // Same schedule, different states — the shape of the document must not
    // depend on how much of it a tenant happens to satisfy.
    expect(a).toEqual(b);
  });

  it('reports data residency as not enabled, because it is not implemented', async () => {
    const cust = await seedCustomer();
    const residency = (await securityMeasures(cust.customerId)).find((m) => m.id === 'data_residency')!;
    // GDPR-11 is open. If someone implements region pinning, this test should
    // be updated deliberately — not silently satisfied by a config default.
    expect(residency.state).toBe('not_enabled');
    expect(residency.evidence).toMatch(/Not implemented/);
  });

  it('caveats the measures that are narrower than their names suggest', async () => {
    const cust = await seedCustomer();
    await setFlags(cust.customerId, { tls_required: true });
    const measures = await securityMeasures(cust.customerId);

    // Downstream TLS covers the first hop only; credential encryption covers
    // application-managed secrets, not the disk. Both read as broader than
    // they are without the caveat, so the caveat is part of the control.
    expect(measures.find((m) => m.id === 'downstream_tls')!.caveat).toMatch(/first hop/i);
    expect(measures.find((m) => m.id === 'credential_encryption')!.caveat).toMatch(/deployment responsibility/i);
    expect(measures.find((m) => m.id === 'backup_erasure_replay')!.caveat).toMatch(/procedure/i);
  });

  it('flags a tenant on platform-default retention as not having an agreed window', async () => {
    const cust = await seedCustomer();
    const retention = (await securityMeasures(cust.customerId)).find((m) => m.id === 'retention_limits')!;
    expect(retention.state).toBe('configured');
    expect(retention.caveat).toMatch(/platform defaults/i);
  });

  it('rejects an unknown tenant instead of producing an empty schedule', async () => {
    // An empty-but-successful schedule for a nonexistent tenant would be the
    // worst possible output: a document asserting no measures at all.
    await expect(securityMeasures('00000000-0000-0000-0000-000000000000'))
      .rejects.toBeInstanceOf(ProcessorAssistanceError);
  });
});

describe('GDPR-13: Art 28(3) assistance commitments name their mechanism', () => {
  it('ties every duty to something that delivers it', () => {
    const commitments = assistanceCommitments();
    expect(commitments.length).toBeGreaterThanOrEqual(6);
    // A commitment with no mechanism is a promise. Naming the endpoint or
    // runbook makes it checkable, and makes its removal visible.
    for (const c of commitments) {
      expect(c.delivered_by.length).toBeGreaterThan(20);
      expect(c.article).toMatch(/Art/);
    }
  });

  it('covers the rights, security, breach, DPIA, audit and return duties', () => {
    const articles = assistanceCommitments().map((c) => c.article).join(' ');
    expect(articles).toContain('28(3)(e)'); // rights assistance
    expect(articles).toContain('28(3)(f)'); // security
    expect(articles).toContain('33(2)');    // breach notification
    expect(articles).toContain('28(3)(g)'); // deletion / return
    expect(articles).toContain('28(3)(h)'); // demonstrate compliance
  });

  it('does not promise to notify the supervisory authority for the controller', () => {
    // Art 33(1) is the controller's duty, not the processor's. Promising it
    // would leave the controller believing a filing had been made.
    const breach = assistanceCommitments().find((c) => c.article.includes('33(2)'))!;
    expect(breach.delivered_by).toMatch(/does not notify the supervisory authority/i);
  });
});

describe('GDPR-13: configured integrations, not vendor names', () => {
  it('reports capabilities the deployment actually has', () => {
    const integrations = configuredIntegrations();
    // Mail transport always applies — it is what the platform is.
    expect(integrations.some((i) => /mail transport/i.test(i.integration))).toBe(true);
    // Every entry states what personal data reaches it, which is the part a
    // controller needs for their own Art 30 record.
    for (const i of integrations) expect(i.personal_data.length).toBeGreaterThan(0);
  });
});

describe('GDPR-13: the processing record over the API', () => {
  it('returns the record scoped to the calling tenant', async () => {
    const cust = await seedCustomer();
    await setFlags(cust.customerId, { tls_required: false });

    const res = await app.inject({
      method: 'GET', url: '/v1/privacy/processing-record',
      headers: { authorization: `Bearer ${cust.apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.controller_customer_id).toBe(cust.customerId);
    expect(body.processing.data_subjects.length).toBeGreaterThan(0);
    expect(body.processing.retention_in_effect.message_bodies_days).toBeGreaterThan(0);
    expect(body.security_measures.length).toBeGreaterThan(0);
    expect(body.assistance.length).toBeGreaterThan(0);
  });

  it('summarises the gaps instead of making the controller diff the list', async () => {
    const cust = await seedCustomer();
    await setFlags(cust.customerId, { tls_required: false, sso_enforced: false });

    const record = await processingRecord(cust.customerId);
    expect(record.summary.measures_total).toBe(record.security_measures.length);
    expect(record.summary.enforced + record.summary.configured
      + record.summary.not_enabled + record.summary.policy_only).toBe(record.summary.measures_total);
    expect(record.summary.not_enabled_ids).toContain('downstream_tls');
    expect(record.summary.not_enabled_ids).toContain('sso_enforced');
  });

  it('carries its own scope note, so the caveats cannot be separated from the data', async () => {
    const cust = await seedCustomer();
    const record = await processingRecord(cust.customerId);
    // This payload will be pasted into someone's DPIA. The limits travel with
    // it or they do not travel at all.
    expect(record.scope_note).toMatch(/not an independent assessment/i);
    expect(record.scope_note).toMatch(/not_enabled/);
  });

  it('does not leak one tenant\'s posture to another', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    await setFlags(a.customerId, { tls_required: true });
    await setFlags(b.customerId, { tls_required: false });

    const res = await app.inject({
      method: 'GET', url: '/v1/privacy/processing-record',
      headers: { authorization: `Bearer ${b.apiKey}` },
    });
    const body = res.json();
    expect(body.controller_customer_id).toBe(b.customerId);
    expect(body.security_measures.find((m: any) => m.id === 'downstream_tls').state).toBe('not_enabled');
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/privacy/processing-record' });
    expect(res.statusCode).toBe(401);
  });
});
