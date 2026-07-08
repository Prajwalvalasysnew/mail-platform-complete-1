// OpenAPI breaking-change detector (gap analysis Top-20 #20, §23.3.5 item 2).
//
// Compares the CURRENT published OpenAPI contract against a committed baseline
// snapshot (fixtures/openapi-baseline.json) and fails on BREAKING changes:
//   - a previously-published operation (METHOD + path) was removed,
//   - an operationId changed (client SDKs key off these),
//   - a new REQUIRED parameter was added to an existing operation
//     (old clients that don't send it would start failing).
//
// Non-breaking changes (new operations, new OPTIONAL params) are allowed and
// simply reported. When a breaking change is intentional (a real new API
// version), regenerate the baseline in the same change:
//     node scripts/update-openapi-baseline.mjs
//
// This is the CI gate the report asks for ("Add OpenAPI diff in CI and block
// unapproved breaking changes"). It runs offline — no DB, no network.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openapiSpec } from '@platform/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baselinePath = path.join(__dirname, 'fixtures', 'openapi-baseline.json');

interface OpContract { operationId: string | null; requiredParams: string[] }

function currentContract(): Record<string, OpContract> {
  const contract: Record<string, OpContract> = {};
  for (const [p, methods] of Object.entries(openapiSpec.paths as Record<string, any>)) {
    for (const [method, op] of Object.entries(methods as Record<string, any>)) {
      if (typeof op !== 'object' || !op) continue;
      const key = `${method.toUpperCase()} ${p}`;
      const requiredParams = ((op.parameters as any[]) ?? []).filter((pp) => pp.required).map((pp) => pp.name).sort();
      contract[key] = { operationId: op.operationId ?? null, requiredParams };
    }
  }
  return contract;
}

describe('OpenAPI breaking-change detector', () => {
  const baseline: Record<string, OpContract> = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const current = currentContract();

  it('does not remove any previously-published operation', () => {
    const removed = Object.keys(baseline).filter((op) => !(op in current));
    expect(
      removed,
      `These operations existed in the baseline but are gone from the current spec — ` +
        `removing a published operation is a BREAKING change. If intentional (new API ` +
        `version), regenerate fixtures/openapi-baseline.json.\n${removed.join('\n')}`
    ).toEqual([]);
  });

  it('does not change the operationId of any existing operation', () => {
    const changed: string[] = [];
    for (const [op, spec] of Object.entries(baseline)) {
      if (current[op] && current[op].operationId !== spec.operationId) {
        changed.push(`${op}: '${spec.operationId}' -> '${current[op].operationId}'`);
      }
    }
    expect(
      changed,
      `operationId changes break generated SDKs that key off them:\n${changed.join('\n')}`
    ).toEqual([]);
  });

  it('does not add a new REQUIRED parameter to an existing operation', () => {
    const newlyRequired: string[] = [];
    for (const [op, spec] of Object.entries(baseline)) {
      if (!current[op]) continue;
      const added = current[op].requiredParams.filter((p) => !spec.requiredParams.includes(p));
      if (added.length) newlyRequired.push(`${op}: +required [${added.join(', ')}]`);
    }
    expect(
      newlyRequired,
      `Adding a required parameter breaks existing clients that don't send it:\n${newlyRequired.join('\n')}`
    ).toEqual([]);
  });

  it('reports (non-failing) any newly added operations for awareness', () => {
    const added = Object.keys(current).filter((op) => !(op in baseline));
    // Not an assertion failure — new operations are backward compatible. This
    // documents them so a reviewer notices the surface grew.
    if (added.length) {
      // eslint-disable-next-line no-console
      console.log(`[openapi] ${added.length} new operation(s) since baseline: ${added.join(', ')}`);
    }
    expect(Array.isArray(added)).toBe(true);
  });
});
