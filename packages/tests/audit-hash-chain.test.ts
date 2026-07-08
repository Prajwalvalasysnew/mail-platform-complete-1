// DB integration tests for the tamper-evident audit hash chain (gap analysis
// Top-20 #10: "Audit exists but is not tamper-evident"). Proves the chain is
// built on every audit write, verifies intact, and — critically — that
// tampering with an audit row, deleting a row, or altering a hash is DETECTED.

import { describe, it, expect } from 'vitest';
import { recordAudit, verifyAuditChain, seedCustomer, db } from '@platform/shared';

async function recordN(customerId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await recordAudit({
      customerId,
      actorType: 'user',
      actorLabel: `user-${i}@example.com`,
      action: `test.action.${i}`,
      resource: `res-${i}`,
      metadata: { i, note: `event ${i}` },
    });
  }
}

describe('audit hash chain', () => {
  it('builds a chain link for every audit row and verifies intact', async () => {
    const c = await seedCustomer();
    await recordN(c.customerId, 5);

    const links = await db.selectFrom('audit_log_hashes').select(['seq']).where('chain_key', '=', c.customerId).execute();
    expect(links.length).toBe(5);

    const result = await verifyAuditChain(c.customerId);
    expect(result.ok).toBe(true);
    expect(result.links_checked).toBe(5);
  });

  it('assigns strictly increasing sequence numbers starting at 1', async () => {
    const c = await seedCustomer();
    await recordN(c.customerId, 3);
    const seqs = (await db.selectFrom('audit_log_hashes').select(['seq']).where('chain_key', '=', c.customerId).orderBy('seq', 'asc').execute()).map((r) => Number(r.seq));
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('DETECTS tampering when an audit row is altered', async () => {
    const c = await seedCustomer();
    await recordN(c.customerId, 5);
    expect((await verifyAuditChain(c.customerId)).ok).toBe(true);

    // Tamper: change the action of the 3rd audit row (seq 3).
    const link = await db.selectFrom('audit_log_hashes').select(['audit_id', 'seq']).where('chain_key', '=', c.customerId).where('seq', '=', 3).executeTakeFirstOrThrow();
    await db.updateTable('audit_log').set({ action: 'tampered.action' }).where('id', '=', link.audit_id).execute();

    const result = await verifyAuditChain(c.customerId);
    expect(result.ok).toBe(false);
    expect(result.broken_at?.seq).toBe(3);
    expect(result.broken_at?.reason).toBe('row_hash_mismatch');
    // The chain was intact up to the tampered link.
    expect(result.links_checked).toBe(2);
  });

  it('DETECTS tampering when metadata is altered', async () => {
    const c = await seedCustomer();
    await recordN(c.customerId, 4);
    const link = await db.selectFrom('audit_log_hashes').select(['audit_id']).where('chain_key', '=', c.customerId).where('seq', '=', 2).executeTakeFirstOrThrow();
    await db.updateTable('audit_log').set({ metadata: { i: 999, injected: true } }).where('id', '=', link.audit_id).execute();

    const result = await verifyAuditChain(c.customerId);
    expect(result.ok).toBe(false);
    expect(result.broken_at?.seq).toBe(2);
  });

  it('DETECTS a deleted audit row (FK cascade removes the link, leaving a sequence gap)', async () => {
    const c = await seedCustomer();
    await recordN(c.customerId, 4);
    // Deleting an audit row cascades (ON DELETE CASCADE) to its hash link, so a
    // deletion can't leave an orphan hash — instead it removes seq N, leaving a
    // gap in the chain. Delete the seq-2 audit row.
    const link = await db.selectFrom('audit_log_hashes').select(['audit_id']).where('chain_key', '=', c.customerId).where('seq', '=', 2).executeTakeFirstOrThrow();
    await db.deleteFrom('audit_log').where('id', '=', link.audit_id).execute();

    const result = await verifyAuditChain(c.customerId);
    expect(result.ok).toBe(false);
    // seq 1 verifies, then seq jumps to 3 → sequence_gap (or the following
    // link's previous_hash no longer matches). Either way the chain is broken.
    expect(result.broken_at).toBeTruthy();
    expect(['sequence_gap', 'previous_hash_mismatch']).toContain(result.broken_at!.reason);
    expect(result.links_checked).toBe(1);
  });

  it('keeps separate chains per customer (one tenant tamper does not affect another)', async () => {
    const a = await seedCustomer();
    const b = await seedCustomer();
    await recordN(a.customerId, 3);
    await recordN(b.customerId, 3);

    // Tamper only tenant A.
    const link = await db.selectFrom('audit_log_hashes').select(['audit_id']).where('chain_key', '=', a.customerId).where('seq', '=', 2).executeTakeFirstOrThrow();
    await db.updateTable('audit_log').set({ action: 'x' }).where('id', '=', link.audit_id).execute();

    expect((await verifyAuditChain(a.customerId)).ok).toBe(false);
    expect((await verifyAuditChain(b.customerId)).ok).toBe(true);
  });

  it('verifies an empty chain as ok', async () => {
    const c = await seedCustomer();
    const result = await verifyAuditChain(c.customerId);
    expect(result.ok).toBe(true);
    expect(result.links_checked).toBe(0);
  });
});
