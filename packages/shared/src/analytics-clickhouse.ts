// ClickHouse-served analytics reads (DATABASE_10_10_PLAN Phase 4.1).
//
// The dashboard endpoints previously always ran GROUP BYs over the hot
// Postgres `events` table — the exact load the ClickHouse rollup exists to
// absorb. These helpers serve the day-granular windows (7d/30d) from
// `events_daily` (uniqExactMerge over the AggregatingMergeTree state, so
// counts are exact and immune to the dual-write duplication — see
// infra/clickhouse/init.sql).
//
// Every helper returns null on any failure or when ClickHouse is not
// configured; callers MUST fall back to the Postgres path. Postgres remains
// the source of truth — this is a read offload, not a migration.
//
// Boundary semantics: the rollup is per-day, so a "7d" window is served as
// "since <today-7> (whole days)" rather than Postgres's exact
// now()-interval. Dashboard-grade tradeoff, documented here on purpose.

import { clickhouseRequestHeaders } from './clickhouse.js';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

function dailyTable(): string {
  const base = process.env.EVENTS_CLICKHOUSE_TABLE ?? 'events';
  return process.env.EVENTS_CLICKHOUSE_DAILY_TABLE ?? `${base}_daily`;
}

async function chSelect<T>(query: string, params: Record<string, string>): Promise<T[] | null> {
  const base = process.env.EVENTS_CLICKHOUSE_URL;
  if (!base) return null;
  const url = new URL('/', base);
  url.searchParams.set('query', `${query} FORMAT JSON`);
  url.searchParams.set('default_format', 'JSON');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, v);
  try {
    const res = await fetch(url, { method: 'POST', headers: clickhouseRequestHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const json = (await res.json()) as { data?: T[] };
    return json.data ?? [];
  } catch (err: any) {
    console.error(`[clickhouse] analytics query failed (falling back to Postgres): ${err?.message ?? err}`);
    return null;
  }
}

/** YYYY-MM-DD (UTC) for "days back from now", used as the rollup's day floor. */
export function chSinceDay(days: number, notBefore?: Date | null): string {
  let since = new Date(Date.now() - days * 86_400_000);
  if (notBefore && notBefore.getTime() > since.getTime()) since = notBefore;
  return since.toISOString().slice(0, 10);
}

/**
 * Exact per-event-type counts for a tenant since a day (inclusive), from the
 * daily rollup. null → caller falls back to Postgres.
 */
export async function chSummaryCounts(
  customerId: string,
  sinceDay: string,
): Promise<Record<string, number> | null> {
  const table = dailyTable();
  if (!IDENT_RE.test(table)) return null;
  const rows = await chSelect<{ event_type: string; count: string | number }>(
    `SELECT event_type, uniqExactMerge(event_uniq) AS count FROM ${table} ` +
      `WHERE customer_id = {customer_id:String} AND day >= {since:Date} GROUP BY event_type`,
    { customer_id: customerId, since: sinceDay },
  );
  if (!rows) return null;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.event_type] = Number(r.count);
  return counts;
}

export interface ChDailySeriesRow {
  day: string;
  event_type: string;
  count: number;
}

/**
 * Per-day, per-event-type exact counts for a tenant since a day (inclusive).
 * null → caller falls back to Postgres.
 */
export async function chDailySeries(
  customerId: string,
  sinceDay: string,
): Promise<ChDailySeriesRow[] | null> {
  const table = dailyTable();
  if (!IDENT_RE.test(table)) return null;
  const rows = await chSelect<{ day: string; event_type: string; count: string | number }>(
    `SELECT day, event_type, uniqExactMerge(event_uniq) AS count FROM ${table} ` +
      `WHERE customer_id = {customer_id:String} AND day >= {since:Date} ` +
      `GROUP BY day, event_type ORDER BY day`,
    { customer_id: customerId, since: sinceDay },
  );
  if (!rows) return null;
  return rows.map((r) => ({ day: r.day, event_type: r.event_type, count: Number(r.count) }));
}
