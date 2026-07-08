// End-to-end: open/click bot detection through the real event worker.
//
// Enqueues 'opened'/'clicked' events exactly as the tracker does (with a
// pre-computed verdict), runs the real event worker, and asserts that:
//   - the verdict is persisted on the event row,
//   - human events set human_opened_at / human_clicked_at,
//   - machine events (Apple MPP, scanners, prefetch) set machine_opened_at and
//     are excluded from human engagement timestamps.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import {
  eventsQueue,
  classifyEngagement,
} from '@platform/shared';
import {
  seedCustomer,
  seedDeliveredMessage,
  getEngagement,
  getLatestEvent,
} from './e2e/harness.js';

const require = createRequire(import.meta.url);
const { startEventWorker } = require('@platform/worker/event-worker.js');

const silent: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } };
let worker: any;

beforeAll(async () => {
  worker = startEventWorker(silent);
  await worker.waitUntilReady();
});
afterAll(async () => {
  await worker.close();
});

// Poll until a predicate on the message engagement row holds (the worker is async).
async function waitFor(messageId: string, pred: (e: any) => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const e = await getEngagement(messageId);
    if (e && pred(e)) return e;
    await new Promise((r) => setTimeout(r, 100));
  }
  return await getEngagement(messageId);
}

async function enqueueOpen(messageId: string, opts: { ua: string; ip: string; msSinceDelivery?: number }) {
  const verdict = classifyEngagement({
    eventType: 'opened',
    userAgent: opts.ua,
    ip: opts.ip,
    msSinceDelivery: opts.msSinceDelivery ?? 600000,
  });
  await eventsQueue.add('opened', {
    message_id: messageId,
    event_type: 'opened',
    ip: opts.ip,
    user_agent: opts.ua,
    occurred_at: new Date().toISOString(),
    bot_verdict: verdict.verdict,
    bot_score: verdict.botScore,
    bot_reasons: verdict.reasons,
  });
  return verdict;
}

describe('E2E bot detection — opens', () => {
  it('records a human open and sets human_opened_at', async () => {
    const c = await seedCustomer();
    const mid = await seedDeliveredMessage(c.customerId);
    await enqueueOpen(mid, {
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      ip: '73.55.12.9',
      msSinceDelivery: 600000,
    });
    const e = await waitFor(mid, (e) => !!e.human_opened_at);
    expect(e!.human_opened_at).toBeTruthy();
    expect(e!.machine_opened_at).toBeFalsy();

    const ev = await getLatestEvent(mid, 'opened');
    expect(ev.bot_verdict).toBe('human');
  });

  it('filters an Apple MPP relay open: machine_opened_at set, human_opened_at not', async () => {
    const c = await seedCustomer();
    const mid = await seedDeliveredMessage(c.customerId);
    await enqueueOpen(mid, {
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      ip: '17.58.22.9', // Apple range
    });
    const e = await waitFor(mid, (e) => !!e.machine_opened_at);
    expect(e!.machine_opened_at).toBeTruthy();
    expect(e!.human_opened_at).toBeFalsy();

    const ev = await getLatestEvent(mid, 'opened');
    expect(ev.bot_verdict).toBe('bot');
    expect(Number(ev.bot_score)).toBeGreaterThanOrEqual(0.85);
  });

  it('filters a Gmail image-proxy open as a bot', async () => {
    const c = await seedCustomer();
    const mid = await seedDeliveredMessage(c.customerId);
    await enqueueOpen(mid, { ua: 'Mozilla/5.0 (compatible; GoogleImageProxy)', ip: '66.249.84.10' });
    const e = await waitFor(mid, (e) => !!e.machine_opened_at);
    expect(e!.machine_opened_at).toBeTruthy();
    expect(e!.human_opened_at).toBeFalsy();
  });

  it('filters a sub-2s prefetch open even with a clean UA', async () => {
    const c = await seedCustomer();
    const mid = await seedDeliveredMessage(c.customerId, 1000); // delivered 1s ago
    await enqueueOpen(mid, {
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36',
      ip: '73.55.12.9',
      msSinceDelivery: 900,
    });
    const e = await waitFor(mid, (e) => !!e.machine_opened_at);
    expect(e!.machine_opened_at).toBeTruthy();
    expect(e!.human_opened_at).toBeFalsy();
  });
});

describe('E2E bot detection — clicks', () => {
  it('records a human click after a human open', async () => {
    const c = await seedCustomer();
    const mid = await seedDeliveredMessage(c.customerId);
    // First a human open.
    await enqueueOpen(mid, {
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Mobile/15E148',
      ip: '73.55.12.9',
    });
    await waitFor(mid, (e) => !!e.human_opened_at);

    const v = classifyEngagement({
      eventType: 'clicked',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Mobile/15E148',
      ip: '73.55.12.9',
      hadPriorHumanOpen: true,
      msSinceDelivery: 120000,
    });
    await eventsQueue.add('clicked', {
      message_id: mid, event_type: 'clicked', ip: '73.55.12.9',
      user_agent: 'iPhone', occurred_at: new Date().toISOString(),
      bot_verdict: v.verdict, bot_score: v.botScore, bot_reasons: v.reasons,
      payload: { url: 'https://example.com' },
    });
    const e = await waitFor(mid, (e) => !!e.human_clicked_at);
    expect(e!.human_clicked_at).toBeTruthy();
    expect(v.verdict).toBe('human');
  });

  it('does not set human_clicked_at for a scanner click', async () => {
    const c = await seedCustomer();
    const mid = await seedDeliveredMessage(c.customerId);
    const v = classifyEngagement({
      eventType: 'clicked',
      userAgent: 'urldefense-proofpoint',
      ip: '67.231.150.1',
      hadPriorHumanOpen: false,
    });
    await eventsQueue.add('clicked', {
      message_id: mid, event_type: 'clicked', ip: '67.231.150.1',
      user_agent: 'urldefense-proofpoint', occurred_at: new Date().toISOString(),
      bot_verdict: v.verdict, bot_score: v.botScore, bot_reasons: v.reasons,
      payload: { url: 'https://example.com' },
    });
    const e = await waitFor(mid, (e) => !!e.first_clicked_at);
    expect(e!.first_clicked_at).toBeTruthy();   // raw click still recorded
    expect(e!.human_clicked_at).toBeFalsy();    // but not counted as human
    expect(v.verdict).toBe('bot');
  });

  it('first_clicked_at captures the FIRST click and is not advanced by later clicks', async () => {
    const c = await seedCustomer();
    const mid = await seedDeliveredMessage(c.customerId);
    const mkClick = () => {
      const v = classifyEngagement({
        eventType: 'clicked',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Mobile/15E148',
        ip: '73.55.12.9',
        hadPriorHumanOpen: true,
        msSinceDelivery: 120000,
      });
      return eventsQueue.add('clicked', {
        message_id: mid, event_type: 'clicked', ip: '73.55.12.9',
        user_agent: 'iPhone', occurred_at: new Date().toISOString(),
        bot_verdict: v.verdict, bot_score: v.botScore, bot_reasons: v.reasons,
        payload: { url: 'https://example.com' },
      });
    };

    await mkClick();
    const first = await waitFor(mid, (e) => !!e.first_clicked_at);
    const firstTs = new Date(first!.first_clicked_at).getTime();
    expect(firstTs).toBeGreaterThan(0);

    // A second click arrives later. first_clicked_at must NOT move forward.
    await new Promise((r) => setTimeout(r, 1100));
    await mkClick();
    // Give the worker time to process the second event.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await getEngagement(mid);
    const afterTs = new Date(after!.first_clicked_at).getTime();
    expect(afterTs).toBe(firstTs); // unchanged — it's the FIRST click
  });
});
