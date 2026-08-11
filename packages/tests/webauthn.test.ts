// WebAuthn / passkeys. Drives the real registration + authentication ceremonies
// end-to-end with a synthetic P-256 authenticator built in-test (CBOR-encoded
// attestationObject + COSE key, real ECDSA assertion signatures), proving:
// challenge binding + single use, origin binding, COSE->key conversion, assertion
// verification, and signature-counter clone detection.

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  db, registerPasskey, authenticatePasskey, issueWebauthnChallenge, consumeWebauthnChallenge,
  listPasskeys, deletePasskey, decodeCbor, registerOrgWithOwner,
} from '@platform/shared';

const RP_ID = 'mail.example.com';
const ORIGIN = 'https://mail.example.com';

let seq = 0;
async function seedUser(tier: 'free' | 'paid' | 'enterprise' = 'free'): Promise<{ userId: string; customerId: string }> {
  const res = await registerOrgWithOwner({ email: `pk-${Date.now()}-${seq++}@example.com`, password: 'a-good-long-password', orgName: 'PK Org' });
  await db.updateTable('customers').set({ tier }).where('id', '=', res.customerId).execute();
  return { userId: res.user.id, customerId: res.customerId };
}

// ── tiny CBOR encoder (test-only) ───────────────────────────────────────────
const majorLen = (major: number, len: number): Buffer => {
  const m = major << 5;
  if (len < 24) return Buffer.from([m | len]);
  if (len < 256) return Buffer.from([m | 24, len]);
  const b = Buffer.alloc(3); b[0] = m | 25; b.writeUInt16BE(len, 1); return b;
};
const cUint = (n: number) => majorLen(0, n);
const cNeg = (n: number) => majorLen(1, -1 - n); // n is negative
const cBytes = (b: Buffer) => Buffer.concat([majorLen(2, b.length), b]);
const cText = (s: string) => { const b = Buffer.from(s); return Buffer.concat([majorLen(3, b.length), b]); };
const cMap = (entries: [Buffer, Buffer][]) => Buffer.concat([majorLen(5, entries.length), ...entries.flat()]);
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest();
const fixed = (b64url: string) => { const b = Buffer.from(b64url, 'base64url'); return b.length === 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b]); };

// A synthetic P-256 passkey.
function makeAuthenticator() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cose = cMap([
    [cUint(1), cUint(2)],       // kty: EC2
    [cUint(3), cNeg(-7)],       // alg: ES256
    [cNeg(-1), cUint(1)],       // crv: P-256
    [cNeg(-2), cBytes(fixed(jwk.x))],
    [cNeg(-3), cBytes(fixed(jwk.y))],
  ]);
  const credentialId = crypto.randomBytes(16);
  return { privateKey, cose, credentialId };
}

function authDataWithCredential(cose: Buffer, credentialId: Buffer, signCount = 0): Buffer {
  const rpIdHash = sha256(Buffer.from(RP_ID));
  const flags = Buffer.from([0x45]); // UP | UV | AT
  const sc = Buffer.alloc(4); sc.writeUInt32BE(signCount);
  const aaguid = Buffer.alloc(16);
  const credLen = Buffer.alloc(2); credLen.writeUInt16BE(credentialId.length);
  return Buffer.concat([rpIdHash, flags, sc, aaguid, credLen, credentialId, cose]);
}

function assertionAuthData(signCount: number): Buffer {
  const rpIdHash = sha256(Buffer.from(RP_ID));
  const sc = Buffer.alloc(4); sc.writeUInt32BE(signCount);
  return Buffer.concat([rpIdHash, Buffer.from([0x05]), sc]); // UP | UV, no AT
}

const clientData = (type: string, challenge: string, origin = ORIGIN) =>
  Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

async function register(userId: string, auth: ReturnType<typeof makeAuthenticator>) {
  const challenge = await issueWebauthnChallenge(userId, 'register');
  const attestationObject = cMap([
    [cText('fmt'), cText('none')],
    [cText('attStmt'), cMap([])],
    [cText('authData'), cBytes(authDataWithCredential(auth.cose, auth.credentialId))],
  ]);
  return registerPasskey({ userId, rpId: RP_ID, origins: [ORIGIN],
    clientDataJSON: clientData('webauthn.create', challenge), attestationObject, name: 'Test Key' });
}

async function authenticate(userId: string, auth: ReturnType<typeof makeAuthenticator>, signCount: number, origin = ORIGIN) {
  const challenge = await issueWebauthnChallenge(userId, 'authenticate');
  const cdj = clientData('webauthn.get', challenge, origin);
  const authData = assertionAuthData(signCount);
  const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(cdj)]), auth.privateKey);
  return authenticatePasskey({ userId, rpId: RP_ID, origins: [ORIGIN],
    credentialId: auth.credentialId.toString('base64url'), clientDataJSON: cdj, authenticatorData: authData, signature });
}

describe('WebAuthn passkeys', () => {
  it.each(['free', 'paid', 'enterprise'] as const)(
    'completes the passkey lifecycle for the %s tier',
    async (tier) => {
      const u = await seedUser(tier);
      const auth = makeAuthenticator();
      expect(await register(u.userId, auth)).toMatchObject({ ok: true, alg: -7 });
      expect(await authenticate(u.userId, auth, 1)).toMatchObject({ ok: true, userId: u.userId });
      const [credential] = await listPasskeys(u.userId);
      expect(credential).toMatchObject({ name: 'Test Key' });
      const stored = await db.selectFrom('webauthn_credentials').select('sign_count')
        .where('id', '=', credential!.id).executeTakeFirstOrThrow();
      expect(Number(stored.sign_count)).toBe(1);
      expect(await deletePasskey(u.userId, credential!.id)).toBe(true);
      expect(await listPasskeys(u.userId)).toHaveLength(0);
      expect(await db.selectFrom('customers').select('tier')
        .where('id', '=', u.customerId).executeTakeFirstOrThrow()).toMatchObject({ tier });
    },
  );

  it('CBOR round-trips a COSE map', () => {
    const decoded = decodeCbor(cMap([[cUint(1), cUint(2)], [cUint(3), cNeg(-7)]])) as Map<number, number>;
    expect(decoded.get(1)).toBe(2);
    expect(decoded.get(3)).toBe(-7);
  });

  it('registers a passkey and lists it', async () => {
    const u = await seedUser();
    const auth = makeAuthenticator();
    const r = await register(u.userId, auth);
    expect(r).toMatchObject({ ok: true, alg: -7 });
    const keys = await listPasskeys(u.userId);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ name: 'Test Key' });
  });

  it('authenticates with a real assertion signature and advances the counter', async () => {
    const u = await seedUser();
    const auth = makeAuthenticator();
    await register(u.userId, auth);
    const r = await authenticate(u.userId, auth, 1);
    expect(r).toMatchObject({ ok: true, userId: u.userId });
    const stored = await db.selectFrom('webauthn_credentials').select('sign_count').where('user_id', '=', u.userId).executeTakeFirstOrThrow();
    expect(Number(stored.sign_count)).toBe(1);
  });

  it('detects a cloned authenticator (counter did not advance)', async () => {
    const u = await seedUser();
    const auth = makeAuthenticator();
    await register(u.userId, auth);
    await authenticate(u.userId, auth, 5);
    const replay = await authenticate(u.userId, auth, 5); // same counter → clone
    expect(replay).toMatchObject({ ok: false, error: 'possible_cloned_authenticator' });
  });

  it('rejects a tampered signature and a wrong origin', async () => {
    const u = await seedUser();
    const auth = makeAuthenticator();
    await register(u.userId, auth);

    // wrong origin
    const bad = await authenticate(u.userId, auth, 2, 'https://evil.example.com');
    expect(bad).toMatchObject({ ok: false, error: 'origin_mismatch' });

    // tampered signature
    const challenge = await issueWebauthnChallenge(u.userId, 'authenticate');
    const cdj = clientData('webauthn.get', challenge);
    const authData = assertionAuthData(3);
    const sig = crypto.sign('sha256', Buffer.concat([authData, sha256(cdj)]), auth.privateKey);
    sig[10] = sig[10]! ^ 0xff;
    const r = await authenticatePasskey({ userId: u.userId, rpId: RP_ID, origins: [ORIGIN],
      credentialId: auth.credentialId.toString('base64url'), clientDataJSON: cdj, authenticatorData: authData, signature: sig });
    expect(r).toMatchObject({ ok: false, error: 'bad_signature' });
  });

  it('enforces single-use challenges', async () => {
    const u = await seedUser();
    const challenge = await issueWebauthnChallenge(u.userId, 'authenticate');
    expect(await consumeWebauthnChallenge(u.userId, 'authenticate', challenge)).toBe(true);
    expect(await consumeWebauthnChallenge(u.userId, 'authenticate', challenge)).toBe(false); // replay
  });

  it('deletes a passkey (owner-scoped)', async () => {
    const u = await seedUser();
    const other = await seedUser();
    const auth = makeAuthenticator();
    await register(u.userId, auth);
    const [key] = await listPasskeys(u.userId);
    expect(await deletePasskey(other.userId, key!.id)).toBe(false); // cross-user
    expect(await deletePasskey(u.userId, key!.id)).toBe(true);
    expect(await listPasskeys(u.userId)).toHaveLength(0);
  });
});
