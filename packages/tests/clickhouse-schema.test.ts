// Guard the ClickHouse analytics dedup design (Phase 3 durability). The event
// firehose is written twice per event (best-effort hot path + durable
// reconciler), both emitting the same Postgres events.id as `event_id`. The
// schema must deduplicate on that key, or reconciliation inflates analytics.
// This is a static guard on the shipped DDL — the live merge/rollup behaviour is
// proven separately against a real ClickHouse (see docs/CLICKHOUSE_DURABILITY.md).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ddl = readFileSync(path.resolve(__dirname, '..', '..', 'infra', 'clickhouse', 'init.sql'), 'utf8');

describe('ClickHouse analytics dedup schema', () => {
  it('stores the event_id dedup key on the base table', () => {
    expect(ddl).toMatch(/event_id\s+UInt64/);
  });

  it('uses ReplacingMergeTree keyed so duplicate event_id inserts collapse', () => {
    expect(ddl).toMatch(/ENGINE\s*=\s*ReplacingMergeTree/);
    // event_id must be part of the base table sorting key.
    const orderBy = /CREATE TABLE IF NOT EXISTS mail\.events[\s\S]*?ORDER BY \(([^)]*)\)/.exec(ddl);
    expect(orderBy?.[1]).toContain('event_id');
  });

  it('rolls up daily counts with uniqExact so double inserts never double-count', () => {
    expect(ddl).toMatch(/AggregateFunction\(uniqExact, UInt64\)/);
    expect(ddl).toMatch(/uniqExactState\(event_id\)/);
    // The old SummingMergeTree count() rollup double-counted duplicate inserts.
    expect(ddl).not.toMatch(/count\(\)\s+AS\s+count/);
  });
});
