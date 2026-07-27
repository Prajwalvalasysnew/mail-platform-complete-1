// Additive regulated-workload validation against the real local development
// API, database and a real Enterprise account/live API key. It refuses test or
// remote targets and suspends every temporarily activated mode on exit.
import 'dotenv/config';
import {
  applySubscriptionState, closeDb, closeQueues, closeRedis, db,
  REQUIRED_PREREQUISITES, requestRegulatedWorkload, reviewPrerequisiteEvidence,
  reviewRegulatedWorkload, submitPrerequisiteEvidence,
  type RegulatedWorkloadMode,
} from '../packages/shared/src/index.js';

const apiBase = process.env.DEV_REPLAY_API_BASE ?? 'http://localhost:3003';
const databaseUrl = process.env.DATABASE_URL ?? '';
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let customerId = '';
const activated: RegulatedWorkloadMode[] = [];

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function safeTarget() {
  assert(process.env.DEV_REPLAY_CONFIRM === '1', 'Set DEV_REPLAY_CONFIRM=1');
  const api = new URL(apiBase);
  const database = new URL(databaseUrl);
  assert(['localhost', '127.0.0.1', '::1'].includes(api.hostname), 'Refusing non-local API');
  assert(['localhost', '127.0.0.1', '::1'].includes(database.hostname), 'Refusing non-local database');
  assert(database.port !== '5434' && !/test/i.test(database.pathname), 'Refusing test database');
}
async function call(path: string, init: RequestInit = {}, expected: number | number[] = 200) {
  const response = await fetch(`${apiBase}${path}`, init);
  const text = await response.text();
  let body: any = {};
  if (text) try { body = JSON.parse(text); } catch { body = text; }
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(response.status)) {
    throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${text}`);
  }
  return { status: response.status, body };
}
const headers = (token?: string) => ({
  'content-type': 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

async function activate(mode: RegulatedWorkloadMode) {
  await requestRegulatedWorkload(customerId, mode, `dev-live:${runId}`);
  for (const prerequisite of REQUIRED_PREREQUISITES[mode]) {
    const evidence = await submitPrerequisiteEvidence({
      customerId, mode, prerequisite,
      artifactUri: `https://synthetic-evidence.invalid/dev-only/${runId}/${mode}/${prerequisite}`,
      artifactSha256: 'd'.repeat(64), submittedBy: `dev-customer:${runId}`,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await reviewPrerequisiteEvidence({
      id: evidence.id, decision: 'approved', reviewedBy: `dev-independent-reviewer-${runId}@localhost`,
      note: 'Synthetic local-development evidence; never valid for production.',
    });
  }
  await reviewRegulatedWorkload({
    customerId, mode, decision: 'activate',
    reviewedBy: `dev-activation-reviewer-${runId}@localhost`,
    note: 'Temporary local end-to-end validation only.',
  });
  activated.push(mode);
}

async function main() {
  safeTarget();
  await call('/ready');
  const registered = await call('/v1/auth/register', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({
      email: `regulated-live-${runId}@local.test`,
      password: 'Regulated-Live-Password-123!',
      name: 'Regulated live owner', org_name: `Regulated live ${runId}`,
    }),
  }, 201);
  customerId = registered.body.customer_id;
  const session = registered.body.token;
  await call('/v1/auth/verify-email', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ token: registered.body._dev_email_verify_token }),
  });
  await applySubscriptionState({
    provider: 'stripe', provider_event_id: `evt_regulated_${runId}`,
    type: 'customer.subscription.updated', internal_customer_id: customerId,
    provider_subscription_id: `sub_regulated_${runId}`,
    plan_item_id: `si_regulated_${runId}`, price_id: 'price_enterprise', status: 'active',
  });
  const key = await call('/v1/account/api-keys', {
    method: 'POST', headers: headers(session),
    body: JSON.stringify({
      name: 'regulated live key', key_type: 'secret',
      scopes: ['send', 'messages', 'domains'],
    }),
  }, 201);
  const apiKey = key.body.api_key;
  assert(String(apiKey).startsWith('mp_live_'), 'Expected a live API key');
  await call('/v1/profile', {
    method: 'PATCH', headers: headers(apiKey),
    body: JSON.stringify({ physical_address: '1 Regulated Dev Way, Local City' }),
  });
  const domain = `regulated-${runId}.local.test`;
  await db.insertInto('sending_domains').values({
    customer_id: customerId, domain, dkim_selector: 'mail',
    dkim_public_key: 'dev-live-public', dkim_private_key: 'dev-live-private',
    verified_at: new Date(), dkim_verified: true, spf_verified: true, dmarc_verified: true,
  } as any).execute();

  await activate('hipaa');
  const ordinaryPhi = await call('/v1/send', {
    method: 'POST', headers: headers(apiKey),
    body: JSON.stringify({
      from: `records@${domain}`, to: 'patient@example.net', subject: 'Medical record',
      text: 'Patient date of birth is listed in this medical record.',
    }),
  }, 422);
  assert(ordinaryPhi.body.error === 'secure_portal_required', 'Ordinary PHI was not portal-gated');
  const securePhi = await call('/v1/secure-messages', {
    method: 'POST', headers: headers(apiKey),
    body: JSON.stringify({
      to: 'patient@example.net', mode: 'hipaa', subject: 'Medical record',
      text: 'Patient date of birth is listed in this medical record.', expires_hours: 1,
    }),
  }, 201);
  const accessedPhi = await call('/v1/secure-portal/access', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({
      portal_token: securePhi.body.portal_token, access_code: securePhi.body.access_code,
    }),
  });
  assert(accessedPhi.body.message.payload.text.includes('date of birth'), 'Secure PHI did not round-trip');
  const breachCase = await call('/v1/compliance/rights-cases', {
    method: 'POST', headers: headers(apiKey),
    body: JSON.stringify({ mode: 'hipaa', kind: 'breach_assessment', subject_ref: `patient-${runId}` }),
  }, 201);
  await call(`/v1/compliance/rights-cases/${breachCase.body.case.id}/hipaa-breach-assessment`, {
    method: 'POST', headers: headers(apiKey),
    body: JSON.stringify({
      nature_extent_risk: 'medium', unauthorized_person_risk: 'low',
      acquired_or_viewed: true, mitigation_completed: true, breach_presumed: true,
      analysis: 'Synthetic development incident analysis.',
    }),
  }, 201);

  await activate('ferpa');
  const amendment = await call('/v1/compliance/rights-cases', {
    method: 'POST', headers: headers(apiKey),
    body: JSON.stringify({ mode: 'ferpa', kind: 'amendment', subject_ref: `student-${runId}` }),
  }, 201);
  await call(`/v1/compliance/rights-cases/${amendment.body.case.id}/ferpa-amendment-outcome`, {
    method: 'POST', headers: headers(apiKey),
    body: JSON.stringify({
      hearing_offered: true, outcome: 'denied',
      statement: 'Synthetic disputed-record statement.',
    }),
  }, 201);
  await call('/v1/compliance/disclosures', {
    method: 'POST', headers: headers(apiKey),
    body: JSON.stringify({
      mode: 'ferpa', subject_ref: `student-${runId}`, recipient: 'synthetic-auditor',
      purpose: 'Development validation', authority: 'Synthetic school-official exception',
    }),
  }, 201);

  await activate('sec_finra');
  const archiveFailure = await call('/v1/send', {
    method: 'POST', headers: headers(apiKey),
    body: JSON.stringify({
      from: `broker@${domain}`, to: 'client@example.net',
      subject: 'Ordinary client communication', text: 'Please call the office tomorrow.',
    }),
  }, 503);
  assert(archiveFailure.body.error === 'regulated_archive_unavailable', 'SEC archive did not fail closed');

  console.log(JSON.stringify({
    ok: true, run_id: runId, customer_id: customerId,
    credential_type: 'live',
    hipaa: { ordinary_send_blocked: true, secure_portal_round_trip: true, breach_assessment: true },
    ferpa: { amendment_outcome: true, disclosure_accounting: true },
    sec_finra: { missing_real_archive_provider_failed_closed: true, accepted_messages: 0 },
  }, null, 2));
}

async function close() {
  if (customerId) {
    for (const mode of [...activated].reverse()) {
      await reviewRegulatedWorkload({
        customerId, mode, decision: 'suspend', reviewedBy: `dev-cleanup-${runId}@localhost`,
        note: 'Automatic suspension after synthetic local validation.',
      }).catch(() => undefined);
    }
  }
  await Promise.allSettled([closeQueues(), closeRedis(), closeDb()]);
}
main().then(close).catch(async (error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  await close();
  process.exitCode = 1;
});
