// Sub-account management (reseller / franchise / BPO tenancy).
//
// A sub-account is a full customers row with parent_customer_id set, so every
// per-tenant feature (domains, suppressions, keys, quotas, workflows, RLS)
// applies to it automatically. This module is the parent-side management
// surface: create children, cap their spend via quotas, mint their
// credentials, roll up their usage, and push shared templates down.
//
// Billing: children have no billing identity — evaluateBillingAccess defers
// to the parent. Metering/invoicing roll-up to the parent is intentionally
// out of scope here (billing-provider work); parents govern child spend with
// the per-child daily/monthly quotas.

import { sql } from 'kysely';
import crypto from 'node:crypto';
import { db } from './db.js';
import { withTenant } from './tenant-context.js';

const MAX_SUBACCOUNTS = Number(process.env.MAX_SUBACCOUNTS_PER_CUSTOMER ?? 100);

export class SubaccountError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = 'SubaccountError';
  }
}

const CHILD_COLS = [
  'id', 'email', 'name', 'status', 'tier', 'daily_quota', 'monthly_quota', 'created_at',
] as const;

export interface SubaccountSummary {
  id: string;
  email: string;
  name: string | null;
  status: string;
  tier: string;
  daily_quota: number;
  monthly_quota: number;
  created_at: Date;
}

async function loadParent(parentId: string) {
  const parent = await db
    .selectFrom('customers')
    .select(['id', 'email', 'tier', 'kyc_level', 'status', 'parent_customer_id', 'email_verified_at', 'daily_quota', 'monthly_quota'])
    .where('id', '=', parentId)
    .executeTakeFirstOrThrow();
  if (parent.parent_customer_id) {
    throw new SubaccountError('subaccounts_cannot_nest', 'Sub-accounts cannot create their own sub-accounts.');
  }
  return parent;
}

/** Assert `childId` is a live child of `parentId`; returns the child row. */
export async function assertChildOf(parentId: string, childId: string): Promise<SubaccountSummary> {
  const child = await db
    .selectFrom('customers')
    .select([...CHILD_COLS, 'parent_customer_id'])
    .where('id', '=', childId)
    .executeTakeFirst();
  if (!child || child.parent_customer_id !== parentId) {
    throw new SubaccountError('not_a_subaccount', 'No such sub-account on this org.');
  }
  return child as unknown as SubaccountSummary;
}

export async function createSubaccount(input: {
  parentId: string;
  name: string;
  email?: string;
  dailyQuota?: number;
  monthlyQuota?: number;
}): Promise<SubaccountSummary> {
  const parent = await loadParent(input.parentId);
  if (parent.status !== 'active') throw new SubaccountError('parent_not_active', 'Parent account is not active.');

  const count = await db
    .selectFrom('customers')
    .select(sql<number>`count(*)`.as('c'))
    .where('parent_customer_id', '=', input.parentId)
    .executeTakeFirst();
  if (Number(count?.c ?? 0) >= MAX_SUBACCOUNTS) {
    throw new SubaccountError('subaccount_limit_reached', `Maximum ${MAX_SUBACCOUNTS} sub-accounts per org.`);
  }

  // Children need a unique email (schema constraint) but have no login of
  // their own; synthesize a plus-addressed variant of the parent's mailbox
  // unless an explicit one is supplied.
  const [parentLocal, parentDomain] = parent.email.split('@');
  const email = (input.email ?? `${parentLocal}+sub-${crypto.randomBytes(4).toString('hex')}@${parentDomain}`).toLowerCase();

  // Spend caps: default to the parent's own quotas, never above them at
  // creation (the parent can raise later if their plan grows).
  const dailyQuota = Math.max(1, Math.min(input.dailyQuota ?? parent.daily_quota, parent.daily_quota));
  const monthlyQuota = Math.max(1, Math.min(input.monthlyQuota ?? parent.monthly_quota, parent.monthly_quota));

  try {
    const row = await db
      .insertInto('customers')
      .values({
        email,
        name: input.name,
        tier: parent.tier,
        daily_quota: dailyQuota,
        monthly_quota: monthlyQuota,
        billing_provider: 'mock', // children never bill directly
        billing_status: 'active',
        status: 'active',
        kyc_level: parent.kyc_level,
        // The parent's verification stands for the family — children are
        // API-created workload identities, not signups.
        email_verified_at: parent.email_verified_at ?? new Date(),
        parent_customer_id: input.parentId,
      } as any)
      .returning([...CHILD_COLS])
      .executeTakeFirstOrThrow();
    return row as unknown as SubaccountSummary;
  } catch (err: any) {
    if (err?.code === '23505') throw new SubaccountError('email_exists', 'A customer with this email already exists.');
    throw err;
  }
}

export async function listSubaccounts(parentId: string): Promise<SubaccountSummary[]> {
  const rows = await db
    .selectFrom('customers')
    .select([...CHILD_COLS])
    .where('parent_customer_id', '=', parentId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows as unknown as SubaccountSummary[];
}

export async function updateSubaccount(
  parentId: string,
  childId: string,
  patch: { name?: string; status?: 'active' | 'suspended'; dailyQuota?: number; monthlyQuota?: number }
): Promise<SubaccountSummary> {
  await assertChildOf(parentId, childId);
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.dailyQuota !== undefined) set.daily_quota = Math.max(1, Math.floor(patch.dailyQuota));
  if (patch.monthlyQuota !== undefined) set.monthly_quota = Math.max(1, Math.floor(patch.monthlyQuota));
  if (Object.keys(set).length === 0) throw new SubaccountError('no_fields', 'No updatable fields supplied.');
  const row = await db
    .updateTable('customers')
    .set(set as any)
    .where('id', '=', childId)
    .where('parent_customer_id', '=', parentId)
    .returning([...CHILD_COLS])
    .executeTakeFirstOrThrow();
  return row as unknown as SubaccountSummary;
}

/** Per-child usage roll-up over the last N days (+ family totals). */
export async function subaccountUsageRollup(
  parentId: string,
  days = 30
): Promise<{
  children: Array<{ id: string; name: string | null; sent: number; delivered: number; bounced: number; complained: number }>;
  totals: { sent: number; delivered: number; bounced: number; complained: number };
}> {
  const window = Math.max(1, Math.min(days, 90));
  // The usage_daily_parent_select policy grants this parent-scoped
  // transaction SELECT access to direct children only. This turns the former
  // one-transaction-per-child loop into a single grouped query without using
  // the service BYPASSRLS role or weakening unrelated-tenant isolation.
  const rows = await withTenant(parentId, (trx) =>
    trx
      .selectFrom('customers as child')
      .leftJoin('usage_daily as usage', (join) => join
        .onRef('usage.customer_id', '=', 'child.id')
        .on(sql<boolean>`usage.usage_date >= CURRENT_DATE - (${window} * INTERVAL '1 day')`))
      .select([
        'child.id as id',
        'child.name as name',
        sql<number>`COALESCE(SUM(usage.sent), 0)`.as('sent'),
        sql<number>`COALESCE(SUM(usage.delivered), 0)`.as('delivered'),
        sql<number>`COALESCE(SUM(usage.bounced), 0)`.as('bounced'),
        sql<number>`COALESCE(SUM(usage.complained), 0)`.as('complained'),
      ])
      .where('child.parent_customer_id', '=', parentId)
      .groupBy(['child.id', 'child.name'])
      .orderBy('child.created_at', 'desc')
      .execute()
  );
  const out = rows.map((row) => ({
    id: row.id,
    name: row.name,
    sent: Number(row.sent),
    delivered: Number(row.delivered),
    bounced: Number(row.bounced),
    complained: Number(row.complained),
  }));
  const totals = { sent: 0, delivered: 0, bounced: 0, complained: 0 };
  for (const entry of out) {
    totals.sent += entry.sent;
    totals.delivered += entry.delivered;
    totals.bounced += entry.bounced;
    totals.complained += entry.complained;
  }
  return { children: out, totals };
}

/**
 * Copy a parent template to children (franchise model: corporate builds the
 * template, franchisees send it under their own account). Same-name templates
 * on the child are overwritten — push is the source of truth.
 */
export async function pushTemplateToSubaccounts(
  parentId: string,
  templateId: string,
  childIds: string[] | 'all'
): Promise<{ pushed: string[] }> {
  return withTenant(parentId, async (trx) => {
    const template = await trx
      .selectFrom('templates')
      .select(['name', 'subject', 'html_body', 'text_body'])
      .where('id', '=', templateId)
      .where('customer_id', '=', parentId)
      .executeTakeFirst();
    if (!template) throw new SubaccountError('template_not_found', 'Template not found on the parent account.');

    const children = await trx
      .selectFrom('customers')
      .select('id')
      .where('parent_customer_id', '=', parentId)
      .$if(childIds !== 'all', (q) => q.where('id', 'in', childIds as string[]))
      .execute();
    if (childIds !== 'all' && children.length !== childIds.length) {
      throw new SubaccountError('not_a_subaccount', 'One or more target ids are not sub-accounts of this org.');
    }

    const pushed = children.map((child) => child.id);
    if (pushed.length > 0) {
      await trx
        .insertInto('templates')
        .values(pushed.map((customerId) => ({
            customer_id: customerId,
            name: template.name,
            subject: template.subject,
            html_body: template.html_body,
            text_body: template.text_body,
          })))
        .onConflict((oc) => oc.columns(['customer_id', 'name']).doUpdateSet((eb) => ({
          subject: eb.ref('excluded.subject'),
          html_body: eb.ref('excluded.html_body'),
          text_body: eb.ref('excluded.text_body'),
        })))
        .execute();
    }
    return { pushed };
  });
}
