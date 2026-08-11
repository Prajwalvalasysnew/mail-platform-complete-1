// Cross-platform product coverage runner.
//
// The dedicated Vitest config inlines all @platform workspaces into one module
// graph so the worker-aware V8 provider can instrument product code while
// third-party dependencies (including Kysely) remain in a single native realm.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vitestBin = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const config = join(root, 'packages', 'tests', 'vitest.coverage.config.ts');

const result = spawnSync(
  process.execPath,
  [vitestBin, 'run', '--config', config, '--coverage.enabled'],
  { cwd: root, env: process.env, stdio: 'inherit' },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
