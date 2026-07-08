// Human password hashing.
//
// API keys use a fast HMAC (apikeys.ts) because they're high-entropy. Human
// passwords are the opposite — low-entropy and guessable — so they need a slow,
// memory-hard KDF. We use scrypt from node:crypto: no native dependency, no
// bcrypt 72-byte truncation, and memory-hardness that GPUs/ASICs struggle with.
//
// Stored format is self-describing so parameters can be raised over time and old
// hashes still verify (and can be transparently upgraded on next login):
//
//   scrypt$<N>$<r>$<p>$<salt_b64url>$<hash_b64url>
//
// Verification is constant-time. A password that needs rehashing (because the
// stored cost is below current policy) is flagged so the caller can re-hash.

import crypto from 'node:crypto';

// Current cost parameters. N must be a power of two; 2^15 with r=8 is a sane
// interactive-login default (~tens of ms). maxmem is raised to fit N*r*128.
const N = 1 << 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;
const MAXMEM = 128 * N * R * 2;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, dk) => {
      if (err) reject(err);
      else resolve(dk);
    });
  });
}

/** Hash a plaintext password. Returns the self-describing stored string. */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('password must be a non-empty string');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const dk = await scryptAsync(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  try {
    return { n, r, p, salt: Buffer.from(parts[4]!, 'base64url'), hash: Buffer.from(parts[5]!, 'base64url') };
  } catch {
    return null;
  }
}

export interface VerifyResult {
  ok: boolean;
  /** True when the stored hash used weaker params than current policy. */
  needsRehash: boolean;
}

/**
 * Verify a password against a stored hash in constant time. Returns whether it
 * matched and whether the hash should be upgraded (re-hashed) on success.
 */
export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  const parsed = parse(stored);
  if (!parsed) return { ok: false, needsRehash: false };
  const candidate = await scryptAsync(password, parsed.salt, parsed.n, parsed.r, parsed.p);
  // Lengths can differ if KEYLEN policy changed; timingSafeEqual requires equal
  // length, so guard first (the length itself isn't a secret).
  const ok =
    candidate.length === parsed.hash.length && crypto.timingSafeEqual(candidate, parsed.hash);
  const needsRehash = ok && (parsed.n < N || parsed.r < R || parsed.p < P || parsed.hash.length < KEYLEN);
  return { ok, needsRehash };
}
