import { describe, it, expect } from 'vitest';
import { scanContent } from '@platform/shared';

describe('content scanning', () => {
  it('allows clean transactional mail', () => {
    const r = scanContent('Your receipt', '<p>Thanks for your order #1234.</p>');
    expect(r.action).toBe('allow');
    expect(r.score).toBeLessThan(30);
  });

  it('blocks obvious pharma spam', () => {
    const r = scanContent('Cheap Viagra', '<p>Buy viagra and cialis from our pharmacy now</p>');
    expect(r.action).toBe('block');
    expect(r.reasons).toContain('pharma_spam');
  });

  it('flags advance-fee scams', () => {
    const r = scanContent('Urgent', '<p>I am a Nigerian prince needing your help</p>');
    expect(r.score).toBeGreaterThanOrEqual(50);
    expect(r.action).toBe('block');
  });

  it('flags lottery scams', () => {
    const r = scanContent("You've won!", '<p>You have won the lottery prize of one million dollars</p>');
    expect(r.reasons).toContain('lottery_scam');
  });

  it('detects excessive links', () => {
    const links = Array.from({ length: 40 }, (_, i) => `<a href="http://x${i}.com">x</a>`).join('');
    const r = scanContent('Newsletter', `<div>${links}</div>`);
    expect(r.reasons).toContain('excessive_links');
  });

  it('reviews borderline content rather than blocking', () => {
    const r = scanContent('Investment', '<p>Guaranteed income opportunity</p>');
    expect(['review', 'allow']).toContain(r.action);
  });
});
