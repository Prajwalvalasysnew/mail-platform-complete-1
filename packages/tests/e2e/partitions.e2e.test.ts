// Phase 1.1 (docs/DATABASE_10_10_PLAN.md): monthly partitioning of `events`.
//
// Covers the partition-maintenance lifecycle: pre-creating future partitions,
// dropping fully-expired months as metadata ops, keeping months that contain
// rows under an active legal hold, and the default-partition safety net.
import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  db,
  ensureEventPartitions,
  sweepExpiredEventPartitions,
  listEventPartitions,
  countDefaultPartitionRows,
  partitionRange,
  placeLegalHold,
  releaseLegalHold,
  seedCustomer,
} from '@platform/shared';

async function tableExists(name: string): Promise<boolean> {
  const res = await sql<{ found: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ${name}
    ) AS found
  `.execute(db);
  return res.rows[0]?.found ?? false;
}

// Create a partition for an ancient month (nothing else seeds data this old,
// so the default partition holds no conflicting rows) and insert one event
// into it via the parent table.
async function seedAncientPartition(
  customerId: string,
  name: string,
  from: string,
  to: string,
  occurredAt: string,
  messageId = `part-seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
): Promise<string> {
  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.id(name)} PARTITION OF events
    FOR VALUES FROM (${sql.lit(from)}) TO (${sql.lit(to)})
  `.execute(db);
  await db
    .insertInto('events')
    .values({
      message_id: messageId,
      customer_id: customerId,
      event_type: 'delivered' as any,
      payload: {},
      occurred_at: new Date(occurredAt) as any,
    } as any)
    .execute();
  return messageId;
}

describe('event partition maintenance', () => {
  it('partitionRange parses managed partition names and rejects others', () => {
    const r = partitionRange('events_part_202601');
    expect(r?.start.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(r?.end.toISOString().slice(0, 10)).toBe('2026-02-01');
    expect(partitionRange('events_part_default')).toBeNull();
    expect(partitionRange('messages')).toBeNull();
  });

  it('ensureEventPartitions pre-creates current and future months', async () => {
    await ensureEventPartitions(3);
    const partitions = await listEventPartitions();

    const now = new Date();
    for (let i = 0; i <= 3; i++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const name = `events_part_${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      expect(partitions).toContain(name);
    }

    // Idempotent: a second run creates nothing new.
    const created = await ensureEventPartitions(3);
    expect(created).toEqual([]);
  });

  it('sweep drops a fully-expired partition as a metadata operation', async () => {
    const { customerId } = await seedCustomer();
    await seedAncientPartition(customerId, 'events_part_202001', '2020-01-01', '2020-02-01', '2020-01-15T12:00:00Z');
    expect(await tableExists('events_part_202001')).toBe(true);

    const result = await sweepExpiredEventPartitions(90);

    expect(result.dropped).toContain('events_part_202001');
    expect(await tableExists('events_part_202001')).toBe(false);
  });

  it('sweep keeps an expired partition whose rows are under an active hold, drops after release', async () => {
    const { customerId } = await seedCustomer();
    await seedAncientPartition(customerId, 'events_part_202002', '2020-02-01', '2020-03-01', '2020-02-10T12:00:00Z');

    const hold = await placeLegalHold({ customerId, scope: 'customer', reason: 'litigation' });

    let result = await sweepExpiredEventPartitions(90);
    expect(result.held).toContain('events_part_202002');
    expect(await tableExists('events_part_202002')).toBe(true);

    await releaseLegalHold(customerId, hold.id);

    result = await sweepExpiredEventPartitions(90);
    expect(result.dropped).toContain('events_part_202002');
    expect(await tableExists('events_part_202002')).toBe(false);
  });

  it('sweep never touches partitions inside the retention window', async () => {
    await ensureEventPartitions(1);
    const before = await listEventPartitions();
    await sweepExpiredEventPartitions(90);
    const after = await listEventPartitions();

    const now = new Date();
    const currentName = `events_part_${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(before).toContain(currentName);
    expect(after).toContain(currentName);
  });

  it('countDefaultPartitionRows reports rows landing outside pre-created ranges', async () => {
    const { customerId } = await seedCustomer();
    const baseline = await countDefaultPartitionRows();

    // 1997 predates any managed partition, so this insert falls through to
    // the default partition.
    await db
      .insertInto('events')
      .values({
        message_id: `default-part-${Date.now()}`,
        customer_id: customerId,
        event_type: 'delivered' as any,
        payload: {},
        occurred_at: new Date('1997-06-01T00:00:00Z') as any,
      } as any)
      .execute();

    expect(await countDefaultPartitionRows()).toBe(baseline + 1);

    // Clean up so this row doesn't block future partition creation for 1997.
    await sql`DELETE FROM events_part_default WHERE occurred_at < '1998-01-01'`.execute(db);
  });
});
