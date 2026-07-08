import { describe, expect, it } from 'vitest';
import { spamProbability, extractDomains } from '@platform/shared';

describe('spamProbability', () => {
  it('flags obvious spam high', () => {
    const p = spamProbability(
      'Congratulations you won a FREE prize! Click here to claim your guaranteed bitcoin returns now! Limited offer!'
    );
    expect(p).toBeGreaterThan(0.6);
  });

  it('flags transactional ham low', () => {
    const p = spamProbability('Your receipt for order number 12345 is attached. Thanks for your purchase.');
    expect(p).toBeLessThan(0.4);
  });

  it('returns 0 for empty input rather than blowing up', () => {
    expect(spamProbability('')).toBe(0);
  });

  it('does not crash on unicode / emoji', () => {
    const p = spamProbability('🎉 your order has shipped 📦 tracking link inside');
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });
});

describe('extractDomains', () => {
  it('extracts domains from HTML links', () => {
    const domains = extractDomains('<a href="https://shady.example.com/x">click</a><a href="http://good.example/y">y</a>');
    expect(domains).toContain('shady.example.com');
    expect(domains).toContain('good.example');
  });

  it('strips www and dedupes', () => {
    const domains = extractDomains('<a href="https://www.foo.com">1</a><a href="https://foo.com">2</a>');
    expect(domains).toEqual(['foo.com']);
  });

  it('finds bare URLs in text too', () => {
    const domains = extractDomains(undefined, 'Click http://plain.example/path for details');
    expect(domains).toContain('plain.example');
  });
});
