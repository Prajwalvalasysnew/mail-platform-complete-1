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

export interface ClickhouseEvent {
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

export function clickhouseEnabled(): boolean {
  return !!(process.env.EVENTS_CLICKHOUSE_URL ?? URL_BASE);
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
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  const url = `${urlBase}/?query=${encodeURIComponent(`INSERT INTO ${TABLE} FORMAT JSONEachRow`)}`;
  try {
    const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-ndjson' } });
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
  message_id: string;
  customer_id: string;
  event_type: string;
  occurred_at: string;
  ip: string | null;
  payload: string; // JSON-serialised
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
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  const url = `${URL_BASE}/?query=${encodeURIComponent(`INSERT INTO ${TABLE} FORMAT JSONEachRow`)}`;
  try {
    const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-ndjson' } });
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
  buffer.push({
    message_id: ev.message_id,
    customer_id: ev.customer_id,
    event_type: ev.event_type,
    occurred_at: ev.occurred_at,
    ip: ev.ip ?? null,
    payload: JSON.stringify(ev.payload ?? {}),
  });
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
