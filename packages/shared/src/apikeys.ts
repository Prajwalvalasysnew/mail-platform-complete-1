// API key generation + verification.
//
// API keys are high-entropy random tokens, not low-entropy human passwords, so
// bcrypt's deliberate slowness buys almost nothing while adding latency and a
// CPU-DoS vector on the auth hot path. We verify with a fast keyed hash —
// HMAC-SHA256(pepper, key) — and a constant-time comparison.
//
// The pepper (API_KEY_PEPPER) should come from a KMS / secrets manager. Stored
// hashes produced with this scheme are prefixed "hmac:" so we can tell them
// apart from any legacy bcrypt hashes ("$2...") and verify both during a
// migration window.
//
// Key formats:
//   mp_live_<random>  — production secret key (real delivery)
//   mp_test_<random>  — sandbox/test key (routed to a no-op transport)
//   mp_pub_<random>   — publishable key (safe to embed client-side; limited scopes)

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export type KeyType = 'secret' | 'test' | 'publishable';

const PREFIXES: Record<KeyType, string> = {
  secret: 'mp_live_',
  test: 'mp_test_',
  publishable: 'mp_pub_',
};

function pepper(): string {
  const p = process.env.API_KEY_PEPPER;
  // Fall back to JWT_SECRET only outside production so local dev works without
  // an extra var; production deployments must set API_KEY_PEPPER explicitly.
  if (!p) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('API_KEY_PEPPER is required in production');
    }
    return process.env.JWT_SECRET ?? 'dev-pepper-not-for-production';
  }
  return p;
}

export function hashApiKey(plaintext: string): string {
  const mac = crypto.createHmac('sha256', pepper()).update(plaintext).digest('base64url');
  return `hmac:${mac}`;
}

/**
 * Generate a new API key. Returns the plaintext (shown once), the lookup prefix,
 * and the stored hash.
 */
export function generateApiKeyV2(type: KeyType = 'secret'): {
  plaintext: string;
  prefix: string;
  hash: string;
  key_type: KeyType;
} {
  const random = crypto.randomBytes(24).toString('base64url');
  const plaintext = `${PREFIXES[type]}${random}`;
  // 12-char prefix is enough to make the candidate set ~1 row in practice.
  const prefix = plaintext.slice(0, 12);
  return { plaintext, prefix, hash: hashApiKey(plaintext), key_type: type };
}

/**
 * Constant-time verification supporting both the fast HMAC scheme and any
 * legacy bcrypt hashes (so existing keys keep working during migration).
 */
export async function verifyApiKeyV2(plaintext: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith('hmac:')) {
    const expected = hashApiKey(plaintext);
    const a = Buffer.from(storedHash);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  // Legacy bcrypt hash ($2a/$2b/$2y...)
  if (storedHash.startsWith('$2')) {
    return bcrypt.compare(plaintext, storedHash);
  }
  return false;
}

export function detectKeyType(plaintext: string): KeyType | null {
  if (plaintext.startsWith(PREFIXES.test)) return 'test';
  if (plaintext.startsWith(PREFIXES.publishable)) return 'publishable';
  if (plaintext.startsWith(PREFIXES.secret)) return 'secret';
  return null;
}
