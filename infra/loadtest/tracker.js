// k6 load test for the open/click tracker.
//
// Run:
//   k6 run -e TRACKER_URL=http://localhost:3002 infra/loadtest/tracker.js
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

const TRACKER_URL = __ENV.TRACKER_URL || 'http://localhost:3002';

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
  return `lt${__VU}x${__ITER}${Math.random().toString(36).slice(2, 10)}`;
}

export default function () {
  const open = http.get(`${TRACKER_URL}/o/${token()}`, { redirects: 0 });
  check(open, { 'answered': (r) => r.status === 200 || r.status === 302 || r.status === 404 });
  openLatency.add(open.timings.duration);

  const click = http.get(`${TRACKER_URL}/c/${token()}/link-0`, { redirects: 0 });
  check(click, { 'answered': (r) => r.status === 200 || r.status === 302 || r.status === 404 });
  clickLatency.add(click.timings.duration);

  sleep(0.05);
}
