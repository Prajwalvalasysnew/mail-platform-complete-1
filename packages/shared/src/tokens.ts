// Shared helpers for opaque tokens (sessions, invites, email/reset links).
//
// Tokens are high-entropy random strings shown once; we persist only an HMAC of
// them (keyed by a pepper) so a database leak does not expose usable tokens.
// Verification is by hash-equality on an indexed column, so it's already
// effectively constant-time at the DB layer.

import crypto from 'node:crypto';

export function randomToken(prefix = '', bytes = 32): string {
  return `${prefix}${crypto.randomBytes(bytes).toString('base64url')}`;
}

export function hmacToken(token: string, pepper: string): string {
  return crypto.createHmac('sha256', pepper).update(token).digest('base64url');
}

/** Pepper for human session/invite/link tokens. Distinct from API-key pepper. */
export function userTokenPepper(): string {
  const p = process.env.USER_SESSION_PEPPER ?? process.env.ADMIN_SESSION_PEPPER ?? process.env.JWT_SECRET;
  if (!p) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('USER_SESSION_PEPPER (or JWT_SECRET) is required in production');
    }
    return 'dev-user-token-pepper';
  }
  return p;
}

export function hashUserToken(token: string): string {
  return hmacToken(token, userTokenPepper());
}
