// k6 load test for the open/click tracker.
//
// Run:
//   k6 run -e TRACKER_URL=http://localhost:4000 infra/loadtest/tracker.js
//
// The tracker is on the hot path for every opened/clicked email, so it must
// absorb high, spiky read volume and always return fast (a slow pixel delays
// mail rendering in the client). It returns a 1x1 GIF even for unknown tokens
// (never leaks whether a token is valid), so this scenario drives synthetic
// tokens and asserts throughput + latency rather than tracking correctness —
// that is covered by the e2e bot-detection suite.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import encoding from 'k6/encoding';

const TRACKER_URL = __ENV.TRACKER_URL || 'http://localhost:4000';
const UNKNOWN_LINK_ID = '00000000-0000-0000-0000-000000000000';

export const options = {
  // Spiky read profile: opens arrive in bursts when a campaign lands.
  stages: [
    { duration: '30s', target: 100 },
    { duration: '2m',  target: 400 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    // The pixel must be fast: p99 < 150ms, p95 < 75ms.
    http_req_duration: ['p(99)<150', 'p(95)<75'],
    // The tracker must always answer (pixel/redirect), even for unknown tokens.
    'checks{check:answered}': ['rate>0.995'],
    'http_req_failed': ['rate<0.01'],
  },
};

const openLatency = new Trend('mp_open_ms');
const clickLatency = new Trend('mp_click_ms');

// A synthetic, URL-safe token. Invalid tokens still get a pixel (no leak), so
// this exercises the full decode + fast-path without needing a real message.
function token() {
  // The tracker accepts a canonical base64url-encoded RFC 5322 Message-ID.
  // Using arbitrary URL-safe strings exercises malformed-input logging rather
  // than the normal unknown-message fast path and makes every click a 400.
  const messageId = `load-${__VU}-${__ITER}-${Math.random().toString(36).slice(2, 10)}@load.test`;
  return encoding.b64encode(messageId, 'rawurl');
}

export default function () {
  const encoded = token();
  const open = http.get(`${TRACKER_URL}/o/${encoded}`, {
    redirects: 0,
    tags: { name: '/o/:encoded' },
    responseCallback: http.expectedStatuses(200, 302, 404),
  });
  check(open, { 'answered': (r) => r.status === 200 || r.status === 302 || r.status === 404 });
  openLatency.add(open.timings.duration);

  const click = http.get(`${TRACKER_URL}/c/${encoded}/${UNKNOWN_LINK_ID}`, {
    redirects: 0,
    tags: { name: '/c/:encoded/:linkId' },
    responseCallback: http.expectedStatuses(200, 302, 404),
  });
  check(click, { 'answered': (r) => r.status === 200 || r.status === 302 || r.status === 404 });
  clickLatency.add(click.timings.duration);

  sleep(0.05);
}
