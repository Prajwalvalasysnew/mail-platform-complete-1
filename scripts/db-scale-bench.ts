// Data-layer scale benchmark (DATABASE_10_10_PLAN Phase 4.2).
//
// Seeds a large volume of messages/events for a throwaway tenant with
// server-side generate_series (no client round-trips), then measures the
// operations the plan claims are production-grade:
//
//   1. analytics summary GROUP BY over the seeded events (the PG fallback
//      path — the CH rollup path is O(rollup) by construction)
//   2. batched, hold-aware retention delete throughput (runRetention)
//   3. partition DROP of a fully-populated month (the O(1) claim)
//
// Prints a table and exits. Cleans up the bench tenant unless KEEP=1.
//
// Usage:
//   DATABASE_URL=postgres://... npx tsx scripts/db-scale-bench.ts [events] [messages]
// Defaults: 2,000,000 events / 200,000 messages. Run against a
// production-sized instance for numbers you can publish.

import { sql } from 'kysely';
import { db, closeDb, runRetention, ensureEventPartitions } from '../packages/shared/src/index.js';

const EVENTS = Number(process.argv[2] ?? 2_000_000);
const MESSAGES = Number(process.argv[3] ?? 200_000);

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  console.log(`  ${label}: ${(ms / 1000).toFixed(2)}s`);
  return { result, ms };
}

async function main() {
  console.log(`[bench] seeding ${fmt(MESSAGES)} messages + ${fmt(EVENTS)} events (server-side)`);

  const customer = await db
    .insertInto('customers')
    .values({
      email: `bench-${Date.now()}@example.com`,
      name: 'scale-bench',
      tier: 'paid',
      daily_quota: 1_000_000_000,
      monthly_quota: 1_000_000_000,
    } as any)
    .returning('id')
    .executeTakeFirstOrThrow();
  const cid = customer.id as string;

  // Make sure the current + recent month partitions exist for the spread.
  await ensureEventPartitions(3);

  // ── seed messages: spread over the last 55 days ─────────────────────────
  const seedMessages = await timed(`seed ${fmt(MESSAGES)} messages`, () =>
    sql`
      INSERT INTO messages (message_id, customer_id, from_address, to_address,
                            subject, status, ip_pool, attempts, queued_at)
      SELECT 'bench-' || ${cid} || '-' || g,
             ${cid}::uuid,
             'bench@bench.example.com',
             'rcpt-' || (g % 50000) || '@example.com',
             'bench message',
             'delivered',
             'transactional',
             1,
             now() - (g % 55) * interval '1 day' - (g % 86400) * interval '1 second'
      FROM generate_series(1, ${sql.lit(MESSAGES)}) g
    `.execute(db),
  );

  // ── seed events: ~EVENTS/MESSAGES per message, same spread ──────────────
  const perMsg = Math.max(1, Math.round(EVENTS / MESSAGES));
  await timed(`seed ${fmt(MESSAGES * perMsg)} events (${perMsg}/message)`, () =>
    sql`
      INSERT INTO events (message_id, customer_id, event_type, payload, occurred_at)
      SELECT 'bench-' || ${cid} || '-' || (1 + (g % ${sql.lit(MESSAGES)})),
             ${cid}::uuid,
             (ARRAY['queued','delivered','opened','clicked'])[1 + (g % 4)],
             '{}'::jsonb,
             now() - (g % 55) * interval '1 day' - (g % 86400) * interval '1 second'
      FROM generate_series(1, ${sql.lit(MESSAGES * perMsg)}) g
    `.execute(db),
  );

  await timed('ANALYZE messages, events', () => sql`ANALYZE messages, events`.execute(db));

  // ── 1. analytics summary over 30d (PG fallback path) ────────────────────
  await timed('analytics summary GROUP BY (30d window)', () =>
    sql`
      SELECT event_type, count(*) FROM events
      WHERE customer_id = ${cid}::uuid AND occurred_at >= now() - interval '30 days'
      GROUP BY event_type
    `.execute(db),
  );

  // ── 2. batched retention delete (events older than 30d ≈ half the set) ──
  const del = await timed('runRetention (events >30d, batched)', () =>
    runRetention({
      eventRetentionDays: 30,
      // Keep every other table out of the measurement:
      messageBodyRetentionDays: 36_500,
      messageRetentionDays: 36_500,
      auditRetentionDays: 36_500,
      reviewQueueRetentionDays: 36_500,
      webhookLogRetentionDays: 36_500,
      blocklistRetentionDays: 36_500,
      outboxRetentionDays: 36_500,
    }),
  );
  const purged = (del.result as { events_purged: number }).events_purged;
  console.log(
    `  → purged ${fmt(purged)} events (${Math.round(purged / (del.ms / 1000)).toLocaleString()} rows/s)`,
  );

  // ── 3. partition drop of a fully-populated ancient month ────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS events_part_201901 PARTITION OF events
    FOR VALUES FROM ('2019-01-01') TO ('2019-02-01')
  `.execute(db);
  await timed(`seed 500,000 events into ancient partition`, () =>
    sql`
      INSERT INTO events (message_id, customer_id, event_type, payload, occurred_at)
      SELECT 'bench-old-' || g, ${cid}::uuid, 'delivered', '{}'::jsonb,
             timestamptz '2019-01-01' + (g % 2678400) * interval '1 second'
      FROM generate_series(1, 500000) g
    `.execute(db),
  );
  await timed('DETACH + DROP ancient partition (500k rows)', async () => {
    await sql`ALTER TABLE events DETACH PARTITION events_part_201901`.execute(db);
    await sql`DROP TABLE events_part_201901`.execute(db);
  });

  // ── cleanup ──────────────────────────────────────────────────────────────
  if (process.env.KEEP !== '1') {
    await timed('cleanup bench tenant', async () => {
      await sql`DELETE FROM events WHERE customer_id = ${cid}::uuid`.execute(db);
      await sql`DELETE FROM messages WHERE customer_id = ${cid}::uuid`.execute(db);
      await sql`DELETE FROM customers WHERE id = ${cid}::uuid`.execute(db);
    });
  } else {
    console.log(`[bench] KEEP=1 — bench tenant ${cid} left in place`);
  }

  console.log('[bench] done');
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
