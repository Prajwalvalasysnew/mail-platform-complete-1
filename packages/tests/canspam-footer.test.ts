// CANSPAM-04: the compliance footer must be tamper-resistant — appended after
// all rendering to every present body format, with the address HTML-escaped
// so a crafted value cannot inject markup or a fake unsubscribe target.

import { describe, it, expect } from 'vitest';
import { appendCompliantFooter, escapeFooterHtml } from '@platform/shared';

const ADDRESS = '123 Main St\nSpringfield, ZZ 00000';
const URL = 'https://track.example.com/u/abc123';

describe('appendCompliantFooter', () => {
  it('appends address and unsubscribe link to both formats', () => {
    const out = appendCompliantFooter({ html: '<p>promo</p>', text: 'promo', physicalAddress: ADDRESS, unsubUrl: URL });
    expect(out.html).toContain('123 Main St<br>Springfield');
    expect(out.html).toContain(`href="${URL}"`);
    expect(out.html).toContain('Unsubscribe');
    expect(out.text).toContain('123 Main St\nSpringfield');
    expect(out.text).toContain(`Unsubscribe: ${URL}`);
  });

  it('appends AFTER the content so message bodies cannot displace it', () => {
    const html = '<p>content</p><!-- attempted footer strip --></div></body>';
    const out = appendCompliantFooter({ html, text: 'x', physicalAddress: ADDRESS, unsubUrl: URL });
    expect(out.html!.indexOf('Unsubscribe')).toBeGreaterThan(out.html!.indexOf('attempted footer strip'));
    expect(out.html!.startsWith(html)).toBe(true);
  });

  it('handles single-format messages', () => {
    const htmlOnly = appendCompliantFooter({ html: '<p>x</p>', text: null, physicalAddress: ADDRESS, unsubUrl: URL });
    expect(htmlOnly.html).toContain('Unsubscribe');
    expect(htmlOnly.text).toBeNull();
    const textOnly = appendCompliantFooter({ html: null, text: 'x', physicalAddress: ADDRESS, unsubUrl: URL });
    expect(textOnly.text).toContain('Unsubscribe: ');
    expect(textOnly.html).toBeNull();
  });

  it('escapes a hostile physical address — no markup or link injection', () => {
    const hostile = '<script>alert(1)</script><a href="https://phish.example/unsub">fake</a>';
    const out = appendCompliantFooter({ html: '<p>x</p>', text: 'x', physicalAddress: hostile, unsubUrl: URL });
    expect(out.html).not.toContain('<script>');
    expect(out.html).not.toContain('href="https://phish.example/unsub"');
    expect(out.html).toContain('&lt;script&gt;');
    // The only anchor in the footer is the platform unsubscribe URL.
    const footer = out.html!.slice(out.html!.lastIndexOf('<div'));
    expect(footer.match(/href="/g)).toHaveLength(1);
    expect(footer).toContain(`href="${URL}"`);
  });

  it('escapes hostile characters in the unsubscribe URL attribute', () => {
    const out = appendCompliantFooter({
      html: '<p>x</p>', text: 'x', physicalAddress: ADDRESS,
      unsubUrl: 'https://t.example/u/x"onmouseover="alert(1)',
    });
    expect(out.html).toContain('&quot;onmouseover=&quot;');
    expect(out.html).not.toContain('"onmouseover="alert(1)"');
  });

  it('escapeFooterHtml covers the five HTML metacharacters', () => {
    expect(escapeFooterHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});
