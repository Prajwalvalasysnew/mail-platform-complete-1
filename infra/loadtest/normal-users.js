// Realistic customer load model for the mail platform.
//
// Unlike send.js (a saturation test), this script models two ordinary sources
// of traffic:
//   1. people opening the customer dashboard, reading metrics, and navigating;
//   2. customer applications sending transactional mail at a steady low rate.
//
// It creates a short-lived test-mode API key during setup and revokes it during
// teardown. Test-mode sends exercise validation, quota, persistence, and queue
// admission without delivering mail or affecting sender reputation.
//
// Example with Docker Desktop:
//   docker run --rm -i \
//     -v "$PWD/infra/loadtest:/scripts" \
//     -e API_URL=http://host.docker.internal:3000 \
//     -e LOAD_USER_EMAIL=user@example.test \
//     -e LOAD_USER_PASSWORD=... \
//     -e FROM_ADDRESS=sender@verified.example.test \
//     grafana/k6 run /scripts/normal-users.js

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const API_URL = (__ENV.API_URL || 'http://localhost:3000').replace(/\/$/, '');
const LOAD_DURATION = __ENV.LOAD_DURATION || '1m';
const DASHBOARD_VUS = positiveInt(__ENV.DASHBOARD_VUS, 3);
const SEND_RATE = positiveInt(__ENV.SEND_RATE, 1);
const MAX_SEND_VUS = positiveInt(__ENV.MAX_SEND_VUS, Math.max(5, SEND_RATE * 2));

const journeyFailures = new Counter('normal_user_journey_failures');
const rateLimited = new Counter('normal_user_rate_limited');
const dashboardLatency = new Trend('normal_user_dashboard_ms', true);
const sendLatency = new Trend('normal_user_send_ms', true);
const successfulRequests = new Rate('normal_user_success');
const loggedFailures = {};

export const options = {
  scenarios: {
    dashboard_users: {
      executor: 'ramping-vus',
      exec: 'dashboardJourney',
      startVUs: 0,
      stages: [
        { duration: '10s', target: DASHBOARD_VUS },
        { duration: LOAD_DURATION, target: DASHBOARD_VUS },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '10s',
      tags: { workload: 'dashboard' },
    },
    transactional_sends: {
      executor: 'constant-arrival-rate',
      exec: 'sendJourney',
      rate: SEND_RATE,
      timeUnit: '1s',
      duration: LOAD_DURATION,
      preAllocatedVUs: Math.max(2, SEND_RATE),
      maxVUs: MAX_SEND_VUS,
      startTime: '5s',
      gracefulStop: '15s',
      tags: { workload: 'transactional_send' },
    },
  },
  thresholds: {
    normal_user_success: ['rate>0.99'],
    normal_user_journey_failures: ['count<1'],
    'http_req_failed{workload:dashboard}': ['rate<0.01'],
    'http_req_duration{workload:dashboard}': ['p(95)<750', 'p(99)<1500'],
    'http_req_failed{workload:transactional_send}': ['rate<0.01'],
    'http_req_duration{workload:transactional_send}': ['p(95)<1000', 'p(99)<2000'],
    dropped_iterations: ['count<1'],
  },
};

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function jsonHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function parseJson(response) {
  try {
    return response.json();
  } catch (_) {
    return {};
  }
}

function record(response, expected, label) {
  const ok = check(response, {
    [`${label}: HTTP ${expected}`]: (r) => r.status === expected,
  });
  successfulRequests.add(ok);
  if (response.status === 429) rateLimited.add(1);
  if (!ok) {
    journeyFailures.add(1, { operation: label, status: String(response.status) });
    // One diagnostic per VU/operation keeps failures actionable without
    // flooding the output during a sustained rejection window.
    if (!loggedFailures[label]) {
      loggedFailures[label] = true;
      console.warn(`${label} failed: HTTP ${response.status} ${String(response.body || '').slice(0, 500)}`);
    }
  }
  return ok;
}

function assertSafeTarget() {
  const match = API_URL.match(/^https?:\/\/([^/:]+)/i);
  const hostname = match ? match[1].toLowerCase() : '';
  const localHosts = ['localhost', '127.0.0.1', '::1', 'host.docker.internal'];
  if (!localHosts.includes(hostname) && __ENV.ALLOW_REMOTE_LOAD !== '1') {
    throw new Error(`Refusing non-local load target ${API_URL}; set ALLOW_REMOTE_LOAD=1 intentionally.`);
  }
}

export function setup() {
  assertSafeTarget();
  const email = __ENV.LOAD_USER_EMAIL;
  const password = __ENV.LOAD_USER_PASSWORD;
  if (!email || !password) {
    throw new Error('LOAD_USER_EMAIL and LOAD_USER_PASSWORD are required.');
  }

  const login = http.post(
    `${API_URL}/v1/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' }, tags: { operation: 'setup_login' } },
  );
  if (login.status !== 200) throw new Error(`Load-user login failed (${login.status}): ${login.body}`);
  const sessionToken = parseJson(login).token;
  if (!sessionToken) throw new Error('Load-user login returned no session token.');

  let apiKey = __ENV.API_KEY;
  let temporaryKeyId = null;
  if (apiKey && !apiKey.startsWith('mp_test_') && __ENV.ALLOW_LIVE_SEND !== '1') {
    throw new Error('API_KEY must be an mp_test_ key unless ALLOW_LIVE_SEND=1 is explicitly set.');
  }

  if (!apiKey) {
    const created = http.post(
      `${API_URL}/v1/account/api-keys`,
      JSON.stringify({
        name: `normal-user-load-${Date.now()}`,
        key_type: 'test',
        scopes: ['send', 'messages', 'domains', 'templates', 'suppressions'],
        expires_in_days: 1,
      }),
      { headers: jsonHeaders(sessionToken), tags: { operation: 'setup_key' } },
    );
    if (created.status !== 201) throw new Error(`Temporary test-key creation failed (${created.status}): ${created.body}`);
    const keyBody = parseJson(created);
    apiKey = keyBody.api_key;
    temporaryKeyId = keyBody.id;
  }

  const domainResponse = http.get(`${API_URL}/v1/domains`, {
    headers: jsonHeaders(apiKey),
    tags: { operation: 'setup_domains' },
  });
  if (domainResponse.status !== 200) throw new Error(`Domain lookup failed (${domainResponse.status}): ${domainResponse.body}`);
  const domains = parseJson(domainResponse).domains || [];
  const requestedFrom = __ENV.FROM_ADDRESS;
  const verified = domains.find((row) => row.verified_at || (row.dkim_verified && row.spf_verified));
  const fromAddress = requestedFrom || (verified ? `load@${verified.domain}` : '');
  if (!fromAddress) throw new Error('No verified domain found; pass FROM_ADDRESS for this load user.');

  return { apiKey, sessionToken, temporaryKeyId, fromAddress };
}

export function dashboardJourney(data) {
  group('dashboard overview', () => {
    const started = Date.now();
    const responses = http.batch([
      ['GET', `${API_URL}/v1/auth/me`, null, { headers: jsonHeaders(data.sessionToken), tags: { operation: 'auth_me' } }],
      ['GET', `${API_URL}/v1/usage/quota`, null, { headers: jsonHeaders(data.apiKey), tags: { operation: 'quota' } }],
      ['GET', `${API_URL}/v1/messages?limit=25`, null, { headers: jsonHeaders(data.apiKey), tags: { operation: 'messages' } }],
      ['GET', `${API_URL}/v1/messages/activity?limit=25&days=7`, null, { headers: jsonHeaders(data.apiKey), tags: { operation: 'activity' } }],
      ['GET', `${API_URL}/v1/analytics/summary?period=24h`, null, { headers: jsonHeaders(data.apiKey), tags: { operation: 'analytics_summary' } }],
    ]);
    ['auth/me', 'quota', 'messages', 'activity', 'analytics'].forEach((label, index) => {
      record(responses[index], 200, label);
    });
    dashboardLatency.add(Date.now() - started);
  });

  // A user pauses to read the overview before opening one secondary page.
  sleep(1.5 + Math.random() * 3.5);
  const choice = Math.random();
  let path;
  let label;
  if (choice < 0.30) {
    path = '/v1/analytics/timeseries?period=7d&granularity=day';
    label = 'analytics timeseries';
  } else if (choice < 0.52) {
    path = '/v1/usage?days=30';
    label = 'usage history';
  } else if (choice < 0.70) {
    path = '/v1/domains';
    label = 'domains';
  } else if (choice < 0.86) {
    path = '/v1/templates';
    label = 'templates';
  } else {
    path = '/v1/suppressions?limit=25';
    label = 'suppressions';
  }
  const page = http.get(`${API_URL}${path}`, {
    headers: jsonHeaders(data.apiKey),
    tags: { operation: label.replace(/ /g, '_') },
  });
  record(page, 200, label);
  sleep(2 + Math.random() * 5);
}

export function sendJourney(data) {
  const random = Math.random();
  const kind = random < 0.50 ? 'welcome' : random < 0.80 ? 'receipt' : 'password-reset';
  const unique = `${Date.now()}-${__VU}-${__ITER}-${Math.random().toString(36).slice(2, 8)}`;
  const subjects = {
    welcome: 'Welcome to your account',
    receipt: 'Your payment receipt',
    'password-reset': 'Reset your password',
  };
  const payload = JSON.stringify({
    from: data.fromAddress,
    to: `load-${kind}-${unique}@example.net`,
    subject: subjects[kind],
    text: `This is a realistic ${kind} transactional message generated by the normal-user load test.`,
    tags: ['loadtest', 'normal-user', kind],
    metadata: { load_test: 'normal-users', journey: kind },
  });
  const response = http.post(`${API_URL}/v1/send`, payload, {
    headers: {
      ...jsonHeaders(data.apiKey),
      'Idempotency-Key': `normal-load-${unique}`,
    },
    tags: { operation: 'transactional_send', message_kind: kind },
  });
  const ok = record(response, 202, 'transactional send');
  sendLatency.add(response.timings.duration, { message_kind: kind });

  // Normal integrations occasionally poll a newly accepted message, but most
  // trust webhooks. Keep this intentionally uncommon.
  if (ok && Math.random() < 0.20) {
    const body = parseJson(response);
    const messageId = body.message_ids && body.message_ids[0];
    if (messageId) {
      sleep(0.25 + Math.random() * 0.5);
      const status = http.get(`${API_URL}/v1/messages/${encodeURIComponent(messageId)}`, {
        headers: jsonHeaders(data.apiKey),
        tags: { operation: 'message_status' },
      });
      record(status, 200, 'message status');
    }
  }
}

export function teardown(data) {
  if (!data || !data.temporaryKeyId) return;
  const revoked = http.del(`${API_URL}/v1/account/api-keys/${data.temporaryKeyId}`, null, {
    // Do not advertise JSON when DELETE has no body; Fastify correctly rejects
    // an empty request carrying application/json.
    headers: authHeaders(data.sessionToken),
    tags: { operation: 'teardown_key' },
  });
  if (revoked.status !== 200) {
    console.warn(`Temporary load-test key cleanup failed (${revoked.status}).`);
  }
}
