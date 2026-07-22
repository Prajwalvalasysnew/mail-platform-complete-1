// Proves Row-Level Security actually isolates tenants when app.customer_id is
// set (via withTenant / set_config). RLS is bypassed by superuser/BYPASSRLS
// roles, and the test DB connects as superuser, so we create a dedicated
// non-privileged role and exercise the policies through a raw pg connection as
// that role — mirroring how the API should run in production.
//
// This is the regression guard for the "RLS is dormant" finding: it fails if
// the policies are dropped, or if set_config stops scoping queries.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { db } from '@platform/shared';

const { Client } = pg;

const ROLE = 'rls_app_test_role';
const ROLE_PW = 'rls_apptest_pw';
let appUrl: string;
let custA: string;
let custB: string;
let childA: string;
let childB: string;

function appRoleUrl(): string {
  const base = process.env.DATABASE_URL!;
  // Swap the userinfo in the connection string for our unprivileged role.
  return base.replace(/\/\/[^@/]+@/, `//${ROLE}:${ROLE_PW}@`);
}

describe.runIf(!!process.env.DATABASE_URL)('RLS tenant isolation', () => {
  beforeAll(async () => {
    // Create the unprivileged role and grant table DML (but NOT bypassrls).
    await sqlRaw(`DROP ROLE IF EXISTS ${ROLE}`);
    await sqlRaw(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE_PW}'`);
    await sqlRaw(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await sqlRaw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
    await sqlRaw(`GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`);

    // Seed two tenants + one message each, as superuser (bypasses RLS).
    const a = await db.insertInto('customers').values({ email: `rls-a-${Date.now()}@t.test`, name: 'A', status: 'active' } as any).returning('id').executeTakeFirstOrThrow();
    const b = await db.insertInto('customers').values({ email: `rls-b-${Date.now()}@t.test`, name: 'B', status: 'active' } as any).returning('id').executeTakeFirstOrThrow();
    custA = a.id; custB = b.id;
    const ca = await db.insertInto('customers').values({ email: `rls-child-a-${Date.now()}@t.test`, name: 'A child', status: 'active', parent_customer_id: custA } as any).returning('id').executeTakeFirstOrThrow();
    const cb = await db.insertInto('customers').values({ email: `rls-child-b-${Date.now()}@t.test`, name: 'B child', status: 'active', parent_customer_id: custB } as any).returning('id').executeTakeFirstOrThrow();
    childA = ca.id; childB = cb.id;
    await db.insertInto('messages').values({ message_id: `rls-a-${Date.now()}`, customer_id: custA, from_address: 's@x.com', to_address: 'a@dest.com', subject: 's', status: 'queued' } as any).execute();
    await db.insertInto('messages').values({ message_id: `rls-b-${Date.now()}`, customer_id: custB, from_address: 's@x.com', to_address: 'b@dest.com', subject: 's', status: 'queued' } as any).execute();
    const today = new Date().toISOString().slice(0, 10);
    await db.insertInto('usage_daily').values([
      { customer_id: childA, usage_date: today, sent: 7 },
      { customer_id: childB, usage_date: today, sent: 11 },
    ] as any).execute();

    appUrl = appRoleUrl();
  });

  afterAll(async () => {
    await db.deleteFrom('messages').where('customer_id', 'in', [custA, custB]).execute();
    await db.deleteFrom('templates').where('customer_id', 'in', [childA, childB]).execute();
    await db.deleteFrom('usage_daily').where('customer_id', 'in', [childA, childB]).execute();
    await db.deleteFrom('customers').where('id', 'in', [childA, childB]).execute();
    await db.deleteFrom('customers').where('id', 'in', [custA, custB]).execute();
    // Role drop must come after its privileges are no longer needed.
    await sqlRaw(`REASSIGN OWNED BY ${ROLE} TO CURRENT_USER`).catch(() => {});
    await sqlRaw(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sqlRaw(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
  });

  it('with tenant=A set, the app role sees ONLY A rows and cannot read B', async () => {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.customer_id', $1, true)`, [custA]);

      const all = await c.query(`SELECT count(*)::int AS n FROM messages WHERE customer_id IN ($1,$2)`, [custA, custB]);
      expect(all.rows[0].n).toBe(1); // only A's row is visible

      const bRows = await c.query(`SELECT count(*)::int AS n FROM messages WHERE customer_id = $1`, [custB]);
      expect(bRows.rows[0].n).toBe(0); // B is invisible even when explicitly queried

      await c.query('COMMIT');
    } finally {
      await c.end();
    }
  });

  it('a malicious query that "forgets" the customer_id filter still cannot leak across tenants', async () => {
    // This is the whole point of RLS as defense-in-depth: even if an application
    // bug or injection drops the WHERE customer_id filter, the row set is still
    // constrained to the tenant.
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.customer_id', $1, true)`, [custB]);
      // No customer_id filter at all — RLS must still scope to B.
      const leaked = await c.query(`SELECT customer_id FROM messages`);
      const others = leaked.rows.filter((r: any) => r.customer_id !== custB);
      expect(others).toHaveLength(0);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
  });

  it('fails closed when no tenant context is set', async () => {
    expect(await isMessagesRlsFailClosed()).toBe(true);
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      const res = await c.query(
        `SELECT count(*)::int AS n FROM messages WHERE customer_id IN ($1,$2)`,
        [custA, custB]
      );
      expect(res.rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });

  it('WITH CHECK blocks writing a row for another tenant', async () => {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.customer_id', $1, true)`, [custA]);
      await expect(c.query(
        `INSERT INTO messages (message_id, customer_id, from_address, to_address, subject, status)
         VALUES ($1, $2, 's@x.com', 'blocked@dest.com', 'blocked', 'queued')`,
        [`rls-write-${Date.now()}`, custB]
      )).rejects.toThrow(/row-level security policy/i);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('lets a parent aggregate direct-child usage but never a different parent family', async () => {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.customer_id', $1, true)`, [custA]);
      const visible = await c.query(`SELECT customer_id, sent FROM usage_daily WHERE customer_id IN ($1,$2) ORDER BY customer_id`, [childA, childB]);
      expect(visible.rows).toEqual([{ customer_id: childA, sent: 7 }]);
      await c.query('COMMIT');
    } finally {
      await c.end();
    }
  });

  it('lets a parent upsert templates only into its direct children', async () => {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.customer_id', $1, true)`, [custA]);
      await expect(c.query(
        `INSERT INTO templates (customer_id, name, subject) VALUES ($1, 'parent-push', 'allowed')`,
        [childA],
      )).resolves.toBeTruthy();
      await expect(c.query(
        `INSERT INTO templates (customer_id, name, subject) VALUES ($1, 'parent-push', 'blocked')`,
        [childB],
      )).rejects.toThrow(/row-level security policy/i);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('the app role cannot bypass RLS (not superuser, not BYPASSRLS)', async () => {
    // Production runs the API under a role like this. If the role could bypass
    // RLS, none of the isolation above would hold in production. This is the
    // guard for the "run the API as a non-BYPASSRLS role" requirement.
    const row = await sqlRawRow<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = '${ROLE}'`
    );
    expect(row?.rolsuper).toBe(false);
    expect(row?.rolbypassrls).toBe(false);
  });
});

// Helper: run a raw statement as the test superuser via Kysely's sql.
import { sql } from 'kysely';
async function sqlRaw(stmt: string): Promise<void> {
  await sql.raw(stmt).execute(db);
}

async function sqlRawRow<T>(stmt: string): Promise<T | undefined> {
  const res = await sql.raw(stmt).execute(db);
  return res.rows[0] as T | undefined;
}

/**
 * Detect whether the fail-closed RLS regime (043_rls_fail_closed.sql) is live
 * for the `messages` table.
 *
 * The distinguishing marker is the `OR current_tenant_id() IS NULL` escape
 * hatch in the policy's USING expression: present => permissive, absent =>
 * fail-closed. We read the policy definition from pg_policies. (We also treat
 * FORCE ROW LEVEL SECURITY as corroborating, but the USING clause is the
 * authoritative signal since that's what actually governs row visibility.)
 */
async function isMessagesRlsFailClosed(): Promise<boolean> {
  const row = await sqlRawRow<{ qual: string | null }>(
    `SELECT qual FROM pg_policies WHERE tablename = 'messages' AND policyname = 'messages_tenant'`
  );
  if (!row || !row.qual) return false;
  // Permissive policy's qual contains "current_tenant_id() IS NULL".
  return !/current_tenant_id\(\)\s+IS\s+NULL/i.test(row.qual);
}
