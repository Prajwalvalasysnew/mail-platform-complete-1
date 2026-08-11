// Production and the E2E harness must expose the same route modules.
//
// Importing server.ts is intentionally avoided because it starts listeners and
// external clients. Instead, this guard compares the statically registered
// Fastify route plugin names. A new production route module therefore cannot
// silently remain absent from E2E, and a harness-only route cannot create a
// false picture of production behavior.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REGISTERED_ROUTE = /\.register\(\s*(\w+Routes)\b/g;

async function registeredRoutePlugins(relativeUrl: string): Promise<string[]> {
  const source = await readFile(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8');
  return [...source.matchAll(REGISTERED_ROUTE)].map((match) => match[1]).sort();
}

describe('production/E2E route registration parity', () => {
  it('registers exactly the same route plugin set', async () => {
    const production = await registeredRoutePlugins('../api/src/server.ts');
    const harness = await registeredRoutePlugins('./e2e/harness.ts');

    expect(production.length).toBeGreaterThan(0);
    expect(harness).toEqual(production);
  });
});
