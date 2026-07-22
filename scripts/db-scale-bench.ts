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
//   4. batched deletion of a million-row DMARC source-record backlog
//
// Prints a table and exits. Cleans up the bench tenant unless KEEP=1.
//
// Usage:
//   DATABASE_URL=postgres://... npx tsx scripts/db-scale-bench.ts [events] [messages] [dmarc-records] [partition-rows]
// Defaults: 2,000,000 events / 200,000 messages / 1,000,000 DMARC records /
// 500,000 partition rows. Run against a
// production-sized instance for numbers you can publish.

import { sql } from 'kysely';
import { db, closeDb } from '../packages/shared/src/db.js';
import { runRetention } from '../packages/shared/src/retention.js';
import { ensureEventPartitions } from '../packages/shared/src/partitions.js';
import { closeQueues } from '../packages/shared/src/queues.js';

const EVENTS = Number(process.argv[2] ?? 2_000_000);
const MESSAGES = Number(process.argv[3] ?? 200_000);
const DMARC_RECORDS = Number(process.argv[4] ?? 1_000_000);
const PARTITION_ROWS = Number(process.argv[5] ?? 500_000);

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
  const dmarcReportCount = Math.max(1, Math.ceil(DMARC_RECORDS / 10_000));

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
      exportRetentionDays: 36_500,
      dmarcRetentionDays: 36_500,
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
  await timed(`seed ${fmt(PARTITION_ROWS)} events into ancient partition`, () =>
    sql`
      INSERT INTO events (message_id, customer_id, event_type, payload, occurred_at)
      SELECT 'bench-old-' || g, ${cid}::uuid, 'delivered', '{}'::jsonb,
             timestamptz '2019-01-01' + (g % 2678400) * interval '1 second'
      FROM generate_series(1, ${sql.lit(PARTITION_ROWS)}) g
    `.execute(db),
  );
  await timed(`DETACH + DROP ancient partition (${fmt(PARTITION_ROWS)} rows)`, async () => {
    await sql`ALTER TABLE events DETACH PARTITION events_part_201901`.execute(db);
    await sql`DROP TABLE events_part_201901`.execute(db);
  });

  // ── 4. DMARC retention: many bounded parent reports, 1m child rows ─────
  await timed(`seed ${fmt(dmarcReportCount)} expired DMARC reports`, () =>
    sql`
      INSERT INTO dmarc_reports (
        customer_id, domain, org_name, report_id, date_range_begin,
        date_range_end, total_messages, aligned_messages
      )
      SELECT ${cid}::uuid, 'bench.example', 'bench-reporter.example',
             'bench-dmarc-' || ${cid} || '-' || g,
             now() - interval '401 days', now() - interval '400 days',
             10000, 10000
      FROM generate_series(1, ${sql.lit(dmarcReportCount)}) g
    `.execute(db),
  );
  await timed(`seed ${fmt(DMARC_RECORDS)} DMARC source records`, () =>
    sql`
      WITH reports AS (
        SELECT id, row_number() OVER (ORDER BY report_id) AS rn
        FROM dmarc_reports
        WHERE customer_id = ${cid}::uuid AND report_id LIKE 'bench-dmarc-%'
      )
      INSERT INTO dmarc_report_records (
        report_id, customer_id, domain, source_ip, message_count,
        disposition, dkim_result, spf_result, header_from, dmarc_pass
      )
      SELECT r.id, ${cid}::uuid, 'bench.example',
             '192.0.2.' || (1 + (g % 254)), 1,
             'none', 'pass', 'pass', 'bench.example', true
      FROM reports r
      CROSS JOIN LATERAL generate_series(
        1,
        LEAST(10000, ${sql.lit(DMARC_RECORDS)} - ((r.rn - 1) * 10000))::int
      ) g
    `.execute(db),
  );
  await timed('ANALYZE dmarc_reports, dmarc_report_records', () =>
    sql`ANALYZE dmarc_reports, dmarc_report_records`.execute(db),
  );
  const dmarcDelete = await timed('runRetention (DMARC >365d, batched)', () =>
    runRetention({
      dmarcRetentionDays: 365,
      messageBodyRetentionDays: 36_500,
      eventRetentionDays: 36_500,
      messageRetentionDays: 36_500,
      auditRetentionDays: 36_500,
      reviewQueueRetentionDays: 36_500,
      webhookLogRetentionDays: 36_500,
      blocklistRetentionDays: 36_500,
      outboxRetentionDays: 36_500,
      exportRetentionDays: 36_500,
    }),
  );
  console.log(
    `  → purged ${fmt(dmarcDelete.result.dmarc_records_purged)} records + ${fmt(dmarcDelete.result.dmarc_reports_purged)} reports ` +
    `(${Math.round(dmarcDelete.result.dmarc_records_purged / (dmarcDelete.ms / 1000)).toLocaleString()} records/s)`,
  );

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
  await closeQueues();
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeQueues().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(1);
});
