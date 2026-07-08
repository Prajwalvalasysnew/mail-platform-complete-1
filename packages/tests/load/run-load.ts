// In-process load harness for the /v1/send accept path.
//
// Boots the REAL API (same wiring as the e2e harness) on a real TCP port, seeds
// a customer + verified domain, then drives concurrent send traffic at stepped
// concurrency levels. Reports throughput (req/s), latency percentiles, and the
// status-code breakdown so you can see where the synchronous accept path
// saturates and which dependency (Postgres vs Redis) is the limiter.
//
// This does NOT replace a distributed k6 test against a production-like cluster
// (see infra/loadtest/send.js for that). It measures single-process server-side
// cost — which is exactly what reveals DB/Redis hot spots and the per-request
// floor — without network/cluster noise.
//
// Run:
//   cd packages/tests && set -a; . ../../.env.test; set +a; \
//     npx tsx load/run-load.ts
//
// Optional env: LOAD_LEVELS=10,25,50,100  LOAD_SECONDS=8  LOAD_BODY_BYTES=2048

import { request } from 'undici';
import { startHarness, seedCustomer, seedVerifiedDomain, resetQuota } from '../e2e/harness.js';

interface LevelResult {
  concurrency: number;
  durationS: number;
  total: number;
  accepted: number;
  rateLimited: number;
  errors: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function runLevel(
  baseUrl: string,
  apiKey: string,
  fromDomain: string,
  bodyBytes: number,
  concurrency: number,
  durationS: number
): Promise<LevelResult> {
  const latencies: number[] = [];
  let accepted = 0;
  let rateLimited = 0;
  let errors = 0;
  let total = 0;
  const filler = 'x'.repeat(Math.max(0, bodyBytes));
  const deadline = Date.now() + durationS * 1000;

  async function worker(workerId: number) {
    let iter = 0;
    while (Date.now() < deadline) {
      const body = JSON.stringify({
        from: `sender@${fromDomain}`,
        to: `r${workerId}-${iter}@example.com`,
        subject: 'Load test',
        text: filler,
        tags: ['loadtest'],
      });
      const start = process.hrtime.bigint();
      try {
        const res = await request(`${baseUrl}/v1/send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body,
        });
        await res.body.dump();
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        latencies.push(ms);
        total++;
        if (res.statusCode === 202) accepted++;
        else if (res.statusCode === 429) rateLimited++;
        else errors++;
      } catch {
        errors++;
        total++;
      }
      iter++;
    }
  }

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i));
  const wallStart = Date.now();
  await Promise.all(workers);
  const wallS = (Date.now() - wallStart) / 1000;

  latencies.sort((a, b) => a - b);
  return {
    concurrency,
    durationS: Number(wallS.toFixed(1)),
    total,
    accepted,
    rateLimited,
    errors,
    rps: Number((total / wallS).toFixed(0)),
    p50: Number(percentile(latencies, 50).toFixed(1)),
    p95: Number(percentile(latencies, 95).toFixed(1)),
    p99: Number(percentile(latencies, 99).toFixed(1)),
    max: Number((latencies[latencies.length - 1] ?? 0).toFixed(1)),
  };
}

async function main() {
  const levels = (process.env.LOAD_LEVELS ?? '10,25,50,100').split(',').map((n) => parseInt(n, 10));
  const durationS = Number(process.env.LOAD_SECONDS ?? 6);
  const bodyBytes = Number(process.env.LOAD_BODY_BYTES ?? 1024);

  console.log('Booting API + send worker in-process…');
  const h = await startHarness();

  // Listen on a real port so we measure true HTTP through the event loop.
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = h.app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Seed a customer with generous quota so quota isn't the limiter (we want to
  // measure pipeline throughput, not quota rejection).
  const cust = await seedCustomer({ dailyQuota: 100_000_000, monthlyQuota: 1_000_000_000, scopes: ['send'] });
  const domain = await seedVerifiedDomain(cust.customerId);
  await resetQuota(cust.customerId);

  console.log(`API at ${baseUrl}  | body=${bodyBytes}B  | ${durationS}s per level\n`);
  console.log('conc |   rps | accepted | 429 | err | p50ms | p95ms | p99ms | max');
  console.log('-----+-------+----------+-----+-----+-------+-------+-------+------');

  const results: LevelResult[] = [];
  for (const c of levels) {
    // small settle between levels
    await new Promise((r) => setTimeout(r, 300));
    const r = await runLevel(baseUrl, cust.apiKey, domain, bodyBytes, c, durationS);
    results.push(r);
    console.log(
      `${String(c).padStart(4)} | ${String(r.rps).padStart(5)} | ${String(r.accepted).padStart(8)} | ${String(r.rateLimited).padStart(3)} | ${String(r.errors).padStart(3)} | ${String(r.p50).padStart(5)} | ${String(r.p95).padStart(5)} | ${String(r.p99).padStart(5)} | ${String(r.max).padStart(4)}`
    );
  }

  // Find the knee: where rps stops scaling with concurrency.
  let knee = results[0];
  for (const r of results) if (r.rps > (knee?.rps ?? 0)) knee = r;
  console.log(`\nPeak throughput: ~${knee?.rps} req/s at concurrency ${knee?.concurrency} (p99 ${knee?.p99}ms).`);
  console.log('Note: single Node process + single local Postgres/Redis. Horizontal scaling multiplies this.');

  await h.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('load harness failed:', err);
  process.exit(1);
});
