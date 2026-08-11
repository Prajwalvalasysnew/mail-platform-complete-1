// Event firehose sink. Postgres `events` won't scale past tens of millions of
// rows cheaply for analytics. This dual-writes events to ClickHouse (an
// append-only columnar store) when EVENTS_CLICKHOUSE_URL is configured; the
// Postgres write remains the source of truth for the operational hot path.
//
// Writes are best-effort and batched: a ClickHouse outage must never block or
// fail an event (we log and drop, since Postgres already has it). The buffer
// flushes when it reaches BATCH_SIZE rows OR after FLUSH_INTERVAL_MS,
// whichever comes first.
//
// Circuit breaker: after CIRCUIT_OPEN_THRESHOLD consecutive flush failures the
// circuit opens and all flush attempts are skipped (rows are still dropped).
// A half-open probe fires after CIRCUIT_RESET_MS; on success the circuit closes.

import { db } from './db.js';

export interface ClickhouseEvent {
  /**
   * The Postgres `events.id` — a globally-unique, monotonic idempotency key.
   * Both the hot-path dual-write and the reconciler emit the SAME event_id for
   * a given event, so ClickHouse (ReplacingMergeTree ordered by event_id, and a
   * uniqExact daily rollup) collapses the two inserts into one — no duplicate
   * analytics rows and no double-counting. Defaults to 0 only for legacy callers
   * that don't have the id yet.
   */
  event_id?: number;
  message_id: string;
  customer_id: string;
  event_type: string;
  occurred_at: string;
  ip?: string | null;
  payload?: Record<string, unknown>;
}

const URL_BASE = process.env.EVENTS_CLICKHOUSE_URL; // e.g. http://clickhouse:8123
const TABLE = process.env.EVENTS_CLICKHOUSE_TABLE ?? 'events';
const BATCH_SIZE = Number(process.env.EVENTS_CLICKHOUSE_BATCH_SIZE ?? 100);
const FLUSH_INTERVAL_MS = Number(process.env.EVENTS_CLICKHOUSE_FLUSH_MS ?? 1000);
const CIRCUIT_OPEN_THRESHOLD = 5;
const CIRCUIT_RESET_MS = 30_000;

export function clickhouseRequestHeaders(contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers['Content-Type'] = contentType;
  const user = process.env.EVENTS_CLICKHOUSE_USER;
  const password = process.env.EVENTS_CLICKHOUSE_PASSWORD;
  if (user) headers['X-ClickHouse-User'] = user;
  if (password) headers['X-ClickHouse-Key'] = password;
  return headers;
}

export function clickhouseEnabled(): boolean {
  return !!(process.env.EVENTS_CLICKHOUSE_URL ?? URL_BASE);
}

/** Remove rows whose message has a durable privacy-erasure tombstone. */
export async function filterNonErasedClickhouseRows<T extends { customer_id: string; message_id: string }>(rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows;
  const tombstones = await db.selectFrom('privacy_message_tombstones')
    .select(['customer_id', 'message_id'])
    .where((eb) => eb.or(rows.map((row) => eb.and([
      eb('customer_id', '=', row.customer_id),
      eb('message_id', '=', row.message_id),
    ]))))
    .execute();
  const blocked = new Set(tombstones.map((row) => `${row.customer_id}\0${row.message_id}`));
  return rows.filter((row) => !blocked.has(`${row.customer_id}\0${row.message_id}`));
}

/** Delete all analytics rows for one tenant/message and wait for replicas. */
export async function deleteClickhouseMessageEvents(customerId: string, messageId: string): Promise<void> {
  const urlBase = process.env.EVENTS_CLICKHOUSE_URL ?? URL_BASE;
  if (!urlBase) return;
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(TABLE)) throw new Error('invalid_clickhouse_table');
  const query = `ALTER TABLE ${TABLE} DELETE WHERE customer_id = {customer_id:String} AND message_id = {message_id:String}`;
  const url = new URL('/', urlBase);
  url.searchParams.set('query', query);
  url.searchParams.set('param_customer_id', customerId);
  url.searchParams.set('param_message_id', messageId);
  url.searchParams.set('mutations_sync', '2');
  const res = await fetch(url, { method: 'POST', headers: clickhouseRequestHeaders() });
  if (!res.ok) throw new Error(`clickhouse_delete_failed:${res.status}:${(await res.text().catch(() => '')).slice(0, 500)}`);
}

/**
 * Insert rows into ClickHouse synchronously and report success. Unlike the
 * fire-and-forget buffer, this AWAITS the result and returns false on failure,
 * so the reconciler can decide whether to advance its watermark. Used by
 * reconcileClickhouse(); the hot path still uses the batched buffer.
 */
export async function insertClickhouseRows(rows: Row[]): Promise<boolean> {
  // Read the URL dynamically (not the load-time constant) so it reflects the
  // current environment — important for tests that configure a stub endpoint,
  // and harmless in production where the env is fixed.
  const urlBase = process.env.EVENTS_CLICKHOUSE_URL ?? URL_BASE;
  if (!urlBase || rows.length === 0) return true;
  const body = rows.map(serializeClickhouseRow).join('\n');
  const url = `${urlBase}/?query=${encodeURIComponent(`INSERT INTO ${TABLE} FORMAT JSONEachRow`)}`;
  try {
    const res = await fetch(url, { method: 'POST', body, headers: clickhouseRequestHeaders('application/x-ndjson') });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    return true;
  } catch (err: any) {
    console.error(`[clickhouse] reconcile insert failed: ${err?.message ?? err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker state
// ---------------------------------------------------------------------------

let consecutiveFailures = 0;
let circuitOpenSince: number | null = null;

function circuitIsOpen(): boolean {
  if (circuitOpenSince === null) return false;
  // Allow a half-open probe after the reset window.
  if (Date.now() - circuitOpenSince >= CIRCUIT_RESET_MS) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Internal buffer + periodic flush
// ---------------------------------------------------------------------------

interface Row {
  event_id: number; // Postgres events.id — the ClickHouse dedup key
  message_id: string;
  customer_id: string;
  event_type: string;
  occurred_at: string;
  ip: string | null;
  payload: string; // JSON-serialised
}

function serializeClickhouseRow(row: Row): string {
  const occurredAt = new Date(row.occurred_at);
  const normalized = Number.isNaN(occurredAt.getTime())
    ? row.occurred_at
    : occurredAt.toISOString().replace('T', ' ').replace(/Z$/, '');
  return JSON.stringify({ ...row, occurred_at: normalized });
}

let buffer: Row[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flushBuffer(): Promise<void> {
  if (!URL_BASE || buffer.length === 0) return;
  if (circuitIsOpen()) {
    // Circuit open: drop and log so ops can alert on this rather than silent loss.
    console.error(`[clickhouse] circuit open — dropping ${buffer.length} events (ClickHouse unreachable for ${CIRCUIT_RESET_MS / 1000}s)`);
    buffer = [];
    return;
  }

  const rows = buffer.splice(0, buffer.length);
  const eligibleRows = await filterNonErasedClickhouseRows(rows);
  if (eligibleRows.length === 0) return;
  const body = eligibleRows.map(serializeClickhouseRow).join('\n');
  const url = `${URL_BASE}/?query=${encodeURIComponent(`INSERT INTO ${TABLE} FORMAT JSONEachRow`)}`;
  try {
    const res = await fetch(url, { method: 'POST', body, headers: clickhouseRequestHeaders('application/x-ndjson') });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    // Success: close circuit.
    if (consecutiveFailures > 0) {
      console.log(`[clickhouse] circuit closed after ${consecutiveFailures} failure(s)`);
    }
    consecutiveFailures = 0;
    circuitOpenSince = null;
  } catch (err: any) {
    consecutiveFailures++;
    console.error(`[clickhouse] flush failed (attempt ${consecutiveFailures}/${CIRCUIT_OPEN_THRESHOLD}): ${err?.message ?? err}`);
    if (consecutiveFailures >= CIRCUIT_OPEN_THRESHOLD && circuitOpenSince === null) {
      circuitOpenSince = Date.now();
      console.error(`[clickhouse] circuit opened — will retry in ${CIRCUIT_RESET_MS / 1000}s`);
    }
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushBuffer().catch(() => {});
  }, FLUSH_INTERVAL_MS);
}

// Drain the buffer on clean process exit so in-flight events aren't lost when
// the worker shuts down gracefully (e.g. SIGTERM → drainSendOutbox → exit).
process.on('beforeExit', () => {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushBuffer().catch(() => {});
});

/** Buffer one event; flush immediately if the batch is full. */
export async function writeClickhouseEvent(ev: ClickhouseEvent): Promise<void> {
  if (!URL_BASE) return;
  const [eligible] = await filterNonErasedClickhouseRows([{
    event_id: ev.event_id ?? 0,
    message_id: ev.message_id,
    customer_id: ev.customer_id,
    event_type: ev.event_type,
    occurred_at: ev.occurred_at,
    ip: ev.ip ?? null,
    payload: JSON.stringify(ev.payload ?? {}),
  }]);
  if (!eligible) return;
  buffer.push(eligible);
  if (buffer.length >= BATCH_SIZE) {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flushBuffer();
  } else {
    scheduleFlush();
  }
}
