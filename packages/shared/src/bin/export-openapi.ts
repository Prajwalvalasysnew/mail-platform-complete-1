#!/usr/bin/env tsx
// Exports the OpenAPI spec to packages/docs/static/openapi.json so the docs
// site can serve it at /openapi.json for the interactive API explorer.
// Run: tsx packages/shared/src/bin/export-openapi.ts
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { openapiSpec } from '../openapi.js';
const outDir = join(__dirname, '../../../docs/static');
const outPath = join(outDir, 'openapi.json');

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(openapiSpec, null, 2), 'utf-8');
console.log('openapi.json written to', outPath);
