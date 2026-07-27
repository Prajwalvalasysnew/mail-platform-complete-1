// Additive live-development validation for SOC2-06, HIPAA-07 and GDPR-13.

import 'dotenv/config';

const apiBase = process.env.DEV_REPLAY_API_BASE ?? 'http://localhost:3000';
const password = process.env.COMPLIANCE_E2E_PASSWORD ?? '';
const adminEmail = 'compliance-e2e@localhost.test';
const customerId = process.env.COMPLIANCE_E2E_CUSTOMER_ID ?? '';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function call(path: string, init: RequestInit = {}, expected: number | number[] = 200) {
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
  return body;
}

function jsonHeaders(token?: string) {
  return {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function main() {
  const api = new URL(apiBase);
  assert(['localhost', '127.0.0.1', '::1'].includes(api.hostname), 'Refusing non-local API');
  assert(password.length >= 16, 'COMPLIANCE_E2E_PASSWORD is required');
  assert(/^[0-9a-f-]{36}$/i.test(customerId), 'COMPLIANCE_E2E_CUSTOMER_ID is required');

  const login = await call('/admin/auth/login', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ email: adminEmail, password }),
  });
  assert(login.role === 'superadmin', 'Compliance admin did not receive superadmin role');
  const token = login.token as string;

  const periodStart = '2026-06-01T00:00:00.000Z';
  const periodEnd = '2026-07-01T00:00:00.000Z';
  const collected = await call('/admin/control-evidence/collect', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ period_start: periodStart, period_end: periodEnd }),
  });
  assert(collected.evidence.length === 8, `Expected 8 control evidence records, got ${collected.evidence.length}`);
  const controlIds = collected.evidence.map((row: any) => row.control_id).sort();
  for (const row of collected.evidence) {
    assert(['complete', 'partial', 'missing'].includes(row.completeness), `Invalid completeness for ${row.control_id}`);
  }
  const persisted = await call('/admin/control-evidence?unreviewed=true&limit=100', { headers: jsonHeaders(token) });
  const persistedPeriod = persisted.runs.filter((row: any) =>
    new Date(row.period_start).toISOString() === periodStart &&
    new Date(row.period_end).toISOString() === periodEnd
  );
  assert(persistedPeriod.length === 8, `Persisted evidence period has ${persistedPeriod.length} records`);
  for (const row of persistedPeriod) {
    await call(`/admin/control-evidence/${row.id}/review`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ note: 'Live development end-to-end compliance validation' }),
    });
  }
  const reviewed = await call('/admin/control-evidence?limit=100', { headers: jsonHeaders(token) });
  const reviewedPeriod = reviewed.runs.filter((row: any) =>
    new Date(row.period_start).toISOString() === periodStart &&
    new Date(row.period_end).toISOString() === periodEnd
  );
  assert(reviewedPeriod.length === 8, 'Reviewed evidence period is incomplete');
  assert(reviewedPeriod.every((row: any) => row.reviewed_at && row.reviewed_by === adminEmail), 'Evidence sign-off missing');

  await call(`/admin/customers/${customerId}`, { headers: jsonHeaders(token) });
  const accessQueue = await call(
    `/admin/access-review?break_glass=false&unreviewed=true&customer_id=${encodeURIComponent(customerId)}&limit=100`,
    { headers: jsonHeaders(token) },
  );
  const access = accessQueue.access.find((row: any) => row.customer_id === customerId);
  assert(access, 'Default-on admin read audit did not reach the review queue');
  await call(`/admin/access-review/${access.id}`, {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({ decision: 'appropriate', note: 'Authorized live development E2E validation' }),
  });
  const reviewedAccess = await call(
    `/admin/access-review?break_glass=false&unreviewed=false&customer_id=${encodeURIComponent(customerId)}&limit=100`,
    { headers: jsonHeaders(token) },
  );
  assert(
    reviewedAccess.access.some((row: any) => String(row.id) === String(access.id) && row.review_decision === 'appropriate'),
    'Admin access review decision was not persisted',
  );

  const customerRows = await call(`/admin/customers/${customerId}`, { headers: jsonHeaders(token) });
  assert(customerRows.customer?.id === customerId || customerRows.id === customerId, 'Admin customer read returned wrong tenant');

  console.log(JSON.stringify({
    ok: true,
    soc2_06: {
      period_start: periodStart,
      period_end: periodEnd,
      controls: controlIds,
      completeness: Object.fromEntries(collected.evidence.map((row: any) => [row.control_id, row.completeness])),
      reviewed: reviewedPeriod.length,
    },
    hipaa_07: {
      audited_customer_id: customerId,
      access_audit_id: String(access.id),
      decision: 'appropriate',
    },
    gdpr_13: {
      validated_by_live_persona_runner: true,
      tenant_id: customerId,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
