// Unit tests for the SSRF guard that protects outbound webhook delivery.
// These verify that private / reserved / loopback targets are rejected and
// that legitimately public URLs pass the static checks.

import { describe, it, expect } from 'vitest';
import {
  assertPublicHttpUrl,
  resolveAndAssertPublicUrl,
  isPrivateAddress,
  SsrfError,
} from '@platform/shared';

// Ensure the dev escape hatch is OFF for these tests regardless of ambient env.
delete process.env.WEBHOOK_ALLOW_PRIVATE;

describe('isPrivateAddress', () => {
  it('flags IPv4 loopback, private, link-local, and CGNAT ranges', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('172.31.255.255')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true); // cloud metadata
    expect(isPrivateAddress('100.64.0.1')).toBe(true); // CGNAT
    expect(isPrivateAddress('0.0.0.0')).toBe(true);
  });

  it('allows ordinary public IPv4 addresses', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('1.1.1.1')).toBe(false);
    expect(isPrivateAddress('93.184.216.34')).toBe(false); // example.com
    expect(isPrivateAddress('172.32.0.1')).toBe(false); // just outside 172.16/12
  });

  it('flags IPv6 loopback, link-local, ULA, and mapped private v4', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
  });

  it('allows public IPv6', () => {
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false); // cloudflare
  });

  it('treats non-IP garbage as unsafe', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });
});

describe('assertPublicHttpUrl (static shape checks)', () => {
  it('rejects non-http schemes', () => {
    expect(() => assertPublicHttpUrl('ftp://example.com')).toThrow(SsrfError);
    expect(() => assertPublicHttpUrl('file:///etc/passwd')).toThrow(SsrfError);
    expect(() => assertPublicHttpUrl('gopher://example.com')).toThrow(SsrfError);
  });

  it('rejects credentials embedded in the URL', () => {
    expect(() => assertPublicHttpUrl('http://user:pass@example.com')).toThrow(SsrfError);
  });

  it('rejects localhost', () => {
    expect(() => assertPublicHttpUrl('http://localhost/hook')).toThrow(SsrfError);
    expect(() => assertPublicHttpUrl('http://api.localhost/hook')).toThrow(SsrfError);
  });

  it('rejects literal private/reserved IP hosts', () => {
    expect(() => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/')).toThrow(SsrfError);
    expect(() => assertPublicHttpUrl('http://10.0.0.5/hook')).toThrow(SsrfError);
    expect(() => assertPublicHttpUrl('http://127.0.0.1:8080/hook')).toThrow(SsrfError);
    expect(() => assertPublicHttpUrl('http://[::1]/hook')).toThrow(SsrfError);
  });

  it('accepts a well-formed public https URL', () => {
    const url = assertPublicHttpUrl('https://hooks.example.com/inbound');
    expect(url.hostname).toBe('hooks.example.com');
  });

  it('rejects malformed URLs', () => {
    expect(() => assertPublicHttpUrl('not a url')).toThrow(SsrfError);
  });
});

describe('resolveAndAssertPublicUrl (delivery-time DNS check)', () => {
  it('rejects a literal private IP without needing DNS', async () => {
    await expect(resolveAndAssertPublicUrl('http://169.254.169.254/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('returns the literal IP for a public IP host', async () => {
    const { addresses } = await resolveAndAssertPublicUrl('https://8.8.8.8/hook');
    expect(addresses).toContain('8.8.8.8');
  });

  it('rejects a host that fails to resolve', async () => {
    await expect(
      resolveAndAssertPublicUrl('https://this-domain-should-not-resolve-mp-test.invalid/hook')
    ).rejects.toBeInstanceOf(SsrfError);
  });
});
