import { describe, it, expect } from 'vitest';
import { normalizeAuditQuery } from '@platform/shared';

describe('normalizeAuditQuery', () => {
  it('applies sane defaults', () => {
    expect(normalizeAuditQuery({})).toEqual({ action: undefined, actorType: undefined, sinceDays: 90, limit: 50, before: undefined });
  });

  it('clamps limit to [1,200]', () => {
    expect(normalizeAuditQuery({ limit: 9999 }).limit).toBe(200);
    expect(normalizeAuditQuery({ limit: 0 }).limit).toBe(50);
    expect(normalizeAuditQuery({ limit: -5 }).limit).toBe(50);
    expect(normalizeAuditQuery({ limit: 'abc' }).limit).toBe(50);
    expect(normalizeAuditQuery({ limit: 25 }).limit).toBe(25);
  });

  it('clamps days to [1,365]', () => {
    expect(normalizeAuditQuery({ days: 100000 }).sinceDays).toBe(365);
    expect(normalizeAuditQuery({ days: 7 }).sinceDays).toBe(7);
    expect(normalizeAuditQuery({ days: -1 }).sinceDays).toBe(90);
  });

  it('only accepts known actor types', () => {
    expect(normalizeAuditQuery({ actor_type: 'user' }).actorType).toBe('user');
    expect(normalizeAuditQuery({ actor_type: 'admin' }).actorType).toBe('admin');
    expect(normalizeAuditQuery({ actor_type: 'hacker' }).actorType).toBeUndefined();
  });

  it('parses a positive before cursor and ignores junk', () => {
    expect(normalizeAuditQuery({ before: 123 }).before).toBe(123);
    expect(normalizeAuditQuery({ before: 'nope' }).before).toBeUndefined();
    expect(normalizeAuditQuery({ before: -3 }).before).toBeUndefined();
  });

  it('truncates an over-long action filter', () => {
    const q = normalizeAuditQuery({ action: 'x'.repeat(500) });
    expect(q.action!.length).toBe(100);
  });
});
