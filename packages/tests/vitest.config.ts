import { defineConfig } from 'vitest/config';

// The @platform/* workspace packages are compiled to CommonJS in their dist/
// folders. We must NOT let vitest re-transform their TypeScript source, because
// that produces a second copy of kysely's classes in vitest's module graph and
// triggers the cjs/esm dual-package hazard ("Cannot read private member
// #props"). Externalizing the packages by name forces Node's native resolver to
// load each one's built dist (which honors its package.json "exports"), keeping
// the DB singleton and every Kysely query builder in a single realm.
export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: './global-setup.ts',
    include: ['*.test.ts', 'e2e/**/*.e2e.test.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    fileParallelism: false,
    sequence: { concurrent: false },
    server: {
      deps: {
        external: [
          '@platform/shared',
          '@platform/api',
          '@platform/worker',
          '@platform/smtp-gateway',
          /node_modules/,
        ],
      },
    },
  },
});
