// Regression: webhook delivery must pin its connection to the IP that passed the
// SSRF check, closing the DNS-rebinding TOCTOU window. We can't easily simulate
// a rebinding DNS server in-process, but we can prove the *mechanism*: the
// pinned dispatcher forces undici to connect to the supplied IP regardless of
// the hostname in the URL. So a request to http://evil.test/ pinned to 127.0.0.1
// actually reaches our loopback server — demonstrating the socket follows the
// vetted address, not a fresh (potentially rebound) DNS lookup.

import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import { request } from 'undici';
import { ipPinnedDispatcher } from '@platform/worker/webhook-worker.js';

const servers: http.Server[] = [];
afterAll(() => { for (const s of servers) s.close(); });

function startServer(handler: http.RequestListener): Promise<{ port: number }> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    servers.push(srv);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({ port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}

describe('webhook IP pinning (DNS-rebind defense)', () => {
  it('returns undefined when there are no validated addresses', () => {
    expect(ipPinnedDispatcher([])).toBeUndefined();
    expect(ipPinnedDispatcher(undefined as any)).toBeUndefined();
  });

  it('forces the connection to the pinned IP regardless of the URL hostname', async () => {
    let hostHeaderSeen: string | undefined;
    const { port } = await startServer((req, res) => {
      hostHeaderSeen = req.headers.host;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });

    // URL hostname is a name that does NOT resolve to our server (and may not
    // resolve at all). Pinning to 127.0.0.1 must still land on the loopback
    // server above — proving the socket follows the vetted IP, not DNS.
    const dispatcher = ipPinnedDispatcher(['127.0.0.1']);
    expect(dispatcher).toBeDefined();
    try {
      const res = await request(`http://evil-rebind-target.test:${port}/hook`, {
        method: 'POST',
        dispatcher,
        headers: { 'content-type': 'application/json' },
        body: '{}',
        maxRedirections: 0,
        headersTimeout: 4000,
        bodyTimeout: 4000,
      });
      const text = await res.body.text();
      expect(res.statusCode).toBe(200);
      expect(text).toBe('ok');
      // The Host header still carries the original hostname (so vhosts / SNI work),
      // even though the socket connected to the pinned IP.
      expect(hostHeaderSeen).toContain('evil-rebind-target.test');
    } finally {
      await dispatcher!.close().catch(() => {});
    }
  });
});
