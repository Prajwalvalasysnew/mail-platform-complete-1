import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

/**
 * Generate a new API key in the format mp_live_<32 random chars>.
 * Returns the plaintext key (only shown once to the user) and a bcrypt hash to store.
 */
export async function generateApiKey(): Promise<{
  plaintext: string;
  prefix: string;
  hash: string;
}> {
  const random = crypto.randomBytes(24).toString('base64url');
  const plaintext = `mp_live_${random}`;
  const prefix = plaintext.slice(0, 12);
  const hash = await bcrypt.hash(plaintext, 10);
  return { plaintext, prefix, hash };
}

export async function verifyApiKey(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

/**
 * Sign a webhook payload with HMAC-SHA256. The customer verifies using their webhook secret.
 */
export function signWebhook(secret: string, body: string, timestamp: number): string {
  const payload = `${timestamp}.${body}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Generate a unique RFC 5322 Message-ID for outgoing mail.
 */
export function generateMessageId(domain: string): string {
  const id = crypto.randomBytes(16).toString('hex');
  return `<${id}@${domain}>`;
}

/**
 * Encode a message ID for use in tracking URLs (strip the angle brackets and @).
 */
export function encodeMessageIdForUrl(messageId: string): string {
  return Buffer.from(messageId.replace(/[<>]/g, '')).toString('base64url');
}

export function decodeMessageIdFromUrl(encoded: string): string {
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  return `<${decoded}>`;
}

// =====================================================
// VERP bounce-token signing (tamper-resistant return-path)
// =====================================================
// Without a signature, anyone can craft bounce+<any-message-id>@bounces.domain
// and forge a bounce/complaint that suppresses an arbitrary recipient. We sign
// the encoded message-id with HMAC-SHA256 (truncated) and embed the tag in the
// local-part. The inbound parser verifies the tag before honoring the bounce.
//
// Local-part format: bounce+<encoded>.<sig8>
//   encoded = base64url(full message-id without < >)
//   sig8    = first 8 bytes of HMAC-SHA256(VERP_SECRET, encoded), base64url
//
// VERP_SECRET must be identical in the worker (which builds the return-path)
// and the inbound Haraka plugin (which verifies it).

function verpSecret(): string {
  const s = process.env.VERP_SECRET;
  if (!s || s.length < 16) {
    throw new Error('VERP_SECRET is required (>= 16 chars) for signed bounce return-paths');
  }
  return s;
}

function verpTag(encoded: string, secret = verpSecret()): string {
  return crypto
    .createHmac('sha256', secret)
    .update(encoded)
    .digest()
    .subarray(0, 8)
    .toString('base64url');
}

/**
 * Build the signed local-part token for a VERP return-path, given a Message-ID.
 * Returns e.g. "bounce+<encoded>.<sig>" — caller appends "@<bounce-domain>".
 */
export function buildVerpToken(messageId: string): string {
  const normalized = messageId.replace(/[<>]/g, '');
  const encoded = Buffer.from(normalized).toString('base64url');
  return `bounce+${encoded}.${verpTag(encoded)}`;
}

/**
 * Verify a VERP local-part (the part before @) and return the original
 * Message-ID, or null if the signature is missing/invalid. Uses a
 * constant-time comparison to avoid timing oracles.
 */
export function verifyVerpToken(localPart: string): string | null {
  const m = localPart.match(/^bounce\+([^.@]+)\.([^.@]+)$/i);
  if (!m) return null;
  const [, encoded, sig] = m as [string, string, string];
  let expected: string;
  try {
    expected = verpTag(encoded);
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8').replace(/[<>]/g, '');
  return `<${decoded}>`;
}
