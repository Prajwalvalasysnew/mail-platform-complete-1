// Additive live-development check for the authenticated ClickHouse projection.
// Refuses remote/test targets, inserts one synthetic event through product code,
// reads it through the analytics helper, then removes the message-level row.

import 'dotenv/config';
import {
  chSummaryCounts,
  clickhouseRequestHeaders,
  closeDb,
  closeQueues,
  closeRedis,
  deleteClickhouseMessageEvents,
  insertClickhouseRows,
} from '../packages/shared/src/index.js';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function main() {
  assert(process.env.DEV_REPLAY_CONFIRM === '1', 'Set DEV_REPLAY_CONFIRM=1');
  const database = new URL(process.env.DATABASE_URL ?? '');
  const clickhouse = new URL(process.env.EVENTS_CLICKHOUSE_URL ?? '');
  const local = ['localhost', '127.0.0.1', '::1'];
  assert(local.includes(database.hostname), 'Refusing non-local database');
  assert(database.port !== '5434' && !/test/i.test(database.pathname), 'Refusing test database');
  assert(local.includes(clickhouse.hostname), 'Refusing non-local ClickHouse');
  assert(process.env.EVENTS_CLICKHOUSE_TABLE === 'mail.events', 'Expected the real mail.events table');

  const eventId = Date.now();
  const customerId = `clickhouse-live-${eventId}`;
  const messageId = `<clickhouse-live-${eventId}@local.test>`;
  const inserted = await insertClickhouseRows([{
    event_id: eventId,
    message_id: messageId,
    customer_id: customerId,
    event_type: 'delivered',
    occurred_at: new Date().toISOString(),
    ip: null,
    payload: JSON.stringify({ source: 'local-release-gate' }),
  } as any]);
  assert(inserted, 'Authenticated ClickHouse insert failed');

  const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const summary = await chSummaryCounts(customerId, since);
  assert(summary?.delivered === 1, `Expected one projected delivery, got ${JSON.stringify(summary)}`);

  await deleteClickhouseMessageEvents(customerId, messageId);
  const query = new URL('/', clickhouse);
  query.searchParams.set(
    'query',
    'SELECT count() AS count FROM mail.events WHERE customer_id = {customer_id:String} AND message_id = {message_id:String} FORMAT JSON',
  );
  query.searchParams.set('param_customer_id', customerId);
  query.searchParams.set('param_message_id', messageId);
  const response = await fetch(query, { method: 'POST', headers: clickhouseRequestHeaders() });
  assert(response.ok, `ClickHouse verification query failed: ${response.status}`);
  const result = await response.json() as { data: Array<{ count: string | number }> };
  assert(Number(result.data[0]?.count ?? -1) === 0, 'Message-level ClickHouse deletion was not applied');

  console.log(JSON.stringify({
    ok: true,
    authenticated_insert: true,
    daily_rollup_read: summary,
    message_level_delete: true,
  }, null, 2));
}

main()
  .finally(() => Promise.all([closeQueues(), closeRedis(), closeDb()]))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
