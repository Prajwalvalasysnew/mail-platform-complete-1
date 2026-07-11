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

describe('production Compose runtime hardening', () => {
  it('gives API, worker, and tracker a restart policy and endpoint healthcheck', () => {
    const production = read('docker-compose.production.yml');
    for (const service of ['api', 'worker', 'tracker']) {
      const section = production.match(new RegExp(`^  ${service}:\\r?\\n([\\s\\S]*?)(?=^  [a-z_-]+:\\r?\\n)`, 'm'))?.[1] ?? '';
      expect(section, `${service} must restart after an unexpected exit`).toMatch(/restart:\s*unless-stopped/);
      expect(section, `${service} must declare a Docker healthcheck`).toMatch(/healthcheck:/);
      expect(section, `${service} healthcheck must use its local HTTP endpoint`).toMatch(/127\.0\.0\.1/);
    }
  });
});

describe('Kubernetes restricted workload posture', () => {
  it('keeps API, worker, and tracker non-root with a read-only root filesystem and writable tmpfs', () => {
    for (const component of ['api', 'worker', 'tracker']) {
      const template = read(`infra/helm/mail-platform/templates/${component}-deployment.yaml`);
      expect(template, `${component} must run as non-root`).toMatch(/runAsNonRoot:\s*true/);
      expect(template, `${component} must use RuntimeDefault seccomp`).toMatch(/seccompProfile:\s*\n\s*type:\s*RuntimeDefault/);
      expect(template, `${component} must not allow privilege escalation`).toMatch(/allowPrivilegeEscalation:\s*false/);
      expect(template, `${component} must drop all capabilities`).toMatch(/drop:\s*\["ALL"\]/);
      expect(template, `${component} must have a read-only root`).toMatch(/readOnlyRootFilesystem:\s*true/);
      expect(template, `${component} must provide writable /tmp`).toMatch(/mountPath:\s*\/tmp/);
      expect(template, `${component} must define the temporary volume`).toMatch(/name:\s*tmp\s*\n\s*emptyDir:\s*\{\}/);
      expect(template, `${component} must tolerate normal startup before liveness begins`).toMatch(/startupProbe:/);
    }
  });
});

describe('Haraka Kubernetes production topology', () => {
  it('deploys TLS-mounted inbound/outbound SMTP with a durable outbound queue', () => {
    const template = read('infra/helm/mail-platform/templates/haraka.yaml');
    expect(template).toMatch(/kind:\s*StatefulSet/);
    expect(template).toMatch(/volumeClaimTemplates:/);
    expect(template).toMatch(/mountPath:\s*\/app\/queue/);
    expect(template).toMatch(/tlsSecretName/);
    expect(template).toMatch(/kind:\s*Deployment/);
    expect(template).toMatch(/type:\s*\{\{ \.Values\.haraka\.inbound\.serviceType \}\}/);
    expect(template.match(/startupProbe:/g)?.length).toBe(2);
    expect(template.match(/readOnlyRootFilesystem:\s*true/g)?.length).toBe(2);
  });

  it('runs both Haraka images as non-root and keeps inbound off privileged container port 25', () => {
    expect(read('packages/haraka-outbound/Dockerfile')).toMatch(/USER\s+node/);
    expect(read('packages/haraka-inbound/Dockerfile')).toMatch(/USER\s+node/);
    expect(read('packages/haraka-inbound/config/smtp.ini')).toMatch(/listen=\[::\]:2526/);
  });
});
