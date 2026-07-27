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
  appendBundle?(bundle: ImmutableAuditBundle): Promise<string>;
}

export interface ImmutableAuditBundle {
  version: 1;
  chain_key: string;
  start_seq: number;
  end_seq: number;
  record_count: number;
  records: Array<Record<string, unknown>>;
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
  async appendBundle(bundle: ImmutableAuditBundle): Promise<string> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const key = `audit-${bundle.chain_key.replace(/[^A-Za-z0-9_.-]/g, '_')}-${bundle.start_seq}-${bundle.end_seq}.json`;
    await fs.promises.writeFile(path.join(this.dir, key), JSON.stringify(bundle), { flag: 'wx' });
    return key;
  }
}

/**
 * Independent immutable-object sink. The target bucket must have Object Lock
 * enabled; COMPLIANCE mode prevents even privileged storage administrators
 * from shortening retention. A successful PutObject is the acceptance signal.
 */
export class S3ObjectLockWormSink implements WormAuditSink {
  readonly name = 's3-object-lock';
  async append(record: AuditCheckpoint): Promise<void> {
    const bucket = process.env.AUDIT_WORM_S3_BUCKET;
    const kmsKeyId = process.env.AUDIT_WORM_S3_KMS_KEY_ID;
    if (!bucket) throw new Error('AUDIT_WORM_S3_BUCKET is required');
    if (!kmsKeyId) throw new Error('AUDIT_WORM_S3_KMS_KEY_ID is required');
    const retentionDays = Number(process.env.AUDIT_WORM_RETENTION_DAYS ?? 2557);
    if (!Number.isInteger(retentionDays) || retentionDays < 1) {
      throw new Error('AUDIT_WORM_RETENTION_DAYS must be a positive integer');
    }
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      region: process.env.AUDIT_WORM_S3_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.AUDIT_WORM_S3_ENDPOINT || undefined,
      forcePathStyle: process.env.AUDIT_WORM_S3_FORCE_PATH_STYLE === 'true',
    });
    const body = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    const safeChain = record.chain_key.replace(/[^A-Za-z0-9_.-]/g, '_');
    const key = [
      process.env.AUDIT_WORM_S3_PREFIX ?? 'audit-checkpoints',
      record.checkpoint_at.slice(0, 10),
      `${safeChain}-${record.seq}-${crypto.randomUUID()}.json`,
    ].join('/');
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json',
      ChecksumSHA256: crypto.createHash('sha256').update(body).digest('base64'),
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: kmsKeyId,
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: new Date(Date.now() + retentionDays * 86400_000),
      Metadata: { chain_key: safeChain, sequence: String(record.seq), signing_key_id: record.key_id },
    }));
  }
  async appendBundle(bundle: ImmutableAuditBundle): Promise<string> {
    const bucket = process.env.AUDIT_WORM_S3_BUCKET;
    const kmsKeyId = process.env.AUDIT_WORM_S3_KMS_KEY_ID;
    if (!bucket || !kmsKeyId) throw new Error('Audit WORM bucket and KMS key are required');
    const retentionDays = Number(process.env.AUDIT_WORM_RETENTION_DAYS ?? 2557);
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      region: process.env.AUDIT_WORM_S3_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.AUDIT_WORM_S3_ENDPOINT || undefined,
      forcePathStyle: process.env.AUDIT_WORM_S3_FORCE_PATH_STYLE === 'true',
    });
    const safeChain = bundle.chain_key.replace(/[^A-Za-z0-9_.-]/g, '_');
    const key = [
      process.env.AUDIT_WORM_S3_BUNDLE_PREFIX ?? 'audit-records',
      new Date().toISOString().slice(0, 10),
      `${safeChain}-${bundle.start_seq}-${bundle.end_seq}-${crypto.randomUUID()}.json`,
    ].join('/');
    const body = Buffer.from(JSON.stringify(bundle), 'utf8');
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: body, ContentType: 'application/json',
      ChecksumSHA256: crypto.createHash('sha256').update(body).digest('base64'),
      ServerSideEncryption: 'aws:kms', SSEKMSKeyId: kmsKeyId,
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: new Date(Date.now() + retentionDays * 86400_000),
      Metadata: {
        chain_key: safeChain, start_sequence: String(bundle.start_seq),
        end_sequence: String(bundle.end_seq), record_count: String(bundle.record_count),
      },
    }));
    return key;
  }
}

let sink: WormAuditSink | null = null;

export function setWormAuditSink(s: WormAuditSink | null): void {
  sink = s;
}

export function getWormAuditSink(): WormAuditSink {
  if (sink) return sink;
  if ((process.env.AUDIT_WORM_PROVIDER ?? '').toLowerCase() === 's3') {
    sink = new S3ObjectLockWormSink();
    return sink;
  }
  const dir = process.env.AUDIT_WORM_DIR;
  if (dir) sink = new FilesystemWormSink(dir);
  else if (process.env.NODE_ENV === 'production') {
    throw new Error('AUDIT_WORM_PROVIDER=s3 is required in production; null/local sinks are not immutable');
  } else sink = new NullWormSink();
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

/** Export not-yet-exported audit rows as encrypted, immutable segments. */
export async function exportAuditChainToWorm(chainKey: string, batchSize = 1000): Promise<number> {
  const worm = getWormAuditSink();
  if (!worm.appendBundle) {
    if (process.env.NODE_ENV === 'production') throw new Error('Production WORM sink cannot store audit bundles');
    return 0;
  }
  let exported = 0;
  while (true) {
    const cursor = await db.selectFrom('audit_worm_exports').select('end_seq')
      .where('chain_key', '=', chainKey).orderBy('end_seq', 'desc').executeTakeFirst();
    const after = Number(cursor?.end_seq ?? 0);
    const result = await sql<Record<string, unknown> & { seq: string | number }>`
      SELECT * FROM (
        SELECT a.id::text AS audit_id, a.customer_id::text, a.api_key_id::text,
          a.actor_type, a.actor_id::text, a.actor_label, a.action, a.resource,
          a.ip::text, a.metadata, a.occurred_at, h.seq, h.previous_hash, h.row_hash
        FROM audit_log a JOIN audit_log_hashes h ON h.audit_id = a.id
        WHERE h.chain_key = ${chainKey} AND h.seq > ${after}
        UNION ALL
        SELECT a.audit_id::text, a.customer_id::text, a.api_key_id::text,
          a.actor_type, a.actor_id::text, a.actor_label, a.action, a.resource,
          a.ip::text, a.metadata, a.occurred_at, a.seq, a.previous_hash, a.row_hash
        FROM audit_log_archive a
        WHERE a.chain_key = ${chainKey} AND a.seq > ${after}
      ) records ORDER BY seq ASC LIMIT ${batchSize}
    `.execute(db);
    if (!result.rows.length) break;
    const startSeq = Number(result.rows[0]!.seq);
    const endSeq = Number(result.rows.at(-1)!.seq);
    const bundle: ImmutableAuditBundle = {
      version: 1, chain_key: chainKey, start_seq: startSeq, end_seq: endSeq,
      record_count: result.rows.length, records: result.rows,
    };
    const checksum = crypto.createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
    const objectKey = await worm.appendBundle(bundle);
    await db.insertInto('audit_worm_exports').values({
      chain_key: chainKey, start_seq: startSeq, end_seq: endSeq,
      record_count: result.rows.length, bundle_sha256: checksum, object_key: objectKey,
    }).execute();
    exported += result.rows.length;
    if (result.rows.length < batchSize) break;
  }
  return exported;
}

/**
 * Sign the current head of a chain and export it to the WORM sink. Returns the
 * checkpoint, or null if the chain has no links yet. Idempotent-friendly: a
 * checkpoint at the same seq is harmless (it re-attests the same head).
 */
export async function signAuditCheckpoint(chainKey: string, now = new Date()): Promise<AuditCheckpoint | null> {
  const head = await chainHead(chainKey);
  if (!head) return null;
  await exportAuditChainToWorm(chainKey);
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
