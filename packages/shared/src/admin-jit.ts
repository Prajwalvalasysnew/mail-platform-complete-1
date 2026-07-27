// Just-in-time admin elevation + break-glass (enterprise least-privilege).
//
// Admins keep a low STANDING role. Elevated privileges are granted just-in-time
// for a bounded window, with a reason, and audited. The effective role of an
// admin session is max(standing, active elevation) — computed in
// resolveAdminSession, so every existing route guard honours it automatically.

import { sql } from 'kysely';
import { db } from './db.js';
import { recordAudit } from './audit.js';
import type { AdminRole } from './admin.js';

const ROLE_RANK: Record<AdminRole, number> = { support: 1, operator: 2, admin: 3, superadmin: 4 };
const ROLES: AdminRole[] = ['support', 'operator', 'admin', 'superadmin'];

/** Hard cap on how long any elevation can last (minutes). */
export const MAX_ELEVATION_MINUTES = Number(process.env.ADMIN_ELEVATION_MAX_MINUTES ?? 240);
/** Break-glass is the emergency valve — kept short by default. */
export const MAX_BREAK_GLASS_MINUTES = Number(process.env.ADMIN_BREAK_GLASS_MAX_MINUTES ?? 60);
/** Minimum standing role permitted to break the glass. */
const BREAK_GLASS_MIN_STANDING: AdminRole = 'operator';

export interface GrantElevationInput {
  adminUserId: string;   // who is being elevated
  role: AdminRole;       // the elevated role
  reason: string;
  ttlMinutes: number;
  grantedBy: string;     // the acting admin (== adminUserId for break-glass)
  breakGlass?: boolean;
}

export interface Elevation {
  id: string;
  admin_user_id: string;
  role: AdminRole;
  reason: string;
  granted_by: string | null;
  break_glass: boolean;
  status: 'active' | 'expired' | 'revoked';
  expires_at: Date;
}

export type GrantResult = { ok: true; elevation: Elevation } | { ok: false; error: string; status: 400 | 403 };

async function standingRole(adminUserId: string): Promise<AdminRole | null> {
  const row = await db.selectFrom('admin_users').select('role').where('id', '=', adminUserId).executeTakeFirst();
  return (row?.role as AdminRole) ?? null;
}

/**
 * Grant a time-boxed elevation. Enforces:
 *   - a non-empty reason and a TTL within the cap;
 *   - break-glass: self-grant only, standing role >= operator, short-TTL cap,
 *     may exceed the actor's own role (the emergency);
 *   - normal JIT: four-eyes (grantor != grantee) and the grantor's STANDING
 *     role must be >= the requested role (no privilege laundering via an
 *     already-elevated session).
 * Every grant is audited.
 */
export async function grantElevation(input: GrantElevationInput): Promise<GrantResult> {
  const { adminUserId, role, grantedBy, breakGlass = false } = input;
  const reason = (input.reason ?? '').trim();
  if (!ROLES.includes(role)) return { ok: false, error: 'invalid_role', status: 400 };
  if (reason.length < 3) return { ok: false, error: 'reason_required', status: 400 };

  const cap = breakGlass ? MAX_BREAK_GLASS_MINUTES : MAX_ELEVATION_MINUTES;
  if (!Number.isFinite(input.ttlMinutes) || input.ttlMinutes < 1 || input.ttlMinutes > cap) {
    return { ok: false, error: 'ttl_out_of_range', status: 400 };
  }

  if (breakGlass) {
    if (grantedBy !== adminUserId) return { ok: false, error: 'break_glass_is_self_service', status: 400 };
    const standing = await standingRole(adminUserId);
    if (!standing || ROLE_RANK[standing] < ROLE_RANK[BREAK_GLASS_MIN_STANDING]) {
      return { ok: false, error: 'break_glass_standing_too_low', status: 403 };
    }
  } else {
    if (grantedBy === adminUserId) return { ok: false, error: 'self_grant_forbidden', status: 403 };
    const grantorStanding = await standingRole(grantedBy);
    if (!grantorStanding || ROLE_RANK[grantorStanding] < ROLE_RANK[role]) {
      return { ok: false, error: 'exceeds_grantor_role', status: 403 };
    }
    if (!(await standingRole(adminUserId))) return { ok: false, error: 'unknown_grantee', status: 400 };
  }

  const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
  const row = await db.insertInto('admin_elevations').values({
    admin_user_id: adminUserId, role, reason, granted_by: grantedBy, break_glass: breakGlass, expires_at: expiresAt as any,
  }).returning(['id', 'admin_user_id', 'role', 'reason', 'granted_by', 'break_glass', 'status', 'expires_at']).executeTakeFirstOrThrow();

  await recordAudit({
    actorType: 'admin', actorId: grantedBy,
    action: breakGlass ? 'admin.break_glass_elevation' : 'admin.elevation_granted',
    resource: adminUserId,
    metadata: { elevation_id: row.id, role, reason, break_glass: breakGlass, expires_at: expiresAt.toISOString() },
  });

  return { ok: true, elevation: { ...row, role: row.role as AdminRole, status: row.status as any, expires_at: new Date(row.expires_at as any) } };
}

/**
 * The highest currently-active elevation for an admin, or null.
 *
 * Returns the break-glass flag alongside the role because the two carry very
 * different weight after the fact: a granted elevation was approved by someone
 * else, while break-glass is a self-grant. HIPAA-07 review looks specifically
 * for the latter, so the access record has to be able to distinguish them.
 */
export async function activeElevation(
  adminUserId: string,
  now = new Date(),
): Promise<{ role: AdminRole; break_glass: boolean } | null> {
  const rows = await db.selectFrom('admin_elevations').select(['role', 'break_glass'])
    .where('admin_user_id', '=', adminUserId).where('status', '=', 'active').where('expires_at', '>', now as any).execute();
  let best: { role: AdminRole; break_glass: boolean } | null = null;
  for (const r of rows) {
    const role = r.role as AdminRole;
    if (!best || ROLE_RANK[role] > ROLE_RANK[best.role]) best = { role, break_glass: Boolean(r.break_glass) };
  }
  return best;
}

/** The highest currently-active elevated role for an admin, or null. */
export async function activeElevatedRole(adminUserId: string, now = new Date()): Promise<AdminRole | null> {
  return (await activeElevation(adminUserId, now))?.role ?? null;
}

/** Revoke an active elevation early. Returns false if it was not active. */
export async function revokeElevation(id: string, revokedBy: string): Promise<boolean> {
  const row = await db.updateTable('admin_elevations')
    .set({ status: 'revoked', revoked_at: new Date() as any, revoked_by: revokedBy })
    .where('id', '=', id).where('status', '=', 'active').returning(['id', 'admin_user_id', 'role']).executeTakeFirst();
  if (!row) return false;
  await recordAudit({ actorType: 'admin', actorId: revokedBy, action: 'admin.elevation_revoked', resource: row.admin_user_id, metadata: { elevation_id: id, role: row.role } });
  return true;
}

/** Mark elapsed elevations expired (scheduler sweep). Returns the count. */
export async function expireElevations(now = new Date()): Promise<number> {
  const res = await db.updateTable('admin_elevations').set({ status: 'expired' })
    .where('status', '=', 'active').where('expires_at', '<=', now as any).executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}

/** List currently-active elevations (for the admin console). */
export async function listActiveElevations(now = new Date()) {
  return db.selectFrom('admin_elevations')
    .innerJoin('admin_users', 'admin_users.id', 'admin_elevations.admin_user_id')
    .select(['admin_elevations.id as id', 'admin_elevations.admin_user_id as admin_user_id', 'admin_users.email as email',
      'admin_elevations.role as role', 'admin_elevations.reason as reason', 'admin_elevations.granted_by as granted_by',
      'admin_elevations.break_glass as break_glass', 'admin_elevations.expires_at as expires_at', 'admin_elevations.created_at as created_at'])
    .where('admin_elevations.status', '=', 'active').where('admin_elevations.expires_at', '>', now as any)
    .orderBy('admin_elevations.created_at', 'desc').execute();
}
