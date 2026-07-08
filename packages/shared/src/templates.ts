// Template rendering. Customers can store reusable templates with variable
// substitution, then reference them by template_id in /v1/send.
// Uses Handlebars with HTML escaping on by default.

import Handlebars from 'handlebars';

// Cache compiled templates in-process keyed by a hash of the source
const cache = new Map<string, HandlebarsTemplateDelegate>();

function compile(source: string): HandlebarsTemplateDelegate {
  const existing = cache.get(source);
  if (existing) return existing;
  const tpl = Handlebars.compile(source, { noEscape: false, strict: false });
  if (cache.size >= 1000) {
    const first = cache.keys().next().value;
    if (first !== undefined) {
      cache.delete(first);
    }
  }
  cache.set(source, tpl);
  return tpl;
}

export interface RenderResult {
  subject: string;
  html?: string;
  text?: string;
  /**
   * Variable names referenced by the template that were not supplied in
   * `variables` (and thus rendered as empty strings). Always populated so
   * callers can detect the silent-empty-substitution footgun; whether to
   * treat it as an error is the caller's decision (see RenderOptions.onMissing).
   */
  missing_variables: string[];
}

export interface RenderOptions {
  /**
   * What to do when the template references a variable that isn't supplied:
   *  - 'ignore' (default): render it as an empty string (Handlebars default,
   *    preserves existing behavior). Missing vars are still reported in
   *    RenderResult.missing_variables.
   *  - 'error': throw a MissingTemplateVariablesError listing every missing
   *    variable, so a caller can reject the send instead of silently
   *    delivering "Hi , your order  is ready".
   */
  onMissing?: 'ignore' | 'error';
}

export class MissingTemplateVariablesError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Template references variables that were not provided: ${missing.join(', ')}`);
    this.name = 'MissingTemplateVariablesError';
  }
}

/**
 * Extract the top-level variable names a Handlebars template references
 * (simple `{{mustache}}` and `{{{unescaped}}}` paths, plus the path arguments
 * of block helpers like `{{#each items}}` / `{{#if cond}}`).
 *
 * This is a best-effort static scan of the parsed AST — it intentionally does
 * NOT try to fully resolve nested/relative paths inside blocks (e.g. `this.x`
 * inside an `{{#each}}`), which would require data-shape knowledge. It's used
 * for (a) reporting declared variables to customers and (b) computing which
 * *top-level* variables are missing at render time.
 *
 * Implemented with structural (duck-typed) AST walking rather than the
 * `hbs.AST.*` ambient types, which aren't reliably available across Handlebars
 * type setups.
 */
export function extractTemplateVariables(source: string): string[] {
  const found = new Set<string>();
  let ast: unknown;
  try {
    ast = Handlebars.parse(source);
  } catch {
    return [];
  }

  const HELPERS = new Set([
    'if', 'unless', 'each', 'with', 'lookup', 'log', 'blockHelperMissing',
    'helperMissing', 'else',
  ]);

  // A parsed path node looks like: { type: 'PathExpression', original, parts,
  // data }. `mustacheDepthGate` controls whether we require depth 0:
  //  - plain mustache paths ({{x}}): only count at top level, since inside a
  //    scope-changing block ({{#each}}/{{#with}}) they may be loop/item-local.
  //  - block-helper arguments ({{#each ITEMS}}): count at ANY depth, because
  //    the argument resolves in the block's ENCLOSING scope, so it's a real
  //    variable the caller must supply (e.g. {{#if a}}{{#each items}}...
  //    means both `a` and `items` are top-level inputs).
  const recordPath = (node: any, depth: number, requireTopLevel: boolean): void => {
    if (!node || node.type !== 'PathExpression') return;
    const head: string | undefined = node.parts?.[0];
    const original: string = node.original ?? '';
    const isHelper = HELPERS.has(original) || HELPERS.has(head ?? '');
    if (
      !isHelper &&
      head &&
      !node.data &&
      (!requireTopLevel || depth === 0) &&
      !original.startsWith('.') &&
      !original.startsWith('@')
    ) {
      found.add(head);
    }
  };

  const visit = (statements: any[], depth: number): void => {
    for (const st of statements ?? []) {
      if (!st || typeof st !== 'object') continue;
      if (st.type === 'MustacheStatement') {
        // {{name}} with no params → path is the variable. With params it's a
        // helper call; the params carry the real variable refs.
        if (!st.params || st.params.length === 0) {
          recordPath(st.path, depth, true);
        }
        for (const p of st.params ?? []) recordPath(p, depth, false);
      } else if (st.type === 'BlockStatement') {
        // {{#each items}} → path='each' (helper), params=[items]. The params
        // resolve in the enclosing scope → record at any depth.
        for (const p of st.params ?? []) recordPath(p, depth, false);
        if (st.program?.body) visit(st.program.body, depth + 1);
        if (st.inverse?.body) visit(st.inverse.body, depth + 1);
      }
    }
  };

  visit((ast as any).body, 0);
  return Array.from(found).sort();
}

/**
 * Compute which of a template's referenced top-level variables are absent from
 * (or undefined/null in) the supplied `variables`.
 */
function computeMissing(sources: string[], variables: Record<string, unknown>): string[] {
  const missing = new Set<string>();
  for (const src of sources) {
    for (const name of extractTemplateVariables(src)) {
      const v = variables[name];
      if (v === undefined || v === null) missing.add(name);
    }
  }
  return Array.from(missing).sort();
}

export function renderTemplate(
  template: { subject: string; html_body?: string | null; text_body?: string | null },
  variables: Record<string, unknown>,
  options: RenderOptions = {}
): RenderResult {
  const sources = [template.subject, template.html_body ?? '', template.text_body ?? ''].filter(Boolean) as string[];
  const missing = computeMissing(sources, variables);

  if (missing.length > 0 && options.onMissing === 'error') {
    throw new MissingTemplateVariablesError(missing);
  }

  const result: RenderResult = {
    subject: compile(template.subject)(variables),
    missing_variables: missing,
  };
  if (template.html_body) result.html = compile(template.html_body)(variables);
  if (template.text_body) result.text = compile(template.text_body)(variables);
  return result;
}

/**
 * Validate that a template compiles without throwing. Optionally also returns
 * the variables it references, so the create/update API can surface them.
 */
export function validateTemplate(source: string): { valid: boolean; error?: string; variables?: string[] } {
  try {
    Handlebars.compile(source)({});
    return { valid: true, variables: extractTemplateVariables(source) };
  } catch (err: any) {
    return { valid: false, error: err.message };
  }
}
