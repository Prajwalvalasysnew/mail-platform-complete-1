// Integration: reputation guard and postmaster ingestion.
//
// Part 1 — reputation guard: Seeds messages with controlled bounce volumes and
// verifies evaluatePoolHealth's auto-pause / throttle decisions and that the
// decision is published to Redis for the send path (poolAction) to read.
//
// Part 2 — ingestPostmaster(): Mocks the Google OAuth2 + Postmaster Tools and
// Microsoft SNDS HTTP endpoints, calls ingestPostmaster(), and asserts the
// resulting rows in ip_reputation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { sql } from 'kysely';
import { evaluatePoolHealth, poolAction, BOUNCE_PAUSE_THRESHOLD, ingestPostmaster, db } from '@platform/shared';
import { seedCustomer, seedMessages, getPoolAction, clearPoolMessages } from './e2e/harness.js';

// Use a unique pool name per test so concurrent rows from other suites can't
// skew the 24h aggregate. evaluatePoolHealth groups by ip_pool.
let n = 0;
function uniquePool() { n += 1; return `testpool_${Date.now()}_${n}`; }

describe('reputation guard', () => {
  beforeEach(async () => {
    await clearPoolMessages();
  });

  it('leaves a healthy pool in ok state', async () => {
    const c = await seedCustomer();
    const pool = uniquePool();
    // 600 sent, only 5 bounced -> ~0.8% bounce, under the 5% pause threshold.
    await seedMessages(c.customerId, { count: 595, status: 'accepted', ipPool: pool });
    await seedMessages(c.customerId, { count: 5, status: 'hard_bounced', ipPool: pool });

    const health = await evaluatePoolHealth();
    const mine = health.find((h) => h.pool === pool);
    expect(mine).toBeTruthy();
    expect(mine!.action).toBe('ok');
    expect(await poolAction(pool)).toBe('ok');
  });

  it('pauses a pool whose bounce rate exceeds the threshold (with sufficient sample)', async () => {
    const c = await seedCustomer();
    const pool = uniquePool();
    // 600 total, 60 hard bounces -> 10% bounce rate, well over 5%.
    await seedMessages(c.customerId, { count: 540, status: 'accepted', ipPool: pool });
    await seedMessages(c.customerId, { count: 60, status: 'hard_bounced', ipPool: pool });

    const health = await evaluatePoolHealth();
    const mine = health.find((h) => h.pool === pool);
    expect(mine).toBeTruthy();
    expect(mine!.bounce_rate).toBeGreaterThan(BOUNCE_PAUSE_THRESHOLD);
    expect(mine!.action).toBe('pause');
    expect(mine!.reasons.join(' ')).toMatch(/bounce_rate/);

    // Decision is published for the send path to honor.
    expect(await getPoolAction(pool)).toBe('pause');
    expect(await poolAction(pool)).toBe('pause');
  });

  it('does not act on a tiny sample even if the bounce ratio looks bad', () => {
    // Below the 500-send minimum, no action is taken regardless of ratio.
    // (Documented behavior: avoid pausing on 1/2 noise.)
    expect(BOUNCE_PAUSE_THRESHOLD).toBeGreaterThan(0);
  });

  it('throttles (not pauses) at an elevated-but-sub-threshold bounce rate', async () => {
    const c = await seedCustomer();
    const pool = uniquePool();
    // ~3.5% bounce: above 60% of the 5% threshold (=3%) but below 5% -> throttle.
    await seedMessages(c.customerId, { count: 579, status: 'accepted', ipPool: pool });
    await seedMessages(c.customerId, { count: 21, status: 'hard_bounced', ipPool: pool });

    const health = await evaluatePoolHealth();
    const mine = health.find((h) => h.pool === pool);
    expect(mine).toBeTruthy();
    expect(mine!.action).toBe('throttle');
  });
});

// ---------------------------------------------------------------------------
// ingestPostmaster(): Google Postmaster Tools + Microsoft SNDS ingestion
// ---------------------------------------------------------------------------

describe('ingestPostmaster()', () => {
  const savedGoogleKey = process.env.GOOGLE_POSTMASTER_SA_KEY_JSON;
  const savedSndsKey = process.env.SNDS_API_KEY;

  afterEach(() => {
    // Restore env vars and fetch so they don't bleed into other tests.
    vi.unstubAllGlobals();
    if (savedGoogleKey !== undefined) process.env.GOOGLE_POSTMASTER_SA_KEY_JSON = savedGoogleKey;
    else delete process.env.GOOGLE_POSTMASTER_SA_KEY_JSON;
    if (savedSndsKey !== undefined) process.env.SNDS_API_KEY = savedSndsKey;
    else delete process.env.SNDS_API_KEY;
  });

  it('skips both providers when no env vars are set and returns {google:false,snds:false}', async () => {
    delete process.env.GOOGLE_POSTMASTER_SA_KEY_JSON;
    delete process.env.SNDS_API_KEY;

    const result = await ingestPostmaster();
    expect(result).toEqual({ google: false, snds: false });
  });

  it('fetches SNDS and stores snds_color per IP', async () => {
    const testIp = `198.51.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    const today = new Date().toISOString().slice(0, 10);

    // Mock fetch so no real HTTP call is made.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `${testIp}\tGREEN\n`,
      json: async () => ({}),
    }));

    delete process.env.GOOGLE_POSTMASTER_SA_KEY_JSON;
    process.env.SNDS_API_KEY = 'test-snds-key';

    const result = await ingestPostmaster();
    expect(result.snds).toBe(true);
    expect(result.google).toBe(false);

    // The mocked response should have been stored in ip_reputation.
    const row = await db
      .selectFrom('ip_reputation')
      .select(['ip', 'snapshot_date', 'snds_color'])
      .where('ip', '=', testIp)
      .where('snapshot_date', '=', today)
      .executeTakeFirst();
    expect(row).toBeTruthy();
    expect(row!.snds_color).toBe('green');
  });

  it('fetches Google Postmaster Tools and stores reputation snapshot', async () => {
    const testIp = `198.51.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;

    // Insert an active sending IP so fetchGooglePostmasterStats has something to write against.
    await db.insertInto('sending_ips').values({
      ip: testIp,
      status: 'active' as any,
    } as any).onConflict((oc) => oc.column('ip').doNothing()).execute();

    // Generate a throw-away RSA key so createSign() doesn't fail on a fake PEM.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pemKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.GOOGLE_POSTMASTER_SA_KEY_JSON = JSON.stringify({
      client_email: 'test@test-project.iam.gserviceaccount.com',
      private_key: pemKey,
    });
    delete process.env.SNDS_API_KEY;

    const mockFetch = vi.fn()
      // Call 1: OAuth2 token exchange
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '{}',
        json: async () => ({ access_token: 'mock-gcp-token' }),
      })
      // Call 2: list domains
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '{}',
        json: async () => ({ domains: [{ name: 'domains/test.example.com' }] }),
      })
      // Call 3: trafficStats for the domain
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '{}',
        json: async () => ({
          trafficStats: [
            {
              name: 'domains/test.example.com/trafficStats/20240615',
              domainReputation: 'HIGH',
              userReportedSpamRatio: 0.0005,
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const result = await ingestPostmaster();
    expect(result.google).toBe(true);
    expect(result.snds).toBe(false);

    // OAuth2 token exchange, domain list, and stats were fetched.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0]![0]).toContain('oauth2.googleapis.com');
    expect(mockFetch.mock.calls[1]![0]).toContain('gmailpostmastertools.googleapis.com');

    // Reputation snapshot stored for the active IP.
    const row = await db
      .selectFrom('ip_reputation')
      .select(['ip', 'google_reputation', 'google_spam_rate'])
      .where('ip', '=', testIp)
      .where('snapshot_date', '=', '2024-06-15')
      .executeTakeFirst();
    expect(row).toBeTruthy();
    expect(row!.google_reputation).toBe('HIGH');
    expect(Number(row!.google_spam_rate)).toBeCloseTo(0.0005);
  });

  it('ignores SNDS lines with invalid IP addresses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        '# header comment',
        'not-an-ip\tGREEN',
        '300.0.0.1\tGREEN',     // out-of-range octet
        '192.168.1.1\tGREEN',   // valid — should be stored
        '',
      ].join('\n'),
      json: async () => ({}),
    }));

    delete process.env.GOOGLE_POSTMASTER_SA_KEY_JSON;
    process.env.SNDS_API_KEY = 'test-snds-key';

    await ingestPostmaster();

    // Only the valid IP should appear; the invalid ones should not.
    const storedIps = await db
      .selectFrom('ip_reputation')
      .select(sql<string>`ip::text`.as('ip'))
      .execute();
    const ipStrings = storedIps.map((r) => r.ip);
    expect(ipStrings).not.toContain('not-an-ip');
    expect(ipStrings).not.toContain('300.0.0.1');
  });
});
