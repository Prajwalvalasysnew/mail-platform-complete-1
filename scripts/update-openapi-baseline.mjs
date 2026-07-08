#!/usr/bin/env node
// Regenerate the OpenAPI contract baseline used by the breaking-change detector
// (packages/tests/openapi-breaking-change.test.ts). Run this INTENTIONALLY when
// you ship an approved breaking change (e.g. a new API version):
//
//     npm run build   # ensure @platform/shared/dist is current
//     node scripts/update-openapi-baseline.mjs
//
// Commit the updated fixtures/openapi-baseline.json in the same change, so the
// diff is visible in review.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openapiSpec } = require('../packages/shared/dist/openapi.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(__dirname, '..', 'packages', 'tests', 'fixtures', 'openapi-baseline.json');

const contract = {};
for (const [p, methods] of Object.entries(openapiSpec.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    if (typeof op !== 'object' || !op) continue;
    const key = `${method.toUpperCase()} ${p}`;
    const requiredParams = ((op.parameters) ?? []).filter((pp) => pp.required).map((pp) => pp.name).sort();
    contract[key] = { operationId: op.operationId ?? null, requiredParams };
  }
}

writeFileSync(out, JSON.stringify(contract, null, 2) + '\n');
console.log(`Wrote ${Object.keys(contract).length} operations to ${out}`);
