// Standalone migrations CLI. Usage:
//   node packages/shared/dist/bin/migrate.js
//   DATABASE_URL=postgres://... npm --workspace @platform/shared run migrate
import { runMigrations } from '../migrate.js';

const args = process.argv.slice(2);
const baselineExisting = args.includes('--baseline-existing');
const dir = args.find((arg) => !arg.startsWith('--')) || process.env.MIGRATIONS_DIR;

runMigrations({ ...(dir ? { dir } : {}), baselineExisting }).then(
  (result) => {
    console.log(`[migrate] done. applied=${result.applied.length} baselined=${result.baselined.length}`);
    process.exit(0);
  },
  (err: Error) => {
    console.error('[migrate] FAILED:', err.message);
    process.exit(1);
  }
);
