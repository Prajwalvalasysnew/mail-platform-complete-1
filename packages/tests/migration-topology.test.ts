// Migration topology guard (gap analysis Top-20 #6).
//
// The report flagged "app containers still run migrations; Helm also has
// migration job" as a production risk: multiple app replicas racing DDL on
// deploy. This snapshot already fixed it — migrations run via a single
// dedicated path (a one-shot compose service / a Helm pre-install|pre-upgrade
// hook Job), and app boot code never migrates. These tests LOCK THAT IN so a
// future change can't silently reintroduce app-startup migrations.
//
// Pure filesystem assertions — no DB, no network.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

describe('migration topology: app containers must NOT migrate at startup', () => {
  const appDockerfiles = [
    'packages/api/Dockerfile',
    'packages/worker/Dockerfile',
    'packages/tracker/Dockerfile',
  ];

  for (const df of appDockerfiles) {
    it(`${df} CMD/ENTRYPOINT does not invoke the migrate binary`, () => {
      const content = read(df);
      const cmdLines = content
        .split('\n')
        .filter((l) => /^\s*(CMD|ENTRYPOINT)\b/i.test(l));
      expect(cmdLines.length).toBeGreaterThan(0); // sanity: there is a CMD
      for (const line of cmdLines) {
        expect(line).not.toMatch(/migrate/i);
      }
    });
  }

  it('app boot sources do not call runMigrations()/migrate.js', () => {
    const bootFiles = [
      'packages/api/src/server.ts',
      'packages/worker/src/index.ts',
      'packages/tracker/src/server.ts',
    ];
    for (const f of bootFiles) {
      const src = read(f);
      expect(src, `${f} must not run migrations at boot`).not.toMatch(/runMigrations\s*\(/);
      expect(src, `${f} must not shell out to the migrate binary`).not.toMatch(/migrate\.js/);
    }
  });
});

describe('migration topology: a single dedicated migration path exists', () => {
  it('docker-compose defines a one-shot migrate service and app services wait for it', () => {
    const compose = read('docker-compose.yml');
    // A dedicated migrate service exists.
    expect(compose).toMatch(/^\s{2}migrate:/m);
    expect(compose).toMatch(/migrate\.js/);
    // App services gate on its successful completion (not merely "started").
    expect(compose).toMatch(/service_completed_successfully/);
  });

  it('Helm runs migrations as a pre-install/pre-upgrade hook Job', () => {
    const job = read('infra/helm/mail-platform/templates/migration-job.yaml');
    expect(job).toMatch(/kind:\s*Job/);
    expect(job).toMatch(/helm\.sh\/hook["']?:\s*pre-install,pre-upgrade/);
    // Negative hook weight => runs before the app workloads.
    expect(job).toMatch(/hook-weight["']?:\s*["']?-\d/);
    expect(job).toMatch(/migrate\.js/);
  });
});
