// Pluggable master-key provider for envelope encryption.
//
// In production the data-encryption master key should not live in a plain env
// var. This module abstracts the key source so the ciphertext format in
// encryption.ts never changes when you swap providers:
//
//   KMS_PROVIDER=env    -> ENCRYPTION_KEY env var (dev / single-host)
//   KMS_PROVIDER=aws    -> AWS KMS Decrypt (pre-wrapped key in AWS_KMS_ENCRYPTED_KEY)
// GCP is intentionally not selectable: its current client dependency tree
// fails the production vulnerability gate. Re-enable only with a clean client.
//   KMS_PROVIDER=vault  -> HashiCorp Vault Transit decrypt (VAULT_ENCRYPTED_KEY)
//
// Setup: for each cloud provider, generate the master key once and wrap it:
//
//   AWS:   openssl rand 32 | base64 > key.b64
//          aws kms encrypt --key-id <ARN> --plaintext fileb://key.b64 \
//            --query CiphertextBlob --output text > AWS_KMS_ENCRYPTED_KEY
//
//   GCP:   openssl rand 32 | base64 > key.b64
//          gcloud kms encrypt --key <KEY_NAME> --plaintext-file key.b64 \
//            --ciphertext-file - | base64 > GCP_KMS_ENCRYPTED_KEY
//
//   Vault: openssl rand 32 | base64 -w0 > key.b64
//          vault write transit/encrypt/<KEY> plaintext=$(cat key.b64)
//            → store the vault:v1:... ciphertext as VAULT_ENCRYPTED_KEY

export interface MasterKeyProvider {
  readonly name: string;
  /** Return the preloaded 32-byte data-encryption key used by AES-256-GCM. */
  getKey(): Buffer;
  /** Resolve and validate remote key access before the process starts work. */
  preload(): Promise<void>;
  /** Optional: rotate the underlying key. */
  rotate?(): Promise<void>;
}

function decodeKey(raw: string): Buffer {
  let key: Buffer;
  if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`master key must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}

class EnvKeyProvider implements MasterKeyProvider {
  readonly name = 'env';
  async preload(): Promise<void> {
    this.getKey();
  }
  getKey(): Buffer {
    const raw = process.env.ENCRYPTION_KEY;
    if (!raw) throw new Error('ENCRYPTION_KEY is required for KMS_PROVIDER=env');
    return decodeKey(raw);
  }
}

// ---- AWS KMS ---------------------------------------------------------------
// Uses DecryptCommand on a pre-wrapped key (AWS_KMS_ENCRYPTED_KEY).
// This is stable: the wrapped key is fixed at setup time and decryption always
// returns the same 32-byte plaintext, making old ciphertexts permanently
// readable. GenerateDataKey was previously used here but is wrong for this
// purpose — it issues a NEW random key each call, so after a cache miss any
// data encrypted with the previous key becomes unreadable.
//
// Required env vars:
//   AWS_KMS_ENCRYPTED_KEY — base64 CiphertextBlob from `aws kms encrypt`
//   AWS_REGION            — or use the standard AWS SDK credential chain
class AwsKmsProvider implements MasterKeyProvider {
  readonly name = 'aws';
  private cachedKey: Buffer | null = null;
  private cachedAt = 0;
  private readonly ttlMs: number;

  constructor() {
    this.ttlMs = Number(process.env.KMS_CACHE_TTL_MS ?? 300_000);
  }

  getKey(): Buffer {
    const now = Date.now();
    if (this.cachedKey && now - this.cachedAt < this.ttlMs) return this.cachedKey;
    throw new Error('AWS KMS master key is not preloaded; call preloadMasterKey() during startup');
  }

  async preload(): Promise<void> {
    const encryptedKey = process.env.AWS_KMS_ENCRYPTED_KEY;
    if (!encryptedKey) throw new Error('AWS_KMS_ENCRYPTED_KEY is required for KMS_PROVIDER=aws (base64 CiphertextBlob from aws kms encrypt)');

    const { KMSClient, DecryptCommand } = await import('@aws-sdk/client-kms' as string) as any;
    const client = new KMSClient({ region: process.env.AWS_REGION });
    const res = await client.send(new DecryptCommand({
      CiphertextBlob: Buffer.from(encryptedKey, 'base64'),
    }));

    if (!res.Plaintext || res.Plaintext.length !== 32) {
      throw new Error(`AWS KMS Decrypt returned unexpected key length: ${(res.Plaintext as Uint8Array | undefined)?.length ?? 0}`);
    }
    this.cachedKey = Buffer.from(res.Plaintext as Uint8Array);
    this.cachedAt = Date.now();
  }
}

// ---- GCP KMS ---------------------------------------------------------------
// Uses CryptoKey.decrypt on a pre-wrapped key (GCP_KMS_ENCRYPTED_KEY).
//
// Required env vars:
//   GCP_KMS_KEY_NAME    — full resource name:
//                         projects/P/locations/L/keyRings/R/cryptoKeys/K
//   GCP_KMS_ENCRYPTED_KEY — base64 ciphertext from `gcloud kms encrypt`
//   GOOGLE_APPLICATION_CREDENTIALS — service-account JSON path (standard ADC)
class GcpKmsProvider implements MasterKeyProvider {
  readonly name = 'gcp';
  private cachedKey: Buffer | null = null;
  private cachedAt = 0;
  private readonly ttlMs: number;

  constructor() {
    this.ttlMs = Number(process.env.KMS_CACHE_TTL_MS ?? 300_000);
  }

  getKey(): Buffer {
    const now = Date.now();
    if (this.cachedKey && now - this.cachedAt < this.ttlMs) return this.cachedKey;
    throw new Error('GCP KMS master key is not preloaded; call preloadMasterKey() during startup');
  }

  async preload(): Promise<void> {
    const keyName = process.env.GCP_KMS_KEY_NAME;
    const encryptedKey = process.env.GCP_KMS_ENCRYPTED_KEY;
    if (!keyName) throw new Error('GCP_KMS_KEY_NAME required for KMS_PROVIDER=gcp');
    if (!encryptedKey) throw new Error('GCP_KMS_ENCRYPTED_KEY required for KMS_PROVIDER=gcp');

    const { KeyManagementServiceClient } = await import('@google-cloud/kms' as string) as any;
    const client = new KeyManagementServiceClient();
    const [result] = await client.decrypt({
      name: keyName,
      ciphertext: Buffer.from(encryptedKey, 'base64'),
    });

    const plaintext = Buffer.from(result.plaintext as Uint8Array);
    if (plaintext.length !== 32) {
      throw new Error(`GCP KMS decrypt returned unexpected key length: ${plaintext.length}`);
    }
    this.cachedKey = plaintext;
    this.cachedAt = Date.now();
  }
}

// ---- HashiCorp Vault Transit -----------------------------------------------
// Uses the Transit secrets engine to decrypt a pre-encrypted key.
// No external SDK — uses Node's built-in fetch (Node 18+).
//
// Required env vars:
//   VAULT_ADDR           — Vault server URL (e.g. https://vault.example.com)
//   VAULT_TOKEN          — token with read access to transit/decrypt/<KEY>
//                          (or set VAULT_ROLE_ID + VAULT_SECRET_ID for AppRole,
//                           then extend this class to call /v1/auth/approle/login)
//   VAULT_TRANSIT_KEY    — key name in the Transit engine (e.g. mail-platform)
//   VAULT_ENCRYPTED_KEY  — vault:v1:... ciphertext from `vault write transit/encrypt/<KEY>`
//   VAULT_TRANSIT_MOUNT  — optional, defaults to "transit"
class VaultKmsProvider implements MasterKeyProvider {
  readonly name = 'vault';
  private cachedKey: Buffer | null = null;
  private cachedAt = 0;
  private readonly ttlMs: number;

  constructor() {
    this.ttlMs = Number(process.env.KMS_CACHE_TTL_MS ?? 300_000);
  }

  getKey(): Buffer {
    const now = Date.now();
    if (this.cachedKey && now - this.cachedAt < this.ttlMs) return this.cachedKey;
    throw new Error('Vault KMS master key is not preloaded; call preloadMasterKey() during startup');
  }

  async preload(): Promise<void> {
    const addr = process.env.VAULT_ADDR;
    const token = process.env.VAULT_TOKEN;
    const key = process.env.VAULT_TRANSIT_KEY;
    const ciphertext = process.env.VAULT_ENCRYPTED_KEY;
    const mount = process.env.VAULT_TRANSIT_MOUNT ?? 'transit';

    if (!addr) throw new Error('VAULT_ADDR required for KMS_PROVIDER=vault');
    if (!token) throw new Error('VAULT_TOKEN required for KMS_PROVIDER=vault');
    if (!key) throw new Error('VAULT_TRANSIT_KEY required for KMS_PROVIDER=vault');
    if (!ciphertext) throw new Error('VAULT_ENCRYPTED_KEY required for KMS_PROVIDER=vault');

    const url = `${addr.replace(/\/$/, '')}/v1/${mount}/decrypt/${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Vault-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ciphertext }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Vault Transit decrypt failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as any;
    const plaintext = Buffer.from(json?.data?.plaintext as string, 'base64');
    if (plaintext.length !== 32) {
      throw new Error(`Vault Transit decrypt returned unexpected key length: ${plaintext.length}`);
    }
    this.cachedKey = plaintext;
    this.cachedAt = Date.now();
  }
}

let cached: MasterKeyProvider | null = null;

export function getMasterKeyProvider(): MasterKeyProvider {
  if (cached) return cached;
  const provider = (process.env.KMS_PROVIDER ?? 'env').toLowerCase();
  switch (provider) {
    case 'env':
      cached = new EnvKeyProvider();
      break;
    case 'aws':
      cached = new AwsKmsProvider();
      break;
    case 'vault':
      cached = new VaultKmsProvider();
      break;
    default:
      throw new Error(`unknown KMS_PROVIDER: ${provider}`);
  }
  return cached;
}

export async function preloadMasterKey(): Promise<{ provider: string }> {
  const provider = getMasterKeyProvider();
  await provider.preload();
  const key = provider.getKey();
  if (key.length !== 32) throw new Error(`master key must be 32 bytes, got ${key.length}`);
  return { provider: provider.name };
}

export function resetMasterKeyProvider(): void {
  cached = null;
}
