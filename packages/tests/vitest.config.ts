import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The @platform/* workspace packages are compiled to CommonJS in their dist/
// folders. We must NOT let vitest re-transform their TypeScript source, because
// that produces a second copy of kysely's classes in vitest's module graph and
// triggers the cjs/esm dual-package hazard ("Cannot read private member
// #props"). Externalizing the packages by name forces Node's native resolver to
// load each one's built dist (which honors its package.json "exports"), keeping
// the DB singleton and every Kysely query builder in a single realm.
export default defineConfig({
  resolve: {
    // Vitest 4 can resolve this external workspace subpath to an empty module
    // namespace. Transform the tracker route module, while its @platform/shared
    // import remains external so Kysely and queue singletons stay in one realm.
    alias: {
      '@platform/tracker/app': fileURLToPath(new URL('../tracker/src/app.ts', import.meta.url)),
    },
  },
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
          /^@platform\/(?:shared|api|worker|smtp-gateway)(?:\/|$)/,
          /packages\/(?:shared|api|worker|smtp-gateway)\/dist\//,
          /node_modules/,
        ],
      },
    },
  },
});
