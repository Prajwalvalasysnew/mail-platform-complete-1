// TOTP (RFC 6238) multi-factor authentication — dependency-free.
//
// Implements the standard authenticator-app second factor (Google Authenticator,
// 1Password, Authy, etc.): a base32 shared secret, HMAC-SHA1 over a 30-second
// time counter, truncated to N digits. Also provides the otpauth:// provisioning
// URI (for QR codes) and one-time recovery codes.
//
// The default verification window of ±1 step tolerates clock skew without
// meaningfully widening the attack surface. Verification is constant-time.

import crypto from 'node:crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;

// ---- base32 (RFC 4648, no padding) ----
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/,'').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Generate a new random TOTP secret as a base32 string (160 bits). */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * Compute the TOTP/HOTP code for a given secret. Exposed with full parameters
 * mainly so it can be validated against the RFC 6238 test vectors; callers
 * normally use verifyTotp().
 */
export function totpCode(
  secretBase32: string,
  forTime: number = Date.now(),
  opts: { step?: number; digits?: number; t0?: number } = {}
): string {
  const step = opts.step ?? STEP_SECONDS;
  const digits = opts.digits ?? DIGITS;
  const t0 = opts.t0 ?? 0;
  const counter = Math.floor((Math.floor(forTime / 1000) - t0) / step);

  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter.
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();

  // Dynamic truncation (RFC 4226 §5.3).
  const offset = hmac[hmac.length - 1]! & 0x0f; // SHA-1 HMAC is always 20 bytes
  const binCode =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (binCode % 10 ** digits).toString().padStart(digits, '0');
}

/**
 * Like verifyTotp, but returns the matched time-step counter (or null if no
 * match). The counter lets callers enforce single-use: persist the highest
 * consumed step and reject any future code whose step is <= it (RFC 6238 §5.2),
 * preventing replay of a code within its ±window validity period.
 */
export function verifyTotpStep(
  secretBase32: string,
  token: string,
  opts: { window?: number; step?: number; digits?: number; forTime?: number } = {}
): number | null {
  const window = opts.window ?? 1;
  const step = opts.step ?? STEP_SECONDS;
  const digits = opts.digits ?? DIGITS;
  const now = opts.forTime ?? Date.now();
  const t0 = 0;
  const cleaned = token.replace(/\s/g, '');
  if (!/^\d+$/.test(cleaned) || cleaned.length !== digits) return null;

  let matchedCounter: number | null = null;
  // Iterate the full window regardless of early match to keep timing flat.
  for (let i = -window; i <= window; i++) {
    const forTime = now + i * step * 1000;
    const candidate = totpCode(secretBase32, forTime, { step, digits });
    const a = Buffer.from(candidate);
    const b = Buffer.from(cleaned);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      matchedCounter = Math.floor((Math.floor(forTime / 1000) - t0) / step);
    }
  }
  return matchedCounter;
}

/**
 * Verify a user-supplied TOTP token against a secret, allowing +/- `window`
 * steps of clock skew. Constant-time per-candidate comparison.
 */
export function verifyTotp(
  secretBase32: string,
  token: string,
  opts: { window?: number; step?: number; digits?: number; forTime?: number } = {}
): boolean {
  return verifyTotpStep(secretBase32, token, opts) !== null;
}

/** Build the otpauth:// URI used to render an enrollment QR code. */
export function otpauthUri(secretBase32: string, accountName: string, issuer: string): string {
  // Per the otpauth spec the label is "issuer:account"; encode the two parts
  // separately so the colon separator stays literal (some authenticator apps
  // mishandle a percent-encoded %3A separator).
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---- recovery codes ----
function recoveryPepper(): string {
  const p = process.env.MFA_RECOVERY_PEPPER ?? process.env.ADMIN_SESSION_PEPPER ?? process.env.JWT_SECRET;
  if (!p) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MFA_RECOVERY_PEPPER (or JWT_SECRET) is required in production');
    }
    return 'dev-recovery-pepper';
  }
  return p;
}

/** HMAC hash for a recovery code (codes are high-entropy, so HMAC is sufficient). */
export function hashRecoveryCode(code: string): string {
  return crypto.createHmac('sha256', recoveryPepper()).update(code.replace(/\s/g, '').toLowerCase()).digest('base64url');
}

export function verifyRecoveryCode(code: string, storedHash: string): boolean {
  const a = Buffer.from(hashRecoveryCode(code));
  const b = Buffer.from(storedHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Generate N human-friendly recovery codes (shown once) with their hashes (to
 * store). Format: xxxx-xxxx using an unambiguous alphabet.
 */
export function generateRecoveryCodes(count = 10): Array<{ code: string; hash: string }> {
  const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no l/i/o/0/1
  const make = () => {
    const pick = () =>
      Array.from(crypto.randomBytes(4))
        .map((b) => ALPHABET[b % ALPHABET.length])
        .join('');
    return `${pick()}-${pick()}`;
  };
  return Array.from({ length: count }, () => {
    const code = make();
    return { code, hash: hashRecoveryCode(code) };
  });
}
