// Unit tests for the webhook delivery retry classification. A 4xx (except
// 408/429) is a permanent client error and must NOT be retried; 408/429 and all
// 5xx are transient and should be retried.

import { describe, expect, it } from 'vitest';
import { isRetryableStatus } from '@platform/worker/webhook-worker.js';

describe('isRetryableStatus', () => {
  it('does not retry permanent 4xx client errors', () => {
    for (const s of [400, 401, 403, 404, 410, 422]) {
      expect(isRetryableStatus(s)).toBe(false);
    }
  });

  it('retries 408 (timeout) and 429 (rate limited)', () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
  });

  it('retries all 5xx server errors', () => {
    for (const s of [500, 502, 503, 504]) {
      expect(isRetryableStatus(s)).toBe(true);
    }
  });

  it('treats 2xx/3xx as non-retryable (handled separately as success/drop)', () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(301)).toBe(false);
  });
});
