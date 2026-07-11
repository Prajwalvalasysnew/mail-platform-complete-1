// Signed audit checkpoints + WORM sink (tamper-evidence hardening).
//
// The audit hash chain (audit.ts) detects in-place edits, but an attacker with
// full DB write access could rewrite audit_log AND audit_log_hashes together
// and recompute a self-consistent chain. This module closes that gap: it signs
// the current chain head with an Ed25519 key and exports the signed root to an
// append-only WORM sink held OUTSIDE the database. Verification then compares
// the externally-held signed root against the live chain — a silent rewrite no
// longer verifies, because the old head's signature can't be forged without the
// private key, and a real WORM sink (e.g. S3 Object Lock) can't be edited.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'kysely';
import { db } from './db.js';

export interface AuditCheckpoint {
  chain_key: string;
  seq: number;
  row_hash: string;
  checkpoint_at: string; // ISO8601
  key_id: string;
  signature: string; // base64 Ed25519 signature over the canonical checkpoint
}

// ── Signing key management ──────────────────────────────────────────────────
// Production supplies an Ed25519 private key via AUDIT_SIGNING_KEY_PEM (PKCS#8
// PEM). Verifiers need only the public key, so the signing key can live in a
// KMS/secret store and the public key can be published. In dev/test with no key
// configured we generate an ephemeral in-process keypair (and warn), so nothing
// crashes — but such checkpoints are not durable across restarts.

interface SigningKey {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  keyId: string;
}

let signingKey: SigningKey | null = null;
let warnedEphemeral = false;

function keyIdFor(publicKey: crypto.KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

function makeSigningKey(privateKey: crypto.KeyObject): SigningKey {
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey, keyId: keyIdFor(publicKey) };
}

/** Inject a signing key (tests / explicit key rotation). Pass null to reset. */
export function setAuditSigningKey(privateKeyPem: string | null): void {
  signingKey = privateKeyPem ? makeSigningKey(crypto.createPrivateKey(privateKeyPem)) : null;
}

function getSigningKey(): SigningKey {
  if (signingKey) return signingKey;
  const pem = process.env.AUDIT_SIGNING_KEY_PEM;
  if (pem) {
    signingKey = makeSigningKey(crypto.createPrivateKey(pem));
    return signingKey;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUDIT_SIGNING_KEY_PEM is required in production to sign audit checkpoints');
  }
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  signingKey = makeSigningKey(privateKey);
  if (!warnedEphemeral) {
    console.warn('[audit] no AUDIT_SIGNING_KEY_PEM set — using an EPHEMERAL signing key (dev only)');
    warnedEphemeral = true;
  }
  return signingKey;
}

/** The public key (SPKI PEM) that external verifiers use to check checkpoints. */
export function auditSigningPublicKeyPem(): string {
  return getSigningKey().publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

// Canonical, signable representation of a checkpoint. Deterministic ordering so
// the signer and verifier hash exactly the same bytes.
function canonicalCheckpoint(cp: Pick<AuditCheckpoint, 'chain_key' | 'seq' | 'row_hash' | 'checkpoint_at'>): Buffer {
  return Buffer.from(JSON.stringify([cp.chain_key, String(cp.seq), cp.row_hash, cp.checkpoint_at]), 'utf8');
}

// ── WORM sink seam ──────────────────────────────────────────────────────────
// The default sink appends to a local JSONL file when AUDIT_WORM_DIR is set,
// else it is a no-op. Production should inject an S3-Object-Lock (or equivalent
// immutable) sink so exported roots cannot be deleted or edited.

export interface WormAuditSink {
  readonly name: string;
  append(record: AuditCheckpoint): Promise<void>;
}

export class NullWormSink implements WormAuditSink {
  readonly name = 'null';
  async append(): Promise<void> {}
}

/** Append-only local file sink. Real WORM needs immutable object storage. */
export class FilesystemWormSink implements WormAuditSink {
  readonly name = 'filesystem';
  constructor(private readonly dir: string) {}
  async append(record: AuditCheckpoint): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.appendFile(path.join(this.dir, 'audit-checkpoints.jsonl'), JSON.stringify(record) + '\n', { flag: 'a' });
  }
}

let sink: WormAuditSink | null = null;

export function setWormAuditSink(s: WormAuditSink | null): void {
  sink = s;
}

export function getWormAuditSink(): WormAuditSink {
  if (sink) return sink;
  const dir = process.env.AUDIT_WORM_DIR;
  sink = dir ? new FilesystemWormSink(dir) : new NullWormSink();
  return sink;
}

// ── Checkpoint operations ───────────────────────────────────────────────────

/** Read the current head (highest seq + its row_hash) of one chain. */
async function chainHead(chainKey: string): Promise<{ seq: number; row_hash: string } | null> {
  const result = await sql<{ seq: string | number; row_hash: string }>`
    SELECT seq, row_hash FROM (
      SELECT seq, row_hash FROM audit_log_hashes WHERE chain_key = ${chainKey}
      UNION ALL
      SELECT seq, row_hash FROM audit_log_archive WHERE chain_key = ${chainKey} AND seq IS NOT NULL
    ) links ORDER BY seq DESC LIMIT 1
  `.execute(db);
  const head = result.rows[0];
  return head ? { seq: Number(head.seq), row_hash: head.row_hash } : null;
}

/**
 * Sign the current head of a chain and export it to the WORM sink. Returns the
 * checkpoint, or null if the chain has no links yet. Idempotent-friendly: a
 * checkpoint at the same seq is harmless (it re-attests the same head).
 */
export async function signAuditCheckpoint(chainKey: string, now = new Date()): Promise<AuditCheckpoint | null> {
  const head = await chainHead(chainKey);
  if (!head) return null;
  const key = getSigningKey();
  const base = { chain_key: chainKey, seq: head.seq, row_hash: head.row_hash, checkpoint_at: now.toISOString() };
  const signature = crypto.sign(null, canonicalCheckpoint(base), key.privateKey).toString('base64');
  const checkpoint: AuditCheckpoint = { ...base, key_id: key.keyId, signature };

  await db.insertInto('audit_checkpoints').values({
    chain_key: checkpoint.chain_key, seq: checkpoint.seq, row_hash: checkpoint.row_hash,
    key_id: checkpoint.key_id, signature: checkpoint.signature, checkpoint_at: now as any,
  }).execute();
  // Export to the immutable sink AFTER the DB row so a sink failure is retryable
  // without losing the record; the sink is the tamper-evidence backstop.
  await getWormAuditSink().append(checkpoint);
  return checkpoint;
}

/** Checkpoint every audit chain that has links. Returns per-chain results. */
export async function checkpointAllAuditChains(now = new Date()): Promise<{ chains: number; signed: number }> {
  const rows = await sql<{ chain_key: string }>`
    SELECT DISTINCT chain_key FROM (
      SELECT chain_key FROM audit_log_hashes
      UNION
      SELECT chain_key FROM audit_log_archive WHERE chain_key IS NOT NULL
    ) c
  `.execute(db);
  let signed = 0;
  for (const { chain_key } of rows.rows) {
    if (await signAuditCheckpoint(chain_key, now)) signed++;
  }
  return { chains: rows.rows.length, signed };
}

export interface CheckpointVerifyResult {
  signatureValid: boolean; // the signature is authentic for the checkpoint's contents
  matchesChain: boolean;   // the checkpoint's head still matches the live chain (no rewrite)
  reason?: string;
}

/**
 * Verify a checkpoint two ways: (1) the Ed25519 signature is authentic, and
 * (2) the live chain at that seq still has the signed row_hash. A silent
 * rewrite of the chain fails (2) even though (1) passes — that is the whole
 * point of an externally-held signed root. `publicKeyPem` defaults to the
 * current signing key's public half.
 */
export async function verifyAuditCheckpoint(cp: AuditCheckpoint, publicKeyPem?: string): Promise<CheckpointVerifyResult> {
  let signatureValid = false;
  try {
    const publicKey = publicKeyPem ? crypto.createPublicKey(publicKeyPem) : getSigningKey().publicKey;
    signatureValid = crypto.verify(null, canonicalCheckpoint(cp), publicKey, Buffer.from(cp.signature, 'base64'));
  } catch {
    signatureValid = false;
  }

  // Compare against the live link at that seq (hot or archived).
  const link = await sql<{ row_hash: string }>`
    SELECT row_hash FROM audit_log_hashes WHERE chain_key = ${cp.chain_key} AND seq = ${cp.seq}
    UNION ALL
    SELECT row_hash FROM audit_log_archive WHERE chain_key = ${cp.chain_key} AND seq = ${cp.seq}
    LIMIT 1
  `.execute(db);
  const live = link.rows[0];
  const matchesChain = !!live && live.row_hash === cp.row_hash;
  return {
    signatureValid,
    matchesChain,
    reason: !signatureValid ? 'bad_signature' : !live ? 'no_link_at_seq' : !matchesChain ? 'row_hash_diverged' : undefined,
  };
}
