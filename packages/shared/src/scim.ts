// SCIM 2.0 (RFC 7644) user provisioning for enterprise customer tenants.
// Gap analysis Top-20 #9. An IdP (Okta / Entra ID / OneLogin) authenticates
// with a per-tenant bearer token and creates/updates/deactivates users; those
// map onto the existing users + memberships model. Deprovisioning is a soft
// deactivate (SCIM `active=false`) rather than a hard delete, so audit history
// and org membership records survive.

import crypto from 'node:crypto';
import { db } from './db.js';
import { createUser } from './users.js';
import type { MembershipRole } from './schema.js';

// ─── Token management ────────────────────────────────────────────────────────

function pepper(): string {
  // Reuse the user-session pepper family; SCIM tokens are long-lived bearer
  // credentials so they get the same HMAC-at-rest treatment as sessions/keys.
  const p = process.env.USER_SESSION_PEPPER ?? process.env.API_KEY_PEPPER;
  if (!p) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('USER_SESSION_PEPPER (or API_KEY_PEPPER) is required in production for SCIM tokens');
    }
    return 'dev-insecure-scim-pepper';
  }
  return p;
}

function hashToken(plaintext: string): string {
  return `hmac:${crypto.createHmac('sha256', pepper()).update(plaintext).digest('base64url')}`;
}

export interface GeneratedScimToken {
  id: string;
  token: string; // plaintext — shown ONCE to the operator
  token_prefix: string;
}

/** Mint a new SCIM bearer token for a tenant. Plaintext is returned once. */
export async function createScimToken(customerId: string, label?: string): Promise<GeneratedScimToken> {
  const raw = `scim_${crypto.randomBytes(32).toString('base64url')}`;
  const token_prefix = raw.slice(0, 12);
  const row = await db
    .insertInto('scim_tokens')
    .values({ customer_id: customerId, token_hash: hashToken(raw), token_prefix, label: label ?? null })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return { id: row.id, token: raw, token_prefix };
}

/** Resolve a bearer token to its tenant, or null if invalid/revoked. */
export async function resolveScimToken(token: string | undefined): Promise<{ customerId: string } | null> {
  if (!token) return null;
  const row = await db
    .selectFrom('scim_tokens')
    .select(['id', 'customer_id', 'revoked_at'])
    .where('token_hash', '=', hashToken(token))
    .executeTakeFirst();
  if (!row || row.revoked_at) return null;
  // Best-effort last-used bookkeeping (don't block the request on it).
  await db.updateTable('scim_tokens').set({ last_used_at: new Date() }).where('id', '=', row.id).execute().catch(() => {});
  return { customerId: row.customer_id };
}

export async function listScimTokens(customerId: string) {
  return db
    .selectFrom('scim_tokens')
    .select(['id', 'token_prefix', 'label', 'created_at', 'last_used_at', 'revoked_at'])
    .where('customer_id', '=', customerId)
    .orderBy('created_at', 'desc')
    .execute();
}

export async function revokeScimToken(customerId: string, id: string): Promise<boolean> {
  const res = await db
    .updateTable('scim_tokens')
    .set({ revoked_at: new Date() })
    .where('id', '=', id)
    .where('customer_id', '=', customerId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0) > 0;
}

// ─── SCIM User representation ────────────────────────────────────────────────

export interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name?: { formatted?: string; givenName?: string; familyName?: string };
  displayName?: string;
  active: boolean;
  emails: Array<{ value: string; primary?: boolean }>;
  meta: { resourceType: 'User'; created?: string; lastModified?: string; location?: string };
}

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

// Default role for SCIM-provisioned users. Enterprise IdPs push identity, not
// authorization; role management stays in-app. New SCIM users get the lowest
// privilege and an admin can elevate.
const DEFAULT_SCIM_ROLE: MembershipRole = 'analyst';

function toScimUser(
  u: { id: string; email: string; user_name: string | null; scim_display_name: string | null; scim_external_id: string | null; scim_active: boolean; created_at: unknown; updated_at: unknown },
  baseUrl: string
): ScimUser {
  const name = u.scim_display_name ?? u.user_name;
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    externalId: u.scim_external_id ?? undefined,
    userName: u.email,
    name: name ? { formatted: name } : undefined,
    displayName: name ?? undefined,
    active: u.scim_active,
    emails: [{ value: u.email, primary: true }],
    meta: {
      resourceType: 'User',
      created: u.created_at ? new Date(u.created_at as string).toISOString() : undefined,
      lastModified: u.updated_at ? new Date(u.updated_at as string).toISOString() : undefined,
      location: `${baseUrl}/scim/v2/Users/${u.id}`,
    },
  };
}

export class ScimError extends Error {
  constructor(public status: number, public scimType: string | undefined, message: string) {
    super(message);
    this.name = 'ScimError';
  }
}

async function loadScimUserRow(customerId: string, userId: string) {
  // The user must be a member of the SCIM tenant — otherwise a token for one
  // tenant could read/modify users in another. The join enforces that.
  return db
    .selectFrom('users')
    .innerJoin('memberships', 'memberships.user_id', 'users.id')
    .select([
      'users.id as id', 'users.email as email', 'users.name as user_name',
      'memberships.scim_display_name as scim_display_name',
      'memberships.scim_external_id as scim_external_id',
      'memberships.scim_active as scim_active',
      'memberships.created_at as created_at', 'memberships.scim_updated_at as updated_at',
    ])
    .where('users.id', '=', userId)
    .where('memberships.customer_id', '=', customerId)
    .where('memberships.scim_managed', '=', true)
    .executeTakeFirst();
}

/** SCIM create: provision a user into the tenant (idempotent on email). */
export async function scimCreateUser(
  customerId: string,
  body: { userName?: string; externalId?: string; active?: boolean; name?: { formatted?: string; givenName?: string; familyName?: string }; displayName?: string; emails?: Array<{ value: string; primary?: boolean }> },
  baseUrl: string
): Promise<ScimUser> {
  const email = (body.userName ?? body.emails?.find((e) => e.primary)?.value ?? body.emails?.[0]?.value)?.toLowerCase().trim();
  if (!email) throw new ScimError(400, 'invalidValue', 'userName or emails is required');
  const displayName = body.displayName ?? body.name?.formatted
    ?? ([body.name?.givenName, body.name?.familyName].filter(Boolean).join(' ') || null);

  return db.transaction().execute(async (trx) => {
    // Idempotency: if a user with this email already exists, link + ensure
    // membership rather than erroring (IdPs retry provisioning).
    let user = await trx
      .selectFrom('users')
      .select(['id', 'email', 'name', 'status', 'email_verified_at', 'mfa_enabled'])
      .where('email', '=', email)
      .executeTakeFirst();
    if (!user) {
      user = await createUser({ email, name: displayName }, trx);
    }

    // Create only when absent. addMembership() intentionally updates role on
    // conflict, which would downgrade an existing owner/admin to analyst when
    // their IdP retries provisioning.
    await trx.insertInto('memberships')
      .values({
        user_id: user.id,
        customer_id: customerId,
        role: DEFAULT_SCIM_ROLE,
        scim_managed: true,
        scim_external_id: body.externalId ?? null,
        scim_display_name: displayName,
        scim_active: body.active !== false,
        scim_updated_at: new Date(),
      })
      .onConflict((oc) => oc.columns(['user_id', 'customer_id']).doNothing())
      .execute();

    // SCIM lifecycle state is scoped to this tenant membership. Never change
    // global users.status here: the person may belong to other tenants.
    await trx.updateTable('memberships')
      .set({
        scim_managed: true,
        scim_external_id: body.externalId ?? null,
        scim_display_name: displayName,
        scim_active: body.active !== false,
        scim_updated_at: new Date(),
      })
      .where('user_id', '=', user.id)
      .where('customer_id', '=', customerId)
      .execute();

    if (body.active === false) {
      await trx.updateTable('user_sessions')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', user.id)
        .where('current_customer_id', '=', customerId)
        .where('revoked_at', 'is', null)
        .execute();
    }

    const row = await trx
      .selectFrom('users')
      .innerJoin('memberships', 'memberships.user_id', 'users.id')
      .select([
        'users.id as id', 'users.email as email', 'users.name as user_name',
        'memberships.scim_display_name as scim_display_name',
        'memberships.scim_external_id as scim_external_id',
        'memberships.scim_active as scim_active',
        'memberships.created_at as created_at', 'memberships.scim_updated_at as updated_at',
      ])
      .where('users.id', '=', user.id)
      .where('memberships.customer_id', '=', customerId)
      .executeTakeFirstOrThrow();
    return toScimUser(row, baseUrl);
  });
}

export async function scimGetUser(customerId: string, userId: string, baseUrl: string): Promise<ScimUser> {
  const row = await loadScimUserRow(customerId, userId);
  if (!row) throw new ScimError(404, undefined, `User ${userId} not found`);
  return toScimUser(row, baseUrl);
}

/** SCIM list, with optional `userName eq "..."` filter (the common IdP query). */
export async function scimListUsers(
  customerId: string,
  opts: { filter?: string; startIndex?: number; count?: number },
  baseUrl: string
): Promise<{ schemas: string[]; totalResults: number; startIndex: number; itemsPerPage: number; Resources: ScimUser[] }> {
  const startIndex = Math.max(1, opts.startIndex ?? 1);
  const count = Math.min(Math.max(0, opts.count ?? 100), 200);

  let q = db
    .selectFrom('users')
    .innerJoin('memberships', 'memberships.user_id', 'users.id')
    .where('memberships.customer_id', '=', customerId)
    .where('memberships.scim_managed', '=', true);

  // Minimal SCIM filter support: `userName eq "x"` / `externalId eq "x"`.
  const filter = opts.filter?.trim();
  if (filter) {
    const m = /^(userName|externalId)\s+eq\s+"([^"]+)"$/i.exec(filter);
    if (!m || !m[1] || !m[2]) throw new ScimError(400, 'invalidFilter', 'Only `userName eq` / `externalId eq` filters are supported');
    const attr = m[1].toLowerCase();
    const rawValue = m[2];
    const value = rawValue.toLowerCase();
    q = attr === 'username'
      ? q.where('users.email', '=', value)
      : q.where('memberships.scim_external_id', '=', rawValue);
  }

  const total = await q.select(({ fn }) => fn.countAll<number>().as('c')).executeTakeFirst();
  const rows = await q
    .select([
      'users.id as id', 'users.email as email', 'users.name as user_name',
      'memberships.scim_display_name as scim_display_name',
      'memberships.scim_external_id as scim_external_id',
      'memberships.scim_active as scim_active',
      'memberships.created_at as created_at', 'memberships.scim_updated_at as updated_at',
    ])
    .orderBy('memberships.created_at', 'asc')
    .limit(count)
    .offset(startIndex - 1)
    .execute();

  return {
    schemas: [LIST_SCHEMA],
    totalResults: Number(total?.c ?? 0),
    startIndex,
    itemsPerPage: rows.length,
    Resources: rows.map((r) => toScimUser(r, baseUrl)),
  };
}

/**
 * SCIM PATCH — the operation IdPs use to DEPROVISION (set active=false). We
 * support the common `replace` of `active` and of name/displayName. Setting
 * active=false disables only this tenant's SCIM membership and preserves the
 * global user plus memberships in every other tenant.
 */
export async function scimPatchUser(
  customerId: string,
  userId: string,
  body: { Operations?: Array<{ op: string; path?: string; value?: unknown }> },
  baseUrl: string
): Promise<ScimUser> {
  const row = await loadScimUserRow(customerId, userId);
  if (!row) throw new ScimError(404, undefined, `User ${userId} not found`);

  const ops = body.Operations ?? [];
  for (const op of ops) {
    const opName = op.op?.toLowerCase();
    if (opName !== 'replace' && opName !== 'add') continue;

    // Two shapes: { path:'active', value:false } OR { value:{ active:false } }.
    const applyKV = async (path: string | undefined, value: unknown) => {
      const p = path?.toLowerCase();
      if (p === 'active') {
        await setActive(customerId, userId, coerceBool(value));
      } else if (p === 'displayname' || p === 'name.formatted') {
        await db.updateTable('memberships')
          .set({ scim_display_name: String(value), scim_updated_at: new Date() })
          .where('customer_id', '=', customerId)
          .where('user_id', '=', userId)
          .execute();
      }
    };

    if (op.path) {
      await applyKV(op.path, op.value);
    } else if (op.value && typeof op.value === 'object') {
      for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) {
        await applyKV(k, v);
      }
    }
  }

  const updated = await loadScimUserRow(customerId, userId);
  if (!updated) throw new ScimError(404, undefined, `User ${userId} not found`);
  return toScimUser(updated, baseUrl);
}

/** SCIM PUT — full replace. Mainly used to update active + name. */
export async function scimReplaceUser(
  customerId: string,
  userId: string,
  body: { active?: boolean; displayName?: string; name?: { formatted?: string } },
  baseUrl: string
): Promise<ScimUser> {
  const row = await loadScimUserRow(customerId, userId);
  if (!row) throw new ScimError(404, undefined, `User ${userId} not found`);
  if (typeof body.active === 'boolean') await setActive(customerId, userId, body.active);
  const name = body.displayName ?? body.name?.formatted;
  if (name !== undefined) {
    await db.updateTable('memberships')
      .set({ scim_display_name: name, scim_updated_at: new Date() })
      .where('customer_id', '=', customerId)
      .where('user_id', '=', userId)
      .execute();
  }
  const updated = await loadScimUserRow(customerId, userId);
  if (!updated) throw new ScimError(404, undefined, `User ${userId} not found`);
  return toScimUser(updated, baseUrl);
}

/**
 * SCIM DELETE softly deprovisions from THIS tenant. The membership remains
 * addressable as active:false, while the global user and memberships in other
 * tenants remain active.
 */
export async function scimDeleteUser(customerId: string, userId: string): Promise<void> {
  const row = await loadScimUserRow(customerId, userId);
  if (!row) throw new ScimError(404, undefined, `User ${userId} not found`);
  await setActive(customerId, userId, false);
}

async function setActive(customerId: string, userId: string, active: boolean): Promise<void> {
  if (active) {
    const updated = await db.updateTable('memberships')
      .set({ scim_managed: true, scim_active: true, scim_updated_at: new Date() })
      .where('customer_id', '=', customerId)
      .where('user_id', '=', userId)
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw new ScimError(404, undefined, `User ${userId} not found`);
    return;
  }
  // Deprovision only this tenant membership and sessions currently using it.
  // The global user remains active for every other tenant membership.
  await db.transaction().execute(async (trx) => {
    const updated = await trx.updateTable('memberships')
      .set({ scim_managed: true, scim_active: false, scim_updated_at: new Date() })
      .where('customer_id', '=', customerId)
      .where('user_id', '=', userId)
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw new ScimError(404, undefined, `User ${userId} not found`);
    await trx.updateTable('user_sessions')
      .set({ revoked_at: new Date() })
      .where('user_id', '=', userId)
      .where('current_customer_id', '=', customerId)
      .where('revoked_at', 'is', null)
      .execute();
  });
}

function coerceBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return Boolean(v);
}
