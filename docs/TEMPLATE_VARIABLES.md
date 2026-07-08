# Template variable validation

Addresses the gap analysis findings in §3.3.6 / §2.5.4: templates did not
declare their variables, and `renderTemplate` silently substituted an empty
string for any missing variable — so `Hi {{name}}, your order {{order_id}}`
would happily send "Hi , your order  is ready" if `order_id` was omitted, with
no signal to the caller.

This is a scoped, backward-compatible improvement — NOT the full template
versioning / draft-publish system the report also mentions (that's a larger
product feature deferred deliberately).

## What changed

`packages/shared/src/templates.ts`:
- `extractTemplateVariables(source)` — best-effort static AST scan returning the
  top-level variable names a template references (`{{name}}`, `{{user.x}}` →
  `user`, `{{#each items}}` → `items`). Helper names (`if`/`each`/…), data refs
  (`@index`), and relative paths (`this.`/`../`) are excluded. Malformed
  templates return `[]` rather than throwing. Implemented with duck-typed AST
  walking (not the `hbs.AST.*` ambient types, which aren't reliably available).
- `renderTemplate(template, variables, options?)` — now always returns
  `missing_variables: string[]` (variables the template references that were
  absent/null/undefined in `variables`). New optional `options.onMissing`:
  - `'ignore'` (default) — historical behavior, render missing as empty string.
  - `'error'` — throw `MissingTemplateVariablesError` listing the missing names.
- `validateTemplate(source)` — now also returns `variables?: string[]` on
  success.

All changes are additive: existing callers that only read `.subject/.html/
.text` are byte-for-byte unaffected, and `onMissing` defaults to the old
behavior.

`packages/api/src/routes/templates.ts`:
- `POST /templates` and `PUT /templates/:id` responses now include
  `variables: string[]` — the union of variables across subject/html/text — so
  a customer/dashboard can see exactly which `{{variables}}` a template expects.

`packages/api/src/routes/send.ts`:
- `/send` and `/send/batch` accept an opt-in `require_all_variables: boolean`.
  When true and a template variable is missing, `/send` returns
  `422 { error: 'missing_template_variables', missing: [...] }` and `/send/batch`
  rejects just that message (`error: 'missing_template_variables:<names>'`,
  quota refunded) rather than silently sending a broken email. Defaults to the
  lenient behavior so existing integrations are unaffected.

## Tests

`packages/tests/templates.test.ts` (pure functions, no DB) covers variable
extraction (simple/nested/block-helper/malformed), missing-variable reporting,
null/undefined treated as missing, and the `onMissing: 'error'` throw path.

## Verified how

- `npm install` succeeded in this environment, so verification is real (not
  just static checks this time).
- Full `tsc` typecheck passes for all four packages: `@platform/shared`,
  `@platform/api`, `@platform/worker`, `@platform/tracker`.
- `packages/tests/templates.test.ts` runs green: **20/20 tests pass** under
  vitest against the installed Handlebars 4.7.x (pure logic, no DB/Redis
  needed).

Running the tests caught a real bug in the first cut of
`extractTemplateVariables`: block-helper arguments nested inside another block
(e.g. `items` in `{{#if a}}{{#each items}}…`) were dropped because they were
gated to depth 0. Fixed by recording block-helper *arguments* at any depth
(they resolve in the enclosing scope) while keeping the depth-0 gate only for
plain mustache paths (which may be loop-local inside a scope-changing block).

DB-backed and Redis-backed test suites still cannot run here (no Postgres/Redis
in this sandbox), but the template work is entirely pure-function logic and is
now genuinely test-verified.
