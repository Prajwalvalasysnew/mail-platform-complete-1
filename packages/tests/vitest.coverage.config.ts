import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const testsRoot = fileURLToPath(new URL('.', import.meta.url));

// A few migration fixtures intentionally resolve from the tests workspace.
// Keep that runtime contract while using the repository root for coverage globs.
process.chdir(testsRoot);

export default defineConfig({
  root: repositoryRoot,
  test: {
    environment: 'node',
    globalSetup: './packages/tests/global-setup.ts',
    include: ['packages/tests/*.test.ts', 'packages/tests/e2e/**/*.e2e.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    sequence: { concurrent: false },
    server: {
      deps: {
        inline: [
          /^@platform\/(?:shared|api|worker|smtp-gateway|tracker)(?:\/|$)/,
          /packages\/(?:shared|api|worker|smtp-gateway|tracker)\/dist\//,
        ],
        external: [/node_modules/],
      },
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/product',
      reporter: ['text-summary', 'json-summary', 'html', 'lcov'],
      allowExternal: true,
      include: [
        'packages/shared/dist/**/*.js',
        'packages/api/dist/**/*.js',
        'packages/worker/dist/**/*.js',
        'packages/tracker/dist/**/*.js',
        'packages/smtp-gateway/dist/**/*.js',
        'packages/sdk/dist/**/*.js',
      ],
      exclude: ['packages/shared/dist/bin/**'],
      all: true,
      thresholds: {
        statements: 75,
        branches: 64,
        functions: 77,
        lines: 79,
      },
    },
  },
});
