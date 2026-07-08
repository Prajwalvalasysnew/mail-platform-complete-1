// Bootstrap / manage admin users from the CLI (there is no admin self-signup).
// Usage:
//   DATABASE_URL=... node packages/shared/dist/bin/create-admin.js <email> <role> [name]
// The password is read from the ADMIN_PASSWORD env var (not argv, to keep it
// out of shell history / process listings). Role: support|operator|admin|superadmin.
import { createAdminUser, setAdminPassword, type AdminRole } from '../admin.js';
import { db } from '../db.js';

async function main() {
  const [email, role, ...nameParts] = process.argv.slice(2);
  const password = process.env.ADMIN_PASSWORD;
  const roles = ['support', 'operator', 'admin', 'superadmin'];
  if (!email || !role || !roles.includes(role)) {
    console.error('usage: create-admin <email> <support|operator|admin|superadmin> [name]  (ADMIN_PASSWORD env required)');
    process.exit(2);
  }
  if (!password || password.length < 12) {
    console.error('ADMIN_PASSWORD env var required (>= 12 chars)');
    process.exit(2);
  }
  const name = nameParts.join(' ') || null;
  const result = await createAdminUser({ email, name, role: role as AdminRole, password });
  if ('error' in result) {
    // Already exists: rotate the password instead so the command is idempotent.
    const existing = await db.selectFrom('admin_users').select('id').where('email', '=', email.toLowerCase()).executeTakeFirst();
    if (existing) {
      await setAdminPassword(existing.id, password);
      console.log(`[create-admin] updated password for existing admin ${email}`);
    } else {
      console.error(`[create-admin] failed: ${result.error}`);
      process.exit(1);
    }
  } else {
    console.log(`[create-admin] created ${role} admin ${email} (id=${result.id})`);
  }
  await db.destroy();
  process.exit(0);
}
main().catch((err) => { console.error('[create-admin] error:', err); process.exit(1); });
