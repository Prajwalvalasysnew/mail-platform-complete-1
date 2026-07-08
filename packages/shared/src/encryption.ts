// Envelope encryption for secrets at rest (DKIM private keys).
// Uses AES-256-GCM with a master key from ENCRYPTION_KEY env var.
//
// In production, ENCRYPTION_KEY should come from a KMS / secrets manager,
// not a plain env var. The format here is portable enough to swap the
// key source without changing the stored ciphertext format.

import crypto from 'node:crypto';
import { getMasterKeyProvider } from './kms.js';

const ALGO = 'aes-256-gcm';

function getMasterKey(): Buffer {
  // The KMS provider abstracts the key source (env / AWS / GCP / Vault) without
  // changing the ciphertext format. The default 'env' provider is synchronous;
  // cloud providers that need an async fetch should cache the data key so this
  // stays effectively synchronous on the hot path.
  const provider = getMasterKeyProvider();
  const key = provider.getKey();
  if (key instanceof Promise) {
    throw new Error(
      'async KMS provider selected — call getMasterKeyAsync() / preload the data key before encrypt/decrypt'
    );
  }
  if (key.length !== 32) {
    throw new Error(`master key must be 32 bytes, got ${key.length}`);
  }
  return key;
}

/**
 * Encrypt plaintext. Returns a self-describing string:
 *   v1:<iv-base64>:<authtag-base64>:<ciphertext-base64>
 */
export function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decrypt a string produced by encryptSecret.
 * Backwards-compatible: if the value doesn't start with "v1:", it's assumed
 * to be legacy plaintext and returned as-is (eases migration).
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith('v1:')) {
    return stored; // legacy plaintext
  }
  const key = getMasterKey();
  const [, ivB64, tagB64, ctB64] = stored.split(':') as [string, string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith('v1:');
}
