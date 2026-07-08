// k6 load test for the send pipeline.
//
// Run:
//   k6 run -e API_URL=http://localhost:3000 -e API_KEY=mp_test_... infra/loadtest/send.js
//
// Uses a test-mode key (mp_test_) by default so the test exercises the full
// stack — auth, quota, abuse, queue admission — without sending real mail or
// touching IP reputation. Switch to a live key only against a controlled env.
//
// The thresholds below are the SLO contract: if any fails, the load test
// fails CI and the build is rejected.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const API_URL = __ENV.API_URL || 'http://localhost:3000';
const API_KEY = __ENV.API_KEY || 'mp_test_REPLACE_ME';

export const options = {
  // Two-stage ramp: warm up to 50 RPS, then sustain at 200 RPS for 2 min.
  stages: [
    { duration: '30s', target: 50 },
    { duration: '2m',  target: 200 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    // 99% of accepted sends must complete in < 500ms (synchronous accept path).
    http_req_duration: ['p(99)<500', 'p(95)<250'],
    // Acceptance rate must stay above 99% (allows for rare 429 under backpressure).
    'checks{check:accepted}': ['rate>0.99'],
    // No 5xx at all under steady-state load.
    'http_req_failed': ['rate<0.01'],
  },
};

const acceptedLatency = new Trend('mp_send_accept_ms');
const rateLimited = new Counter('mp_rate_limited');

export default function () {
  const payload = JSON.stringify({
    from: 'sender@verified.example.com',
    to: `recipient+${__VU}-${__ITER}@example.com`,
    subject: 'Load test message',
    text: 'This is a transactional message body.',
    tags: ['loadtest'],
  });
  const params = {
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      // Idempotency keys make retries safe; here we just give each request a unique one.
      'Idempotency-Key': `lt-${__VU}-${__ITER}-${Date.now()}`,
    },
  };
  const res = http.post(`${API_URL}/v1/send`, payload, params);
  check(res, {
    'accepted': (r) => r.status === 202,
  });
  if (res.status === 202) acceptedLatency.add(res.timings.duration);
  if (res.status === 429) rateLimited.add(1);
  sleep(0.1);
}
