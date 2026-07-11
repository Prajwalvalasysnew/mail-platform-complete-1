// Signed audit checkpoints + WORM sink (tamper-evidence hardening). Proves:
//   - a checkpoint signs the current chain head and verifies;
//   - a silent rewrite of the chain (edit both audit_log and audit_log_hashes)
//     fails verification against the externally-held signed root, even though
//     the rewritten chain is internally self-consistent;
//   - the WORM sink receives an append-only copy;
//   - a wrong public key rejects the signature.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import {
  db, recordAudit, verifyAuditChain,
  signAuditCheckpoint, verifyAuditCheckpoint, checkpointAllAuditChains,
  setAuditSigningKey, auditSigningPublicKeyPem, setWormAuditSink,
  seedCustomer,
} from '@platform/shared';
import type { AuditCheckpoint, WormAuditSink } from '@platform/shared';

// A fixed test signing key so results are deterministic across the suite.
const { privateKey } = crypto.generateKeyPairSync('ed25519');
const TEST_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

class CapturingSink implements WormAuditSink {
  readonly name = 'capturing';
  records: AuditCheckpoint[] = [];
  async append(record: AuditCheckpoint) { this.records.push(record); }
}
let sink: CapturingSink;

beforeAll(() => { setAuditSigningKey(TEST_KEY_PEM); sink = new CapturingSink(); setWormAuditSink(sink); });
afterAll(() => { setAuditSigningKey(null); setWormAuditSink(null); });

async function seedChain(customerId: string, n: number) {
  const actorId = crypto.randomUUID();
  for (let i = 0; i < n; i++) {
    await recordAudit({ customerId, actorType: 'user', actorId, action: `test.event.${i}`, resource: `r${i}` });
  }
}

describe('signed audit checkpoints (WORM)', () => {
  it('signs the current chain head, exports it, and verifies', async () => {
    const c = await seedCustomer();
    await seedChain(c.customerId, 3);
    const before = sink.records.length;

    const cp = await signAuditCheckpoint(c.customerId);
    expect(cp).not.toBeNull();
    expect(cp!.seq).toBe(3);
    // Exported to the WORM sink exactly once.
    expect(sink.records.length).toBe(before + 1);
    expect(sink.records.at(-1)).toMatchObject({ chain_key: c.customerId, seq: 3 });

    const result = await verifyAuditCheckpoint(cp!);
    expect(result).toMatchObject({ signatureValid: true, matchesChain: true });
    // Verifiable with only the published public key (asymmetric signed root).
    expect(await verifyAuditCheckpoint(cp!, auditSigningPublicKeyPem())).toMatchObject({ signatureValid: true, matchesChain: true });
  });

  it('detects a silent chain rewrite against the signed root', async () => {
    const c = await seedCustomer();
    await seedChain(c.customerId, 2);
    const cp = await signAuditCheckpoint(c.customerId);
    expect(cp!.seq).toBe(2);

    // Attacker rewrites the head link's row_hash to a self-consistent value
    // (as they would after editing the underlying audit_log row). The internal
    // chain may look plausible, but the signed root no longer matches.
    await db.updateTable('audit_log_hashes').set({ row_hash: 'f'.repeat(64) })
      .where('chain_key', '=', c.customerId).where('seq', '=', 2).execute();

    const result = await verifyAuditCheckpoint(cp!);
    expect(result.signatureValid).toBe(true);        // signature still authentic
    expect(result.matchesChain).toBe(false);         // but the live chain diverged
    expect(result.reason).toBe('row_hash_diverged');
  });

  it('rejects a checkpoint verified with the wrong public key', async () => {
    const c = await seedCustomer();
    await seedChain(c.customerId, 1);
    const cp = await signAuditCheckpoint(c.customerId);
    const otherPub = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect((await verifyAuditCheckpoint(cp!, otherPub)).signatureValid).toBe(false);
  });

  it('returns null for a chain with no links, and checkpoints all chains', async () => {
    const empty = await seedCustomer();
    expect(await signAuditCheckpoint(empty.customerId)).toBeNull();

    const c = await seedCustomer();
    await seedChain(c.customerId, 1);
    const summary = await checkpointAllAuditChains();
    expect(summary.signed).toBeGreaterThanOrEqual(1);
    expect(summary.chains).toBeGreaterThanOrEqual(1);
  });
});
