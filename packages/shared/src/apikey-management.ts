// Customer self-service API key management.
//
// Distinct from the admin key endpoints (which act on any customer via an admin
// session/token): these operate strictly within a single org and are called
// from a human dashboard session gated by the `apikeys:manage` capability.
// Every query is org-scoped by customer_id so one org can never see or mutate
// another's keys. Plaintext keys are returned exactly once, at creation/rotation.

import { db } from './db.js';
import { generateApiKeyV2, type KeyType } from './apikeys.js';

// The scopes the platform actually enforces (see api/src/plugins/scope.ts).
// 'classify' (CANSPAM-01) authorizes declaring a non-commercial message class
// on sends; without it every message is treated as commercial (full CAN-SPAM
// treatment). Deliberately separate from 'send' so classification authority
// can be restricted to vetted integrations.
export const API_KEY_SCOPES = ['send', 'domains', 'suppressions', 'messages', 'webhooks', 'templates', 'workflows', 'smtp', 'subaccounts', 'classify'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const API_KEY_TYPES: KeyType[] = ['secret', 'publishable', 'test'];

export type ApiKeyStatus = 'active' | 'revoked' | 'expired';

export interface ApiKeySummary {
  id: string;
  name: string;
  key_prefix: string;
  key_type: KeyType;
  scopes: string[];
  status: ApiKeyStatus;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  rotated_from: string | null;
  created_at: Date;
}

export class ApiKeyError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'ApiKeyError';
  }
}

function deriveStatus(row: { revoked_at: Date | null; expires_at: Date | null }, now = new Date()): ApiKeyStatus {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

function toSummary(row: any): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    key_type: row.key_type,
    scopes: row.scopes ?? [],
    status: deriveStatus(row),
    last_used_at: row.last_used_at ?? null,
    expires_at: row.expires_at ?? null,
    revoked_at: row.revoked_at ?? null,
    rotated_from: row.rotated_from ?? null,
    created_at: row.created_at,
  };
}

const KEY_META_COLS = [
  'id', 'name', 'key_prefix', 'key_type', 'scopes',
  'last_used_at', 'expires_at', 'revoked_at', 'rotated_from', 'created_at',
] as const;

/** List an org's API keys, newest first. Never returns the hash or plaintext. */
export async function listCustomerApiKeys(customerId: string): Promise<ApiKeySummary[]> {
  const rows = await db
    .selectFrom('api_keys')
    .select([...KEY_META_COLS])
    .where('customer_id', '=', customerId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(toSummary);
}

/** Validate a requested scope set against the enforced scopes and key type. */
export function validateScopes(scopes: string[], keyType: KeyType): void {
  if (scopes.length === 0) throw new ApiKeyError('no_scopes', 'At least one scope is required.');
  const allowed = new Set<string>(API_KEY_SCOPES);
  const bad = scopes.filter((s) => !allowed.has(s));
  if (bad.length > 0) throw new ApiKeyError('invalid_scope', `Unknown scope(s): ${bad.join(', ')}`);
  // Publishable keys are meant to be embeddable client-side, so they must not
  // carry the ability to send mail.
  if (keyType === 'publishable' && scopes.includes('send')) {
    throw new ApiKeyError('publishable_cannot_send', 'Publishable keys cannot hold the "send" scope.');
  }
}

export interface CreateApiKeyInput {
  customerId: string;
  name: string;
  keyType?: KeyType;
  scopes?: string[];
  expiresInDays?: number | null;
}

export interface CreatedApiKey extends ApiKeySummary {
  /** Shown exactly once. */
  api_key: string;
}

/** Create a new API key in an org. Returns metadata plus the one-time plaintext. */
export async function createCustomerApiKey(input: CreateApiKeyInput): Promise<CreatedApiKey> {
  const name = input.name.trim();
  if (!name) throw new ApiKeyError('invalid_name', 'A key name is required.');
  const keyType: KeyType = input.keyType ?? 'secret';
  if (!API_KEY_TYPES.includes(keyType)) throw new ApiKeyError('invalid_key_type', `Unknown key type: ${keyType}`);
  const scopes = input.scopes ?? ['send'];
  validateScopes(scopes, keyType);

  let expires_at: Date | null = null;
  if (input.expiresInDays != null) {
    const days = Math.floor(input.expiresInDays);
    if (days < 1 || days > 3650) throw new ApiKeyError('invalid_expiry', 'expires_in_days must be between 1 and 3650.');
    expires_at = new Date(Date.now() + days * 86_400_000);
  }

  const key = generateApiKeyV2(keyType);
  const row = await db
    .insertInto('api_keys')
    .values({
      customer_id: input.customerId,
      name,
      key_prefix: key.prefix,
      key_hash: key.hash,
      key_type: key.key_type,
      scopes,
      expires_at,
    })
    .returning([...KEY_META_COLS])
    .executeTakeFirstOrThrow();

  return { ...toSummary(row), api_key: key.plaintext };
}

/** Revoke a key (org-scoped). Idempotent. Returns false if no such key in the org. */
export async function revokeCustomerApiKey(customerId: string, keyId: string): Promise<boolean> {
  const existing = await db
    .selectFrom('api_keys')
    .select(['id', 'revoked_at'])
    .where('id', '=', keyId)
    .where('customer_id', '=', customerId)
    .executeTakeFirst();
  if (!existing) return false;
  if (existing.revoked_at) return true; // already revoked — idempotent
  await db
    .updateTable('api_keys')
    .set({ revoked_at: new Date() })
    .where('id', '=', keyId)
    .where('customer_id', '=', customerId)
    .execute();
  return true;
}

export interface RotatedApiKey extends CreatedApiKey {
  rotated_from_id: string;
  old_key_expires_in_hours: number;
}

/**
 * Rotate a key: mint a replacement with the same name/scopes/type, link it via
 * rotated_from, and set the old key to expire after an overlap window so clients
 * can cut over without downtime. Mirrors the admin rotation behavior.
 */
export async function rotateCustomerApiKey(
  customerId: string,
  keyId: string,
  overlapHours = Number(process.env.KEY_ROTATION_OVERLAP_HOURS ?? 48)
): Promise<RotatedApiKey | null> {
  const old = await db
    .selectFrom('api_keys')
    .selectAll()
    .where('id', '=', keyId)
    .where('customer_id', '=', customerId)
    .executeTakeFirst();
  if (!old) return null;
  if (old.revoked_at) throw new ApiKeyError('already_revoked', 'Cannot rotate a revoked key.');

  const hours = Math.max(0, overlapHours);
  return await db.transaction().execute(async (trx) => {
    const next = generateApiKeyV2(old.key_type as KeyType);
    const row = await trx
      .insertInto('api_keys')
      .values({
        customer_id: customerId,
        name: old.name,
        key_prefix: next.prefix,
        key_hash: next.hash,
        key_type: next.key_type,
        scopes: old.scopes,
        rotated_from: old.id,
      })
      .returning([...KEY_META_COLS])
      .executeTakeFirstOrThrow();

    await trx
      .updateTable('api_keys')
      .set({ expires_at: new Date(Date.now() + hours * 3_600_000) })
      .where('id', '=', old.id)
      .where('customer_id', '=', customerId)
      .execute();

    return { ...toSummary(row), api_key: next.plaintext, rotated_from_id: old.id, old_key_expires_in_hours: hours };
  });
}
