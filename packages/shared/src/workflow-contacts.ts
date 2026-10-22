// Contact data for workflow runs: what conditions read (contact.tags,
// contact.attributes.plan, contact.status, ...), what templates personalize
// with ({{first_name}}), and what "Update contact" steps write.
import { sql } from 'kysely';
import type { db } from './db.js';

type DbLike = typeof db;

export interface ContactBag {
  email: string;
  exists: boolean;
  name: string;
  first_name: string;
  last_name: string;
  company: string;
  location: string;
  status: string;
  tags: string[];
  attributes: Record<string, unknown>;
  timezone: string | null;
  created_at: string | null;
}

function nameParts(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return { first_name: parts[0] ?? '', last_name: parts.slice(1).join(' ') };
}

function toBag(email: string, row: any): ContactBag {
  if (!row) return { email, exists: false, name: '', first_name: '', last_name: '', company: '', location: '', status: 'Unknown', tags: [], attributes: {}, timezone: null, created_at: null };
  return {
    email, exists: true, name: row.name ?? '', ...nameParts(row.name ?? ''), company: row.company ?? '', location: row.location ?? '',
    status: row.status, tags: Array.isArray(row.tags) ? row.tags : [], attributes: row.attributes && typeof row.attributes === 'object' ? row.attributes : {},
    timezone: row.timezone ?? null, created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

/** Tenant context for audience_contacts (FORCE RLS) inside the caller's transaction. */
async function scope(exec: DbLike, customerId: string) {
  await sql`select set_config('app.customer_id', ${customerId}, true)`.execute(exec);
}

export async function loadContactBag(exec: DbLike, customerId: string, email: string): Promise<ContactBag> {
  // set_config(..., true) is transaction-local: outside a transaction, open one.
  if (!exec.isTransaction) return exec.transaction().execute((trx) => loadContactBag(trx as unknown as DbLike, customerId, email));
  await scope(exec, customerId);
  const row = await exec
    .selectFrom('audience_contacts')
    .select(['name', 'company', 'location', 'status', 'tags', 'attributes', 'timezone', 'created_at'])
    .where('customer_id', '=', customerId)
    .where('email', '=', email.toLowerCase())
    .executeTakeFirst();
  return toBag(email.toLowerCase(), row);
}

export async function loadContactBags(exec: DbLike, customerId: string, emails: string[]): Promise<Map<string, ContactBag>> {
  const out = new Map<string, ContactBag>();
  if (!emails.length) return out;
  if (!exec.isTransaction) return exec.transaction().execute((trx) => loadContactBags(trx as unknown as DbLike, customerId, emails));
  await scope(exec, customerId);
  const rows = await exec
    .selectFrom('audience_contacts')
    .select(['email', 'name', 'company', 'location', 'status', 'tags', 'attributes', 'timezone', 'created_at'])
    .where('customer_id', '=', customerId)
    .where('email', 'in', emails.map((e) => e.toLowerCase()))
    .execute();
  for (const row of rows) out.set(row.email, toBag(row.email, row));
  for (const email of emails) if (!out.has(email.toLowerCase())) out.set(email.toLowerCase(), toBag(email.toLowerCase(), null));
  return out;
}

export interface ContactUpdate {
  add_tags: string[];
  remove_tags: string[];
  set_attributes: Record<string, unknown>;
  status?: 'Subscribed' | 'Unsubscribed';
}

/** Apply an "Update contact" step; creates the contact when the subject is not in the audience yet. */
export async function applyContactUpdate(exec: DbLike, customerId: string, email: string, update: ContactUpdate): Promise<ContactBag> {
  const subject = email.toLowerCase();
  await scope(exec, customerId);
  const current = await exec
    .selectFrom('audience_contacts')
    .select(['id', 'tags', 'attributes'])
    .where('customer_id', '=', customerId)
    .where('email', '=', subject)
    .forUpdate()
    .executeTakeFirst();
  const remove = new Set(update.remove_tags.map((t) => t.trim().toLowerCase()));
  const tags = [...new Set([...(current?.tags ?? []), ...update.add_tags.map((t) => t.trim().toLowerCase())])].filter((t) => !remove.has(t)).slice(0, 200);
  const attributes: Record<string, unknown> = { ...((current?.attributes as Record<string, unknown>) ?? {}) };
  for (const [key, value] of Object.entries(update.set_attributes)) {
    if (value === null || value === '') delete attributes[key];
    else attributes[key] = value;
  }
  if (current) {
    await exec
      .updateTable('audience_contacts')
      .set({
        tags, attributes: attributes as any, updated_at: new Date(), revision: sql`revision + 1` as any,
        ...(update.status ? { status: update.status } : {}),
      })
      .where('customer_id', '=', customerId)
      .where('id', '=', current.id)
      .execute();
  } else {
    await exec
      .insertInto('audience_contacts')
      .values({ customer_id: customerId, email: subject, name: subject.split('@')[0]!, status: update.status ?? 'Pending', source: 'Workflow', tags, attributes: attributes as any } as any)
      .onConflict((oc) => oc.columns(['customer_id', 'email']).doNothing())
      .execute();
  }
  return loadContactBag(exec, customerId, subject);
}

/**
 * Template variables for a run: contact fields at the top level ({{first_name}},
 * {{company}}), then the API/event context, then step-level variables. The
 * namespaced bags (contact, trigger, context, subject) stay available too.
 */
export function workflowRenderVariables(runContext: Record<string, unknown>, stepVariables: Record<string, unknown> = {}): Record<string, unknown> {
  const contact = (runContext.contact as Partial<ContactBag> | undefined) ?? {};
  const context = (runContext.context as Record<string, unknown> | undefined) ?? {};
  const trigger = (runContext.trigger as Record<string, unknown> | undefined) ?? {};
  const flat: Record<string, unknown> = {
    email: (runContext.subject as any)?.email,
    first_name: contact.first_name || undefined,
    last_name: contact.last_name || undefined,
    name: contact.name || undefined,
    company: contact.company || undefined,
    ...(contact.attributes ?? {}),
  };
  for (const [k, v] of Object.entries(flat)) if (v === undefined) delete flat[k];
  return { ...flat, ...trigger, ...context, ...runContext, ...stepVariables };
}
