// Body-storage backends: filesystem, in-memory S3-compatible, content-addressing,
// and the loadMessageBody resolver. No network — the S3-compatible path is
// exercised through an injected in-memory object client.

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  FilesystemStore,
  S3Store,
  InMemoryObjectClient,
  setBodyStore,
  getBodyStore,
  loadMessageBody,
} from '@platform/shared';

afterEach(() => setBodyStore(null));

const body = { html: '<h1>Hi</h1>', text: 'Hi' };

describe('FilesystemStore', () => {
  it('round-trips a body and reports a stable content hash', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bodies-'));
    const store = new FilesystemStore(dir);
    const ptr = await store.put(body);
    expect(ptr.storage).toBe('fs');
    expect(ptr.object_key).toBeTruthy();
    expect(ptr.size).toBeGreaterThan(0);
    expect(ptr.hash).toMatch(/^[0-9a-f]{64}$/);

    const got = await store.get(ptr.object_key!);
    expect(got).toEqual(body);

    // Content-addressed: same body => same key (dedupe).
    const ptr2 = await store.put(body);
    expect(ptr2.object_key).toBe(ptr.object_key);

    await store.delete(ptr.object_key!);
    await expect(store.get(ptr.object_key!)).rejects.toBeTruthy();
  });
});

describe('S3Store (in-memory client)', () => {
  it('puts/gets/deletes via the object client', async () => {
    const client = new InMemoryObjectClient();
    const store = new S3Store(client);
    const ptr = await store.put(body);
    expect(ptr.storage).toBe('s3');
    expect(client.store.has(ptr.object_key!)).toBe(true);
    expect(await store.get(ptr.object_key!)).toEqual(body);
    await store.delete(ptr.object_key!);
    expect(client.store.has(ptr.object_key!)).toBe(false);
  });

  it('stores JSON content for the object', async () => {
    const client = new InMemoryObjectClient();
    const store = new S3Store(client);
    const ptr = await store.put(body);
    expect(JSON.parse(client.store.get(ptr.object_key!)!)).toEqual({ html: body.html, text: body.text });
  });
});

describe('loadMessageBody', () => {
  it('returns inline body when not offloaded', async () => {
    const got = await loadMessageBody({ html_body: '<p>x</p>', text_body: 'x', body_storage: 'inline', body_object_key: null });
    expect(got).toEqual({ html: '<p>x</p>', text: 'x' });
  });

  it('reads from the active store when offloaded', async () => {
    const client = new InMemoryObjectClient();
    const store = new S3Store(client);
    setBodyStore(store);
    const ptr = await store.put(body);
    const got = await loadMessageBody({ html_body: null, text_body: null, body_storage: 's3', body_object_key: ptr.object_key });
    expect(got).toEqual(body);
  });
});

describe('getBodyStore selection', () => {
  it('defaults to inline', () => {
    setBodyStore(null);
    delete process.env.BODY_STORAGE;
    expect(getBodyStore().kind).toBe('inline');
  });
});
