// SSRF protection for outbound requests to customer-supplied URLs (webhooks).
//
// Customers register a webhook URL that the worker later POSTs to. Without
// validation, a customer could point that URL at the cloud metadata endpoint
// (169.254.169.254), localhost, or any internal/RFC1918 address and use the
// platform as a confused deputy to reach the internal network or exfiltrate
// instance credentials.
//
// We defend in two places:
//   1. Registration time (assertPublicHttpUrl) — fast feedback, rejects the
//      obvious cases (bad scheme, literal private IP, localhost).
//   2. Delivery time (resolveAndAssertPublicUrl) — authoritative, resolves the
//      hostname to its IPs and rejects if ANY resolved address is private. This
//      is what actually closes the hole, because DNS can change between
//      registration and delivery (DNS-rebinding) and only the resolved address
//      matters.
//
// An allowlist escape hatch (WEBHOOK_ALLOW_PRIVATE=1) exists strictly for local
// development / tests, never for production.

import { promises as dns } from 'node:dns';
import net from 'node:net';

const ALLOW_PRIVATE = process.env.WEBHOOK_ALLOW_PRIVATE === '1';

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** Parse an IPv4 dotted-quad into its 32-bit unsigned integer, or null. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255 || !/^\d+$/.test(p)) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/** True if an IPv4 address is in a private / reserved / non-routable range. */
function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → treat as unsafe
  const inRange = (cidrBase: string, bits: number) => {
    const base = ipv4ToInt(cidrBase)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (base & mask);
  };
  return (
    inRange('0.0.0.0', 8) ||        // "this" network
    inRange('10.0.0.0', 8) ||       // private
    inRange('100.64.0.0', 10) ||    // CGNAT
    inRange('127.0.0.0', 8) ||      // loopback
    inRange('169.254.0.0', 16) ||   // link-local (incl. cloud metadata)
    inRange('172.16.0.0', 12) ||    // private
    inRange('192.0.0.0', 24) ||     // IETF protocol assignments
    inRange('192.0.2.0', 24) ||     // TEST-NET-1
    inRange('192.168.0.0', 16) ||   // private
    inRange('198.18.0.0', 15) ||    // benchmarking
    inRange('198.51.100.0', 24) ||  // TEST-NET-2
    inRange('203.0.113.0', 24) ||   // TEST-NET-3
    inRange('224.0.0.0', 4) ||      // multicast
    inRange('240.0.0.0', 4)         // reserved / broadcast
  );
}

/** True if an IPv6 address is loopback, link-local, ULA, or an unsafe mapped form. */
function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0]!; // strip zone id; split always yields ≥1 element
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — validate the embedded v4.
  const mapped = lower.match(/(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return isPrivateIpv4(ip);
  if (fam === 6) return isPrivateIpv6(ip);
  return true; // not a recognizable IP → unsafe
}

/**
 * Validate the static shape of a webhook URL. Throws SsrfError on a disallowed
 * scheme, a credentials-in-URL, a non-standard structure, or a literal private
 * IP host. Does NOT resolve DNS — call resolveAndAssertPublicUrl for that.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('Webhook URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`Webhook URL scheme '${url.protocol}' is not allowed (use http/https)`);
  }
  if (url.username || url.password) {
    throw new SsrfError('Webhook URL must not contain credentials');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '' ) {
    if (!ALLOW_PRIVATE) throw new SsrfError('Webhook URL must not target localhost');
  }
  // If the host is a literal IP, validate it now.
  const bracketless = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (net.isIP(bracketless) && !ALLOW_PRIVATE && isPrivateAddress(bracketless)) {
    throw new SsrfError('Webhook URL must not target a private or reserved IP address');
  }
  return url;
}

/**
 * Authoritative delivery-time check. Validates the URL shape, then resolves the
 * hostname and asserts that EVERY resolved address is publicly routable.
 * Returns the resolved addresses (so a caller could pin them when connecting).
 */
export async function resolveAndAssertPublicUrl(raw: string): Promise<{ url: URL; addresses: string[] }> {
  const url = assertPublicHttpUrl(raw);
  if (ALLOW_PRIVATE) return { url, addresses: [] };

  const host = url.hostname.toLowerCase();
  const bracketless = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  // Literal IP already validated by assertPublicHttpUrl.
  if (net.isIP(bracketless)) return { url, addresses: [bracketless] };

  let resolved: string[];
  try {
    const records = await dns.lookup(bracketless, { all: true });
    resolved = records.map((r) => r.address);
  } catch (err: any) {
    throw new SsrfError(`Webhook host could not be resolved: ${err?.code ?? 'lookup_failed'}`);
  }
  if (resolved.length === 0) {
    throw new SsrfError('Webhook host did not resolve to any address');
  }
  for (const addr of resolved) {
    if (isPrivateAddress(addr)) {
      throw new SsrfError(`Webhook host resolves to a private/reserved address (${addr})`);
    }
  }
  return { url, addresses: resolved };
}
