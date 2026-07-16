// Static regression guard for fail-closed tenant RLS.
//
// The API database role is deliberately non-BYPASSRLS. A query against an
// RLS-backed table must therefore use the request transaction created by
// tenantScoped(), not the global shared db handle (which would have no
// app.customer_id setting and fail closed). This test catches the easy
// regression: adding a direct global-db query to a customer route.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routeDir = path.resolve(__dirname, '..', 'api', 'src', 'routes');

const RLS_TABLES = [
  'messages', 'events', 'suppressions', 'templates', 'sending_domains',
  'webhooks', 'usage_daily', 'review_queue', 'consent_events', 'legal_holds',
  'data_exports',
].join('|');

// Admin routes are an explicit cross-tenant service-role plane and are audited
// separately. All other route modules must not query an RLS table via `db`.
const DIRECT_GLOBAL_RLS_QUERY = new RegExp(
  String.raw`\bdb\s*\.\s*(?:selectFrom|insertInto|updateTable|deleteFrom)\s*\(\s*['"](?:${RLS_TABLES})['"]`,
  's'
);

describe('tenant route RLS guard', () => {
  const routeFiles = readdirSync(routeDir)
    .filter((file) => file.endsWith('.ts') && file !== 'admin.ts');

  it('does not use the global db handle for RLS-backed tables outside the admin plane', () => {
    for (const file of routeFiles) {
      const source = readFileSync(path.join(routeDir, file), 'utf8');
      expect(source, `${file} directly queries an RLS table with global db`).not.toMatch(DIRECT_GLOBAL_RLS_QUERY);
    }
  });
});
