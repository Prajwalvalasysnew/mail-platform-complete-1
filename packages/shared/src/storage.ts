// Message-body object storage. At volume, storing html_body/text_body inline in
// the hot `messages` table bloats it and kills cache locality. This offloads
// bodies to object storage, keeping only a pointer + size + hash in Postgres.
//
// Backends (BODY_STORAGE): 'inline' (default; keep in Postgres), 'fs' (local
// filesystem -- zero external dependency, good for single-node), and 's3' (any
// S3-compatible store: AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO, ...
// selected purely by endpoint/credentials -- no provider lock-in). The
// interface is stable so the send path never changes when you switch backends.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type BodyStorageKind = 'inline' | 'fs' | 's3';

export interface StoredBody {
  storage: BodyStorageKind;
  object_key?: string;
  size: number;
  hash: string;
}

export interface BodyStore {
  readonly kind: BodyStorageKind;
  /** Store a body (content-addressed). Returns a pointer to persist on the message. */
  put(body: { html?: string; text?: string }): Promise<StoredBody>;
  /** Read a previously stored body by its object key. */
  get(objectKey: string): Promise<{ html?: string; text?: string }>;
  /** Remove a stored body (lifecycle / GDPR erase). No-op for inline. */
  delete(objectKey: string): Promise<void>;
}

function serialize(body: { html?: string; text?: string }): string {
  return JSON.stringify({ html: body.html ?? null, text: body.text ?? null });
}
function hashOf(payload: string): { hash: string; size: number } {
  return { hash: crypto.createHash('sha256').update(payload).digest('hex'), size: Buffer.byteLength(payload) };
}
function parse(payload: string): { html?: string; text?: string } {
  const o = JSON.parse(payload) as { html: string | null; text: string | null };
  return { html: o.html ?? undefined, text: o.text ?? undefined };
}
function keyFor(prefix: string, hash: string): string {
  // Content-addressed: identical bodies (e.g. one campaign to many recipients)
  // dedupe to a single object. Sharded by hash prefix to avoid hot directories.
  return `${prefix}${hash.slice(0, 2)}/${hash}.json`;
}

// --- inline: nothing offloaded; caller keeps writing html_body/text_body ----
class InlineStore implements BodyStore {
  readonly kind = 'inline';
  async put(body: { html?: string; text?: string }): Promise<StoredBody> {
    const payload = serialize(body);
    return { storage: 'inline', ...hashOf(payload) };
  }
  async get(): Promise<{ html?: string; text?: string }> {
    throw new Error('inline bodies are read from the messages table, not the body store');
  }
  async delete(): Promise<void> {
    /* no-op */
  }
}

// --- filesystem: local dir, zero external dependency --------------------------
export class FilesystemStore implements BodyStore {
  readonly kind = 'fs';
  constructor(private readonly dir: string, private readonly prefix = 'bodies/') {}
  private full(objectKey: string): string {
    return path.join(this.dir, objectKey);
  }
  async put(body: { html?: string; text?: string }): Promise<StoredBody> {
    const payload = serialize(body);
    const { hash, size } = hashOf(payload);
    const objectKey = keyFor(this.prefix, hash);
    const file = this.full(objectKey);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, payload);
    return { storage: 'fs', object_key: objectKey, size, hash };
  }
  async get(objectKey: string): Promise<{ html?: string; text?: string }> {
    return parse(await fs.readFile(this.full(objectKey), 'utf8'));
  }
  async delete(objectKey: string): Promise<void> {
    await fs.rm(this.full(objectKey), { force: true });
  }
}

// --- object client seam (so S3Store is testable without network) -------------
export interface ObjectClient {
  putObject(key: string, data: string, contentType: string): Promise<void>;
  getObject(key: string): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

/** In-memory object client for tests and local dev. */
export class InMemoryObjectClient implements ObjectClient {
  readonly store = new Map<string, string>();
  async putObject(key: string, data: string): Promise<void> {
    this.store.set(key, data);
  }
  async getObject(key: string): Promise<string> {
    const v = this.store.get(key);
    if (v === undefined) throw new Error(`object not found: ${key}`);
    return v;
  }
  async deleteObject(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/**
 * S3-compatible client backed by @aws-sdk/client-s3. Works with AWS S3,
 * Cloudflare R2, Backblaze B2, Wasabi, MinIO, etc. -- the endpoint + credentials
 * decide which. forcePathStyle defaults on (required by MinIO and some others).
 */
export class S3ObjectClient implements ObjectClient {
  private client: any;
  private bucket: string;
  constructor() {
    this.bucket = process.env.BODY_S3_BUCKET ?? '';
    // Lazy require so the AWS SDK is only loaded when the S3 backend is used.
    const { S3Client } = require('@aws-sdk/client-s3');
    this.client = new S3Client({
      region: process.env.BODY_S3_REGION ?? 'auto',
      endpoint: process.env.BODY_S3_ENDPOINT || undefined,
      forcePathStyle: (process.env.BODY_S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
      credentials:
        process.env.BODY_S3_ACCESS_KEY_ID && process.env.BODY_S3_SECRET_ACCESS_KEY
          ? { accessKeyId: process.env.BODY_S3_ACCESS_KEY_ID, secretAccessKey: process.env.BODY_S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }
  async putObject(key: string, data: string, contentType: string): Promise<void> {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType }));
  }
  async getObject(key: string): Promise<string> {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body.transformToString();
  }
  async deleteObject(key: string): Promise<void> {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

// --- s3-compatible store ------------------------------------------------------
export class S3Store implements BodyStore {
  readonly kind = 's3';
  private prefix = process.env.BODY_S3_PREFIX ?? 'bodies/';
  constructor(private readonly client: ObjectClient = new S3ObjectClient()) {}
  async put(body: { html?: string; text?: string }): Promise<StoredBody> {
    const payload = serialize(body);
    const { hash, size } = hashOf(payload);
    const objectKey = keyFor(this.prefix, hash);
    await this.client.putObject(objectKey, payload, 'application/json');
    return { storage: 's3', object_key: objectKey, size, hash };
  }
  async get(objectKey: string): Promise<{ html?: string; text?: string }> {
    return parse(await this.client.getObject(objectKey));
  }
  async delete(objectKey: string): Promise<void> {
    await this.client.deleteObject(objectKey);
  }
}

let cached: BodyStore | null = null;
export function getBodyStore(): BodyStore {
  if (cached) return cached;
  const kind = (process.env.BODY_STORAGE ?? 'inline').toLowerCase();
  if (kind === 's3') cached = new S3Store();
  else if (kind === 'fs') cached = new FilesystemStore(process.env.BODY_FS_DIR ?? '/var/lib/mailplatform/bodies');
  else cached = new InlineStore();
  return cached;
}
export function setBodyStore(store: BodyStore | null): void {
  cached = store;
}

/**
 * Resolve a message's body, transparently reading from the offload store when
 * the body was not kept inline. Used by the send worker so delivery code is
 * agnostic to where the body lives.
 */
export async function loadMessageBody(msg: {
  html_body?: string | null;
  text_body?: string | null;
  body_storage?: string | null;
  body_object_key?: string | null;
}): Promise<{ html?: string; text?: string }> {
  if (msg.body_storage && msg.body_storage !== 'inline' && msg.body_object_key) {
    return getBodyStore().get(msg.body_object_key);
  }
  return { html: msg.html_body ?? undefined, text: msg.text_body ?? undefined };
}
