import { sql } from 'kysely';
import { withTenant } from './tenant-context.js';

export const MESSAGE_EVENT_TYPES = [
  'queued',
  'sent',
  'delivered',
  'soft_bounce',
  'hard_bounce',
  'complaint',
  'opened',
  'clicked',
  'unsubscribed',
  'failed',
] as const;

export type MessageEventType = (typeof MESSAGE_EVENT_TYPES)[number];

export interface MessageActivityQueryRaw {
  event_type?: string;
  message_id?: string;
  to?: string;
  from?: string;
  tag?: string;
  status?: string;
  days?: string | number;
  limit?: string | number;
  before?: string | number;
}

export interface MessageActivityQuery {
  eventType?: MessageEventType;
  messageId?: string;
  to?: string;
  from?: string;
  tag?: string;
  status?: string;
  sinceDays: number;
  limit: number;
  before?: number;
}

export interface MessageActivityEntry {
  event_id: number;
  message_id: string;
  event_type: MessageEventType;
  occurred_at: Date;
  payload: Record<string, unknown>;
  ip: string | null;
  user_agent: string | null;
  bot_verdict: 'human' | 'bot' | 'suspicious' | null;
  bot_score: number | null;
  from_address: string;
  to_address: string;
  subject: string;
  status: string;
  tags: string[];
  queued_at: Date;
  accepted_at: Date | null;
  delivered_at: Date | null;
}

function safeInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

function nonEmpty(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export function normalizeMessageActivityQuery(raw: MessageActivityQueryRaw): MessageActivityQuery {
  const beforeN = parseInt(String(raw.before ?? ''), 10);
  const eventType = MESSAGE_EVENT_TYPES.includes(raw.event_type as MessageEventType)
    ? (raw.event_type as MessageEventType)
    : undefined;

  return {
    eventType,
    messageId: nonEmpty(raw.message_id, 255),
    to: nonEmpty(raw.to, 320),
    from: nonEmpty(raw.from, 320),
    tag: nonEmpty(raw.tag, 50),
    status: nonEmpty(raw.status, 50),
    sinceDays: safeInt(raw.days, 30, 1, 365),
    limit: safeInt(raw.limit, 50, 1, 200),
    before: Number.isFinite(beforeN) && beforeN > 0 ? beforeN : undefined,
  };
}

export async function listMessageActivity(
  customerId: string,
  q: MessageActivityQuery
): Promise<{ events: MessageActivityEntry[]; next_cursor: number | null }> {
  const rows = await withTenant(customerId, async (trx) => {
    let query = trx
      .selectFrom('events')
      .innerJoin('messages', 'messages.message_id', 'events.message_id')
      .select([
        'events.id as event_id',
        'events.message_id as message_id',
        'events.event_type as event_type',
        'events.occurred_at as occurred_at',
        'events.payload as payload',
        'events.ip as ip',
        'events.user_agent as user_agent',
        'events.bot_verdict as bot_verdict',
        'events.bot_score as bot_score',
        'messages.from_address as from_address',
        'messages.to_address as to_address',
        'messages.subject as subject',
        'messages.status as status',
        'messages.tags as tags',
        'messages.queued_at as queued_at',
        'messages.accepted_at as accepted_at',
        'messages.delivered_at as delivered_at',
      ])
      .where('events.customer_id', '=', customerId)
      .where('messages.customer_id', '=', customerId)
      .where(sql<boolean>`events.occurred_at >= (NOW() - ${q.sinceDays} * INTERVAL '1 day')`);

    if (q.eventType) query = query.where('events.event_type', '=', q.eventType);
    if (q.messageId) query = query.where('events.message_id', '=', q.messageId);
    if (q.to) query = query.where(sql<boolean>`lower(messages.to_address) = lower(${q.to})`);
    if (q.from) query = query.where(sql<boolean>`lower(messages.from_address) = lower(${q.from})`);
    if (q.tag) query = query.where(sql<boolean>`messages.tags && ARRAY[${q.tag}]::text[]`);
    if (q.status) query = query.where('messages.status', '=', q.status as any);
    if (q.before) query = query.where('events.id', '<', q.before);

    return (await query
      .orderBy('events.id', 'desc')
      .limit(q.limit + 1)
      .execute()) as unknown as MessageActivityEntry[];
  });

  const normalized = rows.map((row) => ({
    ...row,
    event_id: Number(row.event_id),
  }));
  const hasMore = normalized.length > q.limit;
  const events = hasMore ? normalized.slice(0, q.limit) : normalized;
  return { events, next_cursor: hasMore ? events.at(-1)!.event_id : null };
}
