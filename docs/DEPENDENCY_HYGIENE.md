# Dependency hygiene (gap analysis Top-20 #3)

## Before

`npm audit --omit=dev` reported **27 moderate advisories, 0 high, 0 critical**.
All 27 traced to three root CVEs:

- `@opentelemetry/core <2.8.0` — unbounded memory allocation in W3C Baggage
  propagation (GHSA-8988-4f7v-96qf). This one CVE cascaded across the entire
  OpenTelemetry dependency tree (~25 of the 27 advisories).
- `protobufjs <=7.6.2` — schema-derived names can shadow runtime-significant
  properties (GHSA-f38q-mgvj-vph7). Transitive via grpc.
- `tar <=7.5.15` — PAX size-override parser differential / file smuggling
  (GHSA-vmf3-w455-68vh). Transitive via Haraka -> node-gyp.

## After

`npm audit --omit=dev` reports **0 vulnerabilities**.

## Changes

`packages/shared/package.json` — OpenTelemetry bumped to the patched line
(brings in `@opentelemetry/core@2.9.0`):
- `@opentelemetry/exporter-trace-otlp-http`  ^0.218 -> ^0.220
- `@opentelemetry/instrumentation-http`      ^0.218 -> ^0.220
- `@opentelemetry/instrumentation-ioredis`   ^0.66  -> ^0.68
- `@opentelemetry/instrumentation-pg`        ^0.70  -> ^0.72
- `@opentelemetry/sdk-node`                  ^0.218 -> ^0.220
- `@opentelemetry/resources`                 ^2.7.1 -> ^2.9.0

Root `package.json` `overrides` (patched, kept within the same major so grpc /
node-gyp parent ranges `^7.5.5` / `^7.5.4` are still satisfied):
- `protobufjs`: `7.6.5`
- `tar`: `7.5.19`

`packages/tests/package.json` — the tracing test imported OTel test utilities
(`@opentelemetry/sdk-trace-node`, `sdk-trace-base`, `api`) that were previously
only present as transitively-hoisted deps of the old sdk-node. That was a latent
fragility (any clean install with different hoisting would break it); the
upgrade exposed it. These are now explicit devDependencies pinned to `^2.9.0` /
`^1.9.0` so the test no longer depends on hoisting luck.

## Verified how (real, against live infra)

- `npm audit --omit=dev --audit-level=moderate` -> **0 vulnerabilities**.
- Full `npm run build` across all 5 packages: exit 0, no TS errors — confirms
  the OpenTelemetry API surface used by `packages/shared/src/tracing.ts`
  (`NodeSDK`, `OTLPTraceExporter`, `resourceFromAttributes`, the instrumentation
  constructors) is compatible with the 0.220 / 2.9 line.
- `@platform/shared` imports cleanly at runtime (the instrumentation tree,
  including `require-in-the-middle`, resolves).
- `tracing.test.ts`: 4/4 pass (in-memory span exporter exercises real span
  creation/nesting/exception recording).
- **Full suite: 85 files, 572 tests, 0 failures** — the dependency overhaul
  broke nothing.

## Note on the install

The OTel major-ish bump (0.218 -> 0.220 crosses experimental-package breaking
boundaries) changed dependency hoisting. A clean `rm -rf node_modules
package-lock.json && npm install` was required to get a correct tree — an
incremental install left `require-in-the-middle` (a new transitive of
instrumentation@0.220) unresolved. CI should do a clean install after pulling
this change.
