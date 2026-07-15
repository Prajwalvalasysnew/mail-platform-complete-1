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
  ensureMessagePartitions,
  sweepExpiredMessagePartitions,
  listMessagePartitions,
  partitionRange,
  placeLegalHold,
  releaseLegalHold,
  seedCustomer,
  runRetention,
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

  it('messages: ensure + expired-partition drop + hold skip', async () => {
    const { customerId } = await seedCustomer();

    // Pre-create current/future months and verify naming.
    await ensureMessagePartitions(2);
    const now = new Date();
    const currentName = `messages_part_${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(await listMessagePartitions()).toContain(currentName);

    // Ancient partition with one message in it, inserted via the parent.
    await sql`
      CREATE TABLE IF NOT EXISTS messages_part_202003 PARTITION OF messages
      FOR VALUES FROM ('2020-03-01') TO ('2020-04-01')
    `.execute(db);
    await db
      .insertInto('messages')
      .values({
        message_id: `part-msg-${Date.now()}`,
        customer_id: customerId,
        from_address: 'sender@seed.example.com',
        to_address: 'partition@example.com',
        subject: 'ancient',
        status: 'delivered' as any,
        ip_pool: 'transactional',
        attempts: 1,
        queued_at: new Date('2020-03-10T00:00:00Z') as any,
      } as any)
      .execute();

    // Held: the sweep must keep the partition.
    const hold = await placeLegalHold({ customerId, scope: 'customer', reason: 'litigation' });
    let sweep = await sweepExpiredMessagePartitions(395);
    expect(sweep.held).toContain('messages_part_202003');
    expect(await tableExists('messages_part_202003')).toBe(true);

    // Released: the sweep drops it as a metadata op.
    await releaseLegalHold(customerId, hold.id);
    sweep = await sweepExpiredMessagePartitions(395);
    expect(sweep.dropped).toContain('messages_part_202003');
    expect(await tableExists('messages_part_202003')).toBe(false);

    // Live months are untouched.
    expect(await listMessagePartitions()).toContain(currentName);
  });

  it('processed send_outbox rows age out via retention', async () => {
    const { customerId } = await seedCustomer();
    const mkMsg = async (suffix: string) => {
      const id = `outbox-ret-${suffix}-${Date.now()}`;
      await db.insertInto('messages').values({
        message_id: id,
        customer_id: customerId,
        from_address: 'sender@seed.example.com',
        to_address: `${suffix}@example.com`,
        subject: 'outbox retention',
        status: 'delivered' as any,
        ip_pool: 'transactional',
        attempts: 1,
      } as any).execute();
      return id;
    };
    const oldMsg = await mkMsg('old');
    const pendingMsg = await mkMsg('pending');
    const old = new Date(Date.now() - 60 * 86_400_000);

    await db.insertInto('send_outbox').values({
      message_id: oldMsg, customer_id: customerId,
      status: 'enqueued' as any, created_at: old as any, run_at: old as any,
    } as any).execute();
    await db.insertInto('send_outbox').values({
      message_id: pendingMsg, customer_id: customerId,
      status: 'pending' as any, created_at: old as any, run_at: old as any,
    } as any).execute();

    const result = await runRetention({ outboxRetentionDays: 30 });
    expect(result.send_outbox_purged).toBeGreaterThanOrEqual(1);

    const remaining = await db
      .selectFrom('send_outbox')
      .select(['message_id', 'status'])
      .where('message_id', 'in', [oldMsg, pendingMsg])
      .execute();
    const byId = new Map(remaining.map((r) => [r.message_id, r.status]));
    expect(byId.has(oldMsg)).toBe(false); // enqueued + old → purged
    expect(byId.get(pendingMsg)).toBe('pending'); // pending is never purged

    // Clean up so the leftover pending row is never drained by another test.
    await db.deleteFrom('send_outbox').where('message_id', 'in', [oldMsg, pendingMsg]).execute();
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
