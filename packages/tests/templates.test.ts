// Unit tests for template rendering. Pure functions (no DB/Redis). Covers
// variable substitution across subject/html/text, missing-variable behavior,
// HTML-escaping (injection safety), and validation of malformed templates.

import { describe, it, expect } from 'vitest';
import { renderTemplate, validateTemplate, extractTemplateVariables } from '@platform/shared';

describe('renderTemplate', () => {
  it('substitutes variables in subject, html, and text', () => {
    const r = renderTemplate(
      { subject: 'Hi {{name}}', html_body: '<p>Hello {{name}}</p>', text_body: 'Hello {{name}}' },
      { name: 'Ada' }
    );
    expect(r.subject).toBe('Hi Ada');
    expect(r.html).toBe('<p>Hello Ada</p>');
    expect(r.text).toBe('Hello Ada');
  });

  it('omits html/text when the template has none', () => {
    const r = renderTemplate({ subject: 'Subject only' }, {});
    expect(r.subject).toBe('Subject only');
    expect(r.html).toBeUndefined();
    expect(r.text).toBeUndefined();
  });

  it('renders missing variables as empty (Handlebars default), not "undefined"', () => {
    const r = renderTemplate({ subject: 'Hi {{name}}!' }, {});
    expect(r.subject).toBe('Hi !');
  });

  it('reports which variables were missing (without failing by default)', () => {
    const r = renderTemplate(
      { subject: 'Hi {{name}}', html_body: '<p>Order {{order_id}} for {{name}}</p>' },
      { name: 'Ada' }
    );
    expect(r.subject).toBe('Hi Ada');
    expect(r.missing_variables).toEqual(['order_id']);
  });

  it('reports no missing variables when all are supplied', () => {
    const r = renderTemplate({ subject: 'Hi {{name}}' }, { name: 'Ada' });
    expect(r.missing_variables).toEqual([]);
  });

  it('treats null/undefined values as missing', () => {
    const r = renderTemplate({ subject: '{{a}}{{b}}{{c}}' }, { a: 'x', b: null, c: undefined });
    expect(r.missing_variables).toEqual(['b', 'c']);
  });

  it('throws MissingTemplateVariablesError when onMissing=error and vars are absent', () => {
    expect(() =>
      renderTemplate({ subject: 'Hi {{name}}, order {{order_id}}' }, { name: 'Ada' }, { onMissing: 'error' })
    ).toThrowError(/order_id/);
  });

  it('does not throw with onMissing=error when all vars are present', () => {
    const r = renderTemplate(
      { subject: 'Hi {{name}}' },
      { name: 'Ada' },
      { onMissing: 'error' }
    );
    expect(r.subject).toBe('Hi Ada');
  });

  it('HTML-escapes interpolated values to prevent injection', () => {
    const r = renderTemplate(
      { subject: 'x', html_body: '<p>{{payload}}</p>' },
      { payload: '<script>alert(1)</script>' }
    );
    // Handlebars escapes by default with {{ }}.
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
  });

  it('supports triple-stache raw output where explicitly requested', () => {
    const r = renderTemplate(
      { subject: 'x', html_body: '<div>{{{raw}}}</div>' },
      { raw: '<b>bold</b>' }
    );
    expect(r.html).toBe('<div><b>bold</b></div>');
  });

  it('handles nested variables', () => {
    const r = renderTemplate({ subject: 'Hi {{user.first}} {{user.last}}' }, { user: { first: 'Grace', last: 'Hopper' } });
    expect(r.subject).toBe('Hi Grace Hopper');
  });
});

describe('extractTemplateVariables', () => {
  it('extracts simple mustache variables', () => {
    expect(extractTemplateVariables('Hi {{name}}, your {{item}}')).toEqual(['item', 'name']);
  });

  it('extracts the root of a nested path', () => {
    expect(extractTemplateVariables('{{user.first}} {{user.last}}')).toEqual(['user']);
  });

  it('extracts block-helper arguments, not the helper name', () => {
    expect(extractTemplateVariables('{{#each items}}{{this}}{{/each}}')).toEqual(['items']);
    expect(extractTemplateVariables('{{#if active}}yes{{/if}}')).toEqual(['active']);
  });

  it('does not report helper names (if/each/etc.) as variables', () => {
    const vars = extractTemplateVariables('{{#if x}}{{#each y}}{{z}}{{/each}}{{/if}}');
    // x and y are top-level; z is inside blocks (depth > 0) so excluded.
    expect(vars).toContain('x');
    expect(vars).toContain('y');
    expect(vars).not.toContain('if');
    expect(vars).not.toContain('each');
  });

  it('returns empty for a malformed template rather than throwing', () => {
    expect(extractTemplateVariables('{{#if x}}no close')).toEqual([]);
  });

  it('handles triple-stache the same as double', () => {
    expect(extractTemplateVariables('{{{raw}}}')).toEqual(['raw']);
  });
});

describe('validateTemplate', () => {
  it('accepts a well-formed template and reports its variables', () => {
    expect(validateTemplate('Hello {{name}}')).toEqual({ valid: true, variables: ['name'] });
  });

  it('rejects an unclosed expression', () => {
    const r = validateTemplate('Hello {{name');
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('rejects a malformed block helper', () => {
    const r = validateTemplate('{{#if x}}no close');
    expect(r.valid).toBe(false);
  });
});
