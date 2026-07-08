import { describe, expect, it } from 'vitest';
import { normalizeMessageActivityQuery } from '@platform/shared';

describe('normalizeMessageActivityQuery', () => {
  it('applies safe defaults', () => {
    expect(normalizeMessageActivityQuery({})).toEqual({
      eventType: undefined,
      messageId: undefined,
      to: undefined,
      from: undefined,
      tag: undefined,
      status: undefined,
      sinceDays: 30,
      limit: 50,
      before: undefined,
    });
  });

  it('accepts known event types only', () => {
    expect(normalizeMessageActivityQuery({ event_type: 'delivered' }).eventType).toBe('delivered');
    expect(normalizeMessageActivityQuery({ event_type: 'admin:internal' }).eventType).toBeUndefined();
    expect(normalizeMessageActivityQuery({ event_type: 'nope' }).eventType).toBeUndefined();
  });

  it('clamps days and limit', () => {
    expect(normalizeMessageActivityQuery({ days: 999, limit: 999 }).sinceDays).toBe(365);
    expect(normalizeMessageActivityQuery({ days: 999, limit: 999 }).limit).toBe(200);
    expect(normalizeMessageActivityQuery({ days: -1, limit: 0 }).sinceDays).toBe(30);
    expect(normalizeMessageActivityQuery({ days: -1, limit: 0 }).limit).toBe(50);
  });

  it('trims string filters and enforces max lengths', () => {
    expect(normalizeMessageActivityQuery({ to: '  user@example.com  ' }).to).toBe('user@example.com');
    expect(normalizeMessageActivityQuery({ tag: 'x'.repeat(80) }).tag).toHaveLength(50);
    expect(normalizeMessageActivityQuery({ message_id: '' }).messageId).toBeUndefined();
  });

  it('parses positive cursors only', () => {
    expect(normalizeMessageActivityQuery({ before: 123 }).before).toBe(123);
    expect(normalizeMessageActivityQuery({ before: -1 }).before).toBeUndefined();
    expect(normalizeMessageActivityQuery({ before: 'junk' }).before).toBeUndefined();
  });
});
