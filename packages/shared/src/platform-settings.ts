// Platform-wide operator settings backing the admin console Settings screen
// and the payment-gateway enable toggles.
//
// Settings are grouped documents stored as JSONB rows in `platform_settings`
// (one row per group). Every group has typed defaults, so reads always return
// a complete document even before anything has been saved. Secrets (gateway
// credentials, SMTP passwords, …) are explicitly out of scope — those stay in
// environment configuration and are only *reported* (present / absent) by the
// admin API, never stored or echoed.

import { z } from 'zod';
import { sql } from 'kysely';
import { db } from './db.js';

export const QuotaSettingsSchema = z.object({
  /** Daily cap applied to newly created tenants (existing tenants keep their column value). */
  default_daily_quota: z.number().int().min(0).max(100_000_000),
  default_monthly_quota: z.number().int().min(0).max(1_000_000_000),
});

export const BounceThresholdSettingsSchema = z.object({
  /** Percentages over a rolling 24h window. */
  soft_bounce_hold_pct: z.number().min(0).max(100),
  hard_bounce_suspend_pct: z.number().min(0).max(100),
  complaint_hold_pct: z.number().min(0).max(100),
});

export const WarmupSettingsSchema = z.object({
  initial_daily_volume: z.number().int().min(1).max(1_000_000),
  ramp_days: z.number().int().min(1).max(365),
});

export const SecuritySettingsSchema = z.object({
  /** Advisory flag surfaced at admin login; TOTP enrollment stays per-account. */
  require_admin_mfa: z.boolean(),
  session_lifetime_hours: z.number().int().min(1).max(24),
  lockout_threshold: z.number().int().min(3).max(20),
  lockout_minutes: z.number().int().min(1).max(1440),
});

export const GatewayConfigSchema = z.object({
  enabled: z.boolean(),
  /** Display label for the checkout mode; informational only. */
  mode: z.enum(['live', 'test']).optional(),
});

export const PaymentGatewaySettingsSchema = z.object({
  stripe: GatewayConfigSchema,
  paypal: GatewayConfigSchema,
  cashfree: GatewayConfigSchema,
});

const GROUP_SCHEMAS = {
  quotas: QuotaSettingsSchema,
  bounce_thresholds: BounceThresholdSettingsSchema,
  warmup: WarmupSettingsSchema,
  security: SecuritySettingsSchema,
  payment_gateways: PaymentGatewaySettingsSchema,
} as const;

export type PlatformSettingGroup = keyof typeof GROUP_SCHEMAS;
export type PlatformSettings = { [G in PlatformSettingGroup]: z.infer<(typeof GROUP_SCHEMAS)[G]> };

export const PLATFORM_SETTING_DEFAULTS: PlatformSettings = {
  quotas: { default_daily_quota: 50_000, default_monthly_quota: 1_500_000 },
  bounce_thresholds: { soft_bounce_hold_pct: 5.0, hard_bounce_suspend_pct: 3.0, complaint_hold_pct: 0.1 },
  warmup: { initial_daily_volume: 500, ramp_days: 30 },
  security: { require_admin_mfa: false, session_lifetime_hours: 8, lockout_threshold: 5, lockout_minutes: 15 },
  payment_gateways: {
    stripe: { enabled: true },
    paypal: { enabled: true },
    cashfree: { enabled: true },
  },
};

export const PLATFORM_SETTING_GROUPS = Object.keys(GROUP_SCHEMAS) as PlatformSettingGroup[];

function mergeGroup<G extends PlatformSettingGroup>(group: G, stored: unknown): PlatformSettings[G] {
  // Stored documents are validated on write, but tolerate drift (e.g. a field
  // added after rows were written) by layering stored values over defaults and
  // dropping anything that no longer validates.
  const candidate = { ...(PLATFORM_SETTING_DEFAULTS[group] as object), ...(typeof stored === 'object' && stored !== null ? stored : {}) };
  const parsed = GROUP_SCHEMAS[group].safeParse(candidate);
  return (parsed.success ? parsed.data : PLATFORM_SETTING_DEFAULTS[group]) as PlatformSettings[G];
}

/** Read all setting groups, layered over defaults. Always complete. */
export async function getPlatformSettings(): Promise<PlatformSettings> {
  const rows = await db
    .selectFrom('platform_settings')
    .select(['key', 'value'])
    .where('key', 'in', PLATFORM_SETTING_GROUPS)
    .execute();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as PlatformSettings;
  for (const group of PLATFORM_SETTING_GROUPS) {
    (out as Record<string, unknown>)[group] = mergeGroup(group, byKey.get(group));
  }
  return out;
}

export interface SettingsUpdateResult {
  settings: PlatformSettings;
  updated_groups: PlatformSettingGroup[];
}

/**
 * Partially update settings: any provided group is validated as a FULL group
 * document (the console always submits whole panels) and upserted. Unknown
 * groups are rejected by the caller's zod layer; here we only accept known keys.
 */
export async function updatePlatformSettings(
  patch: Partial<Record<PlatformSettingGroup, unknown>>,
  adminUserId: string | null
): Promise<SettingsUpdateResult | { error: 'validation_failed'; group: string; details: unknown }> {
  const validated: Array<{ group: PlatformSettingGroup; value: unknown }> = [];
  for (const group of PLATFORM_SETTING_GROUPS) {
    if (!(group in patch) || patch[group] === undefined) continue;
    const parsed = GROUP_SCHEMAS[group].safeParse(patch[group]);
    if (!parsed.success) return { error: 'validation_failed', group, details: parsed.error.flatten() };
    validated.push({ group, value: parsed.data });
  }

  for (const { group, value } of validated) {
    await db
      .insertInto('platform_settings')
      .values({ key: group, value, updated_by: adminUserId })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value, updated_by: adminUserId, updated_at: sql`now()` }))
      .execute();
  }

  return { settings: await getPlatformSettings(), updated_groups: validated.map((v) => v.group) };
}
