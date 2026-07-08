# Load Test & Throughput Analysis

A real, in-process load harness was added (`packages/tests/load/run-load.ts`) that
boots the actual API + send worker on a TCP port and drives concurrent traffic
against `/v1/send`, reporting throughput, latency percentiles, and status-code
breakdown. This complements the distributed k6 script in `infra/loadtest/send.js`
(which needs a real cluster + the k6 binary).

## Method

- Single Node process, single local Postgres + Redis (so these numbers are a
  **per-process floor**, not a cluster ceiling — horizontal scaling multiplies them).
- Real HTTP through the event loop (not `inject`), so the event-loop cost under
  concurrency is included.
- Generous quota so the limiter measured is pipeline cost, not quota rejection.

## Headline numbers (single recipient, 1 KB body)

| concurrency | req/s | p50 | p95 | p99 |
|-------------|-------|-----|-----|-----|
| 10          | ~79   | 114 | 239 | 309 |
| 25          | ~136  | 180 | 221 | 235 |
| 50          | ~164  | 299 | 365 | 388 |

Peak ~**164 req/s per process** for the synchronous accept path. Latency rises
with concurrency (p50 114 → 299 ms), which says the accept path is doing real
per-request work and the single local Postgres is the shared limiter.

## The real finding: per-recipient round-trips (fixed)

The accept path screened recipients in a **sequential loop** — for each recipient
it `await`ed `isSuppressed()` (Redis GET + possible DB SELECT) and then
`isTrapOrDisposable()` (DB SELECT). A 1000-recipient send therefore issued up to
**~2000 sequential round-trips** before returning. Against a local DB that's
hundreds of ms; against a **remote** production DB at 1–2 ms RTT it would be
**3+ seconds per call** — the dominant bulk-send bottleneck.

**Fix:** added `isSuppressedBatch()` (one Redis MGET + one `email IN (...)` DB
query for misses) and `isTrapOrDisposableBatch()` (one `domain IN (...)` query
across the distinct domains), and rewrote the loop to use them. A
1000-recipient send now does **~3 round-trips total instead of ~2000**,
independent of recipient count.

Measured multi-recipient latency after the fix (single process, local DB):

| recipients in one call | median latency |
|------------------------|----------------|
| 100                    | ~176 ms        |
| 500                    | ~281 ms        |
| 1000                   | ~432 ms        |

Latency now grows sub-linearly with recipient count (the remaining growth is the
single bulk INSERT and body handling), versus the old linear ~2 round-trips ×
N behavior. Against a remote DB the improvement is far larger (round-trips are
the expensive part).

Also parallelized the two independent top-of-path lookups (sending-domain +
customer) with `Promise.all`, removing one serial round-trip from every send.

Correctness is covered by new parity tests in `suppression-softbounce.test.ts`
(batch results match the single-email path; trap/disposable across a mixed list).

## What this does and doesn't tell you

**Does:** the accept path is correct under concurrency, the bulk-send bottleneck
was per-recipient round-trips (now removed), and a single process sustains ~160
single-sends/s locally with a single Postgres.

**Doesn't:** this is not a cluster-scale test. SendGrid-grade throughput numbers
require running the k6 script against a production-like deployment (multiple API
replicas, HA Postgres with read replicas, Redis cluster) and measuring the
horizontal scaling curve, DB connection-pool saturation, and queue-drain rate of
the worker fleet under sustained load. That is Phase 2 infrastructure work.

## Recommended next steps (Phase 2, infra)

1. Run `infra/loadtest/send.js` (k6) against a staging cluster; capture the
   scaling curve (req/s vs API replica count) and the p99 SLO at target RPS.
2. Watch Postgres under load: connection-pool high-water mark (the pool is
   `max: 20` per process), slow-query log on the `messages` insert and the
   suppression/intel lookups, and index hit rates.
3. Size the worker fleet to the send-queue arrival rate; confirm the per-customer
   queue-depth backpressure (already implemented) holds fair-share under a noisy
   neighbor.
4. Add the `waitForStatus` test timeout headroom or serialize worker-bound e2e
   tests — they get tight under full-suite parallelism (transient, not a product
   bug, but worth hardening for CI stability).
