// WebAuthn / passkeys (phishing-resistant MFA).
//
// A self-contained implementation of the two WebAuthn ceremonies (registration
// and authentication) sufficient for platform authenticators / passkeys:
//   - a minimal CBOR decoder (only the types WebAuthn uses),
//   - COSE EC2 (ES256) / OKP (Ed25519) public keys -> SPKI,
//   - clientDataJSON validation (type / challenge / origin),
//   - assertion signature verification + signature-counter clone detection,
//   - single-use challenge lifecycle.
//
// Scope: we accept "none" attestation (the common passkey case) and do NOT
// validate attestation certificate chains (packed/tpm/android-key) — that trust
// decision is deployment-specific and tracked as follow-up. The cryptographic
// core (challenge binding, origin binding, assertion verification, clone
// detection) is fully implemented and tested.

import crypto from 'node:crypto';
import { db } from './db.js';

const CHALLENGE_TTL_MS = Number(process.env.WEBAUTHN_CHALLENGE_TTL_MS ?? 5 * 60_000);

// ── Minimal CBOR decoder ────────────────────────────────────────────────────
// Supports unsigned/negative ints, byte/text strings, arrays and maps — enough
// for COSE keys and the attestationObject. Rejects anything else.
interface CborResult { value: unknown; offset: number; }

function decodeItem(buf: Buffer, offset: number): CborResult {
  const first = buf[offset++]!;
  const major = first >> 5;
  const minor = first & 0x1f;
  const readLen = (): { len: number; offset: number } => {
    if (minor < 24) return { len: minor, offset };
    if (minor === 24) return { len: buf[offset]!, offset: offset + 1 };
    if (minor === 25) return { len: buf.readUInt16BE(offset), offset: offset + 2 };
    if (minor === 26) return { len: buf.readUInt32BE(offset), offset: offset + 4 };
    throw new Error('cbor_unsupported_length');
  };
  switch (major) {
    case 0: { const { len, offset: o } = readLen(); return { value: len, offset: o }; }            // uint
    case 1: { const { len, offset: o } = readLen(); return { value: -1 - len, offset: o }; }        // negint
    case 2: { const { len, offset: o } = readLen(); return { value: buf.subarray(o, o + len), offset: o + len }; } // bytes
    case 3: { const { len, offset: o } = readLen(); return { value: buf.subarray(o, o + len).toString('utf8'), offset: o + len }; } // text
    case 4: { // array
      const { len, offset: o } = readLen(); let cur = o; const arr: unknown[] = [];
      for (let i = 0; i < len; i++) { const r = decodeItem(buf, cur); arr.push(r.value); cur = r.offset; }
      return { value: arr, offset: cur };
    }
    case 5: { // map
      const { len, offset: o } = readLen(); let cur = o; const map = new Map<unknown, unknown>();
      for (let i = 0; i < len; i++) { const k = decodeItem(buf, cur); const v = decodeItem(buf, k.offset); map.set(k.value, v.value); cur = v.offset; }
      return { value: map, offset: cur };
    }
    default: throw new Error(`cbor_unsupported_major:${major}`);
  }
}

export function decodeCbor(buf: Buffer): unknown {
  return decodeItem(buf, 0).value;
}

// ── COSE public key -> SPKI ─────────────────────────────────────────────────
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface CoseKey { alg: number; publicKey: crypto.KeyObject; }

/** Convert a COSE_Key (as CBOR bytes or decoded Map) into a Node public key. */
export function coseToPublicKey(cose: Buffer | Map<unknown, unknown>): CoseKey {
  const map = Buffer.isBuffer(cose) ? (decodeCbor(cose) as Map<number, unknown>) : (cose as Map<number, unknown>);
  const kty = Number(map.get(1));
  const alg = Number(map.get(3));
  if (kty === 2) { // EC2
    const crv = Number(map.get(-1));
    if (crv !== 1) throw new Error('webauthn_unsupported_curve');
    const x = map.get(-2) as Buffer, y = map.get(-3) as Buffer;
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new Error('webauthn_bad_ec_point');
    const der = Buffer.concat([P256_SPKI_PREFIX, Buffer.from([0x04]), x, y]);
    return { alg, publicKey: crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }) };
  }
  if (kty === 1) { // OKP (Ed25519)
    const crv = Number(map.get(-1));
    if (crv !== 6) throw new Error('webauthn_unsupported_okp_curve');
    const x = map.get(-2) as Buffer;
    if (!Buffer.isBuffer(x) || x.length !== 32) throw new Error('webauthn_bad_okp_point');
    const der = Buffer.concat([ED25519_SPKI_PREFIX, x]);
    return { alg, publicKey: crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }) };
  }
  throw new Error('webauthn_unsupported_kty');
}

// ── authenticatorData ───────────────────────────────────────────────────────
export interface AuthenticatorData {
  rpIdHash: Buffer;
  flags: number;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  aaguid?: Buffer;
  credentialId?: Buffer;
  credentialPublicKey?: Map<unknown, unknown>;
}

export function parseAuthenticatorData(buf: Buffer): AuthenticatorData {
  if (buf.length < 37) throw new Error('webauthn_authdata_too_short');
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32]!;
  const signCount = buf.readUInt32BE(33);
  const data: AuthenticatorData = { rpIdHash, flags, userPresent: !!(flags & 0x01), userVerified: !!(flags & 0x04), signCount };
  if (flags & 0x40) { // attested credential data present
    const aaguid = buf.subarray(37, 53);
    const credIdLen = buf.readUInt16BE(53);
    const credentialId = buf.subarray(55, 55 + credIdLen);
    const pub = decodeItem(buf, 55 + credIdLen);
    data.aaguid = aaguid;
    data.credentialId = credentialId;
    data.credentialPublicKey = pub.value as Map<unknown, unknown>;
  }
  return data;
}

// ── clientDataJSON ──────────────────────────────────────────────────────────
// Validates the structural bindings (type + origin) and returns the echoed
// challenge for the caller to consume against the single-use DB record. The
// challenge is checked separately (not here) so it can be enforced exactly once.
export interface ClientDataCheck { ok: boolean; reason?: string; challenge?: string }

export function verifyClientData(
  clientDataJSON: Buffer,
  expected: { type: 'webauthn.create' | 'webauthn.get'; origins: string[] }
): ClientDataCheck {
  let parsed: any;
  try { parsed = JSON.parse(clientDataJSON.toString('utf8')); } catch { return { ok: false, reason: 'bad_client_data_json' }; }
  if (parsed.type !== expected.type) return { ok: false, reason: 'type_mismatch' };
  if (typeof parsed.challenge !== 'string' || parsed.challenge.length === 0) return { ok: false, reason: 'missing_challenge' };
  if (!expected.origins.includes(parsed.origin)) return { ok: false, reason: 'origin_mismatch' };
  return { ok: true, challenge: parsed.challenge };
}

function sha256(b: Buffer): Buffer { return crypto.createHash('sha256').update(b).digest(); }
const b64url = (b: Buffer) => b.toString('base64url');

/** Verify an assertion signature over authenticatorData || SHA-256(clientDataJSON). */
export function verifyAssertionSignature(publicKeyPem: string, alg: number, authenticatorData: Buffer, clientDataJSON: Buffer, signature: Buffer): boolean {
  const signedData = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
  const key = crypto.createPublicKey(publicKeyPem);
  try {
    if (alg === -8) return crypto.verify(null, signedData, key, signature);       // EdDSA
    return crypto.verify('sha256', signedData, key, signature);                   // ES256 (DER sig)
  } catch { return false; }
}

// ── Challenge lifecycle (single-use) ────────────────────────────────────────
export async function issueWebauthnChallenge(userId: string | null, purpose: 'register' | 'authenticate'): Promise<string> {
  const challenge = b64url(crypto.randomBytes(32));
  await db.insertInto('webauthn_challenges').values({
    user_id: userId, purpose, challenge, expires_at: new Date(Date.now() + CHALLENGE_TTL_MS) as any,
  }).execute();
  return challenge;
}

/** Consume a challenge exactly once; returns false if missing/expired/replayed. */
export async function consumeWebauthnChallenge(userId: string | null, purpose: 'register' | 'authenticate', challenge: string): Promise<boolean> {
  let q = db.deleteFrom('webauthn_challenges').where('purpose', '=', purpose).where('challenge', '=', challenge);
  q = userId ? q.where('user_id', '=', userId) : q.where('user_id', 'is', null);
  const deleted = await q.returning(['expires_at']).executeTakeFirst();
  if (!deleted) return false;
  return new Date(deleted.expires_at as any).getTime() > Date.now();
}

// ── Registration ceremony ───────────────────────────────────────────────────
export interface RegisterInput {
  userId: string;
  rpId: string;
  origins: string[];
  clientDataJSON: Buffer;
  attestationObject: Buffer;
  name?: string;
}
export type RegisterResult = { ok: true; credentialId: string; alg: number } | { ok: false; error: string };

export async function registerPasskey(input: RegisterInput): Promise<RegisterResult> {
  let attestation: Map<unknown, unknown>;
  try { attestation = decodeCbor(input.attestationObject) as Map<unknown, unknown>; } catch { return { ok: false, error: 'bad_attestation_object' }; }
  const authDataBuf = attestation.get('authData');
  if (!Buffer.isBuffer(authDataBuf)) return { ok: false, error: 'missing_auth_data' };

  const authData = parseAuthenticatorData(authDataBuf);
  if (!authData.userPresent) return { ok: false, error: 'user_not_present' };
  if (!authData.rpIdHash.equals(sha256(Buffer.from(input.rpId)))) return { ok: false, error: 'rp_id_mismatch' };
  if (!authData.credentialId || !authData.credentialPublicKey) return { ok: false, error: 'no_attested_credential' };

  const client = verifyClientData(input.clientDataJSON, { type: 'webauthn.create', origins: input.origins });
  if (!client.ok) return { ok: false, error: client.reason! };
  // Challenge is validated against the single-use DB record, not a fixed value.
  if (!(await consumeWebauthnChallenge(input.userId, 'register', client.challenge!))) return { ok: false, error: 'challenge_invalid' };

  let cose: CoseKey;
  try { cose = coseToPublicKey(authData.credentialPublicKey); } catch (e: any) { return { ok: false, error: e?.message ?? 'bad_cose_key' }; }
  const credentialId = b64url(authData.credentialId);
  const pem = cose.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  await db.insertInto('webauthn_credentials').values({
    user_id: input.userId, credential_id: credentialId, public_key: pem, alg: cose.alg,
    sign_count: authData.signCount, aaguid: authData.aaguid ? authData.aaguid.toString('hex') : null,
    name: input.name ?? null,
  }).onConflict((oc) => oc.column('credential_id').doNothing()).execute();
  return { ok: true, credentialId, alg: cose.alg };
}

// ── Authentication ceremony ─────────────────────────────────────────────────
export interface AuthenticateInput {
  userId?: string; // when known (step-up); omit for usernameless discovery
  rpId: string;
  origins: string[];
  credentialId: string; // base64url
  clientDataJSON: Buffer;
  authenticatorData: Buffer;
  signature: Buffer;
}
export type AuthenticateResult = { ok: true; userId: string; credentialId: string } | { ok: false; error: string };

export async function authenticatePasskey(input: AuthenticateInput): Promise<AuthenticateResult> {
  const cred = await db.selectFrom('webauthn_credentials').selectAll().where('credential_id', '=', input.credentialId).executeTakeFirst();
  if (!cred) return { ok: false, error: 'unknown_credential' };
  if (input.userId && cred.user_id !== input.userId) return { ok: false, error: 'credential_not_owned' };

  const client = verifyClientData(input.clientDataJSON, { type: 'webauthn.get', origins: input.origins });
  if (!client.ok) return { ok: false, error: client.reason! };
  if (!(await consumeWebauthnChallenge(cred.user_id, 'authenticate', client.challenge!))) return { ok: false, error: 'challenge_invalid' };

  const authData = parseAuthenticatorData(input.authenticatorData);
  if (!authData.userPresent) return { ok: false, error: 'user_not_present' };
  if (!authData.rpIdHash.equals(sha256(Buffer.from(input.rpId)))) return { ok: false, error: 'rp_id_mismatch' };

  if (!verifyAssertionSignature(cred.public_key, cred.alg, input.authenticatorData, input.clientDataJSON, input.signature)) {
    return { ok: false, error: 'bad_signature' };
  }

  // Signature-counter clone detection: a non-zero counter that did not advance
  // means two authenticators share the credential (one is a clone).
  const stored = Number(cred.sign_count);
  if (authData.signCount !== 0 && authData.signCount <= stored) return { ok: false, error: 'possible_cloned_authenticator' };
  await db.updateTable('webauthn_credentials').set({ sign_count: authData.signCount, last_used_at: new Date() }).where('id', '=', cred.id).execute();

  return { ok: true, userId: cred.user_id, credentialId: input.credentialId };
}

// ── Management ──────────────────────────────────────────────────────────────
export async function listPasskeys(userId: string) {
  return db.selectFrom('webauthn_credentials')
    .select(['id', 'credential_id', 'name', 'aaguid', 'created_at', 'last_used_at'])
    .where('user_id', '=', userId).orderBy('created_at', 'desc').execute();
}

export async function deletePasskey(userId: string, id: string): Promise<boolean> {
  const row = await db.deleteFrom('webauthn_credentials').where('id', '=', id).where('user_id', '=', userId).returning('id').executeTakeFirst();
  return !!row;
}
