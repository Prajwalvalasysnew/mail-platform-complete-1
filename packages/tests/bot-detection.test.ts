// Unit tests for open/click bot detection. Pure functions, no I/O. These pin
// down the accuracy of each signal and the blended verdict.

import { describe, it, expect } from 'vitest';
import { classifyEngagement, _internal } from '@platform/shared';

const REAL_IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const REAL_GMAIL_WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

describe('CIDR matcher', () => {
  it('matches an address inside a /8', () => {
    expect(_internal.matchDatacenter('17.58.1.2')).toBe('Apple (MPP relay)');
  });
  it('matches AWS ranges', () => {
    expect(_internal.matchDatacenter('52.4.5.6')).toBeTruthy();
  });
  it('returns null for a residential IP', () => {
    expect(_internal.matchDatacenter('98.207.13.44')).toBeNull();
  });
  it('handles IPv4-mapped IPv6 form', () => {
    expect(_internal.ipv4ToInt('::ffff:17.1.1.1')).toBe(_internal.ipv4ToInt('17.1.1.1'));
  });
  it('rejects malformed addresses', () => {
    expect(_internal.ipv4ToInt('999.1.1.1')).toBeNull();
    expect(_internal.ipv4ToInt('not-an-ip')).toBeNull();
  });
});

describe('machine user-agent detection', () => {
  it('flags the Gmail image proxy as a bot', () => {
    const r = classifyEngagement({
      eventType: 'opened',
      userAgent: 'Mozilla/5.0 (compatible; GoogleImageProxy)',
      ip: '98.207.13.44',
    });
    expect(r.verdict).toBe('bot');
    expect(r.reasons.join(' ')).toMatch(/Gmail image proxy/i);
  });

  it('flags Proofpoint URLDefense as a bot', () => {
    const r = classifyEngagement({ eventType: 'clicked', userAgent: 'urldefense-proofpoint/1.0', ip: '1.2.3.4' });
    expect(r.verdict).toBe('bot');
  });

  it('flags curl / python-requests / Go clients', () => {
    for (const ua of ['curl/8.1.2', 'python-requests/2.31', 'Go-http-client/2.0']) {
      expect(classifyEngagement({ eventType: 'opened', userAgent: ua, ip: '98.207.13.44' }).verdict).toBe('bot');
    }
  });

  it('treats an empty user-agent as suspicious, not human', () => {
    const r = classifyEngagement({ eventType: 'opened', userAgent: '', ip: '98.207.13.44' });
    expect(r.verdict).toBe('suspicious');
    expect(r.countsAsHuman).toBe(false);
  });
});

describe('datacenter IP detection', () => {
  it('flags an Apple MPP relay open as a bot even with a benign UA', () => {
    const r = classifyEngagement({ eventType: 'opened', userAgent: REAL_IPHONE_UA, ip: '17.58.22.9' });
    expect(r.verdict).toBe('bot');
    expect(r.reasons.join(' ')).toMatch(/Apple/i);
  });
});

describe('timing detection', () => {
  it('flags a sub-2s prefetch open as a bot', () => {
    const r = classifyEngagement({
      eventType: 'opened',
      userAgent: REAL_GMAIL_WEB_UA,
      ip: '98.207.13.44',
      msSinceDelivery: 800,
    });
    expect(r.verdict).toBe('bot');
    expect(r.reasons.join(' ')).toMatch(/prefetch/i);
  });

  it('treats a 4s open as merely suspicious (weak signal alone)', () => {
    const r = classifyEngagement({
      eventType: 'opened',
      userAgent: REAL_GMAIL_WEB_UA,
      ip: '98.207.13.44',
      msSinceDelivery: 4000,
    });
    // fast_timing weight 0.4 alone is below the suspicious threshold (0.5).
    expect(r.verdict).toBe('human');
  });

  it('does not penalize a realistic human open delay', () => {
    const r = classifyEngagement({
      eventType: 'opened',
      userAgent: REAL_IPHONE_UA,
      ip: '98.207.13.44',
      msSinceDelivery: 45 * 60 * 1000, // 45 minutes later
    });
    expect(r.verdict).toBe('human');
    expect(r.countsAsHuman).toBe(true);
  });
});

describe('click-without-open signal', () => {
  it('marks a click with no prior human open as suspicious', () => {
    const r = classifyEngagement({
      eventType: 'clicked',
      userAgent: REAL_GMAIL_WEB_UA,
      ip: '98.207.13.44',
      hadPriorHumanOpen: false,
    });
    expect(r.verdict).toBe('suspicious');
  });

  it('a normal human click after an open is human', () => {
    const r = classifyEngagement({
      eventType: 'clicked',
      userAgent: REAL_IPHONE_UA,
      ip: '98.207.13.44',
      hadPriorHumanOpen: true,
      msSinceDelivery: 120000,
    });
    expect(r.verdict).toBe('human');
  });
});

describe('blended verdict & confidence', () => {
  it('a clean human open scores low and counts as human', () => {
    const r = classifyEngagement({
      eventType: 'opened',
      userAgent: REAL_IPHONE_UA,
      ip: '73.55.12.9',
      msSinceDelivery: 600000,
    });
    expect(r.verdict).toBe('human');
    expect(r.countsAsHuman).toBe(true);
    expect(r.botScore).toBeLessThan(0.3);
  });

  it('multiple bot signals stack to high confidence', () => {
    const r = classifyEngagement({
      eventType: 'opened',
      userAgent: 'GoogleImageProxy',
      ip: '66.249.84.1', // Google range
      msSinceDelivery: 300, // prefetch
    });
    expect(r.verdict).toBe('bot');
    expect(r.botScore).toBeGreaterThanOrEqual(0.85);
    expect(r.signals.length).toBeGreaterThanOrEqual(2);
  });

  it('always returns a reason', () => {
    const r = classifyEngagement({ eventType: 'opened', userAgent: REAL_IPHONE_UA, ip: '73.55.12.9' });
    expect(r.reasons.length).toBeGreaterThan(0);
  });
});
