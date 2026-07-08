import { describe, expect, it } from 'vitest';
import { getInferenceProvider, normalizeSupportCustomerQuery, normalizeSupportTicketQuery } from '@platform/shared';

describe('normalizeSupportCustomerQuery', () => {
  it('applies defaults', () => {
    expect(normalizeSupportCustomerQuery({})).toEqual({
      q: undefined,
      status: undefined,
      tier: undefined,
      limit: 50,
      before: undefined,
    });
  });

  it('accepts known status and tier filters only', () => {
    expect(normalizeSupportCustomerQuery({ status: 'active', tier: 'enterprise' }).status).toBe('active');
    expect(normalizeSupportCustomerQuery({ status: 'deleted', tier: 'gold' }).status).toBeUndefined();
    expect(normalizeSupportCustomerQuery({ status: 'deleted', tier: 'gold' }).tier).toBeUndefined();
  });

  it('trims query and clamps limit', () => {
    expect(normalizeSupportCustomerQuery({ q: '  customer@example.com  ', limit: 999 }).q).toBe('customer@example.com');
    expect(normalizeSupportCustomerQuery({ limit: 999 }).limit).toBe(200);
    expect(normalizeSupportCustomerQuery({ limit: -1 }).limit).toBe(50);
  });
});

describe('support ticket inference provider', () => {
  it('triages deliverability issues deterministically', async () => {
    const result = await getInferenceProvider().triageSupportTicket({
      subject: 'Gmail deferrals',
      messages: [{ body: 'Urgent: all mail is blocked by Gmail deferral errors.' }],
    });
    expect(result.suggested_category).toBe('deliverability');
    expect(result.suggested_priority).toBe('urgent');
    expect(result.summary).toContain('Urgent');
    expect(result.model).toBe('local-heuristic-v1');
  });
});

describe('normalizeSupportTicketQuery', () => {
  it('applies ticket defaults', () => {
    expect(normalizeSupportTicketQuery({})).toEqual({
      customerId: undefined,
      status: undefined,
      priority: undefined,
      category: undefined,
      assigned: undefined,
      limit: 50,
      before: undefined,
    });
  });

  it('accepts only known ticket filters', () => {
    const q = normalizeSupportTicketQuery({ status: 'open', priority: 'urgent', category: 'deliverability', assigned: 'me' });
    expect(q.status).toBe('open');
    expect(q.priority).toBe('urgent');
    expect(q.category).toBe('deliverability');
    expect(q.assigned).toBe('me');

    const bad = normalizeSupportTicketQuery({ status: 'new', priority: 'p0', category: 'random', assigned: 'someone' });
    expect(bad.status).toBeUndefined();
    expect(bad.priority).toBeUndefined();
    expect(bad.category).toBeUndefined();
    expect(bad.assigned).toBeUndefined();
  });
});
