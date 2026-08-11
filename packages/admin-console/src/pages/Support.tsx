import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/operations';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { EmptyState, ErrorState, Loading, Pill } from '../components/ui';
import { Icon } from '../components/icons';
import { friendlyError } from '../lib/http';
import { fmtAgo, fmtDate } from '../lib/format';
import type { TicketPriority, TicketRow, TicketStatus } from '../api/types';

function priorityTone(p: TicketPriority): 'red' | 'amber' | 'outline' | 'ghost' {
  return p === 'urgent' ? 'red' : p === 'high' ? 'amber' : p === 'normal' ? 'outline' : 'ghost';
}
function statusTone(s: TicketStatus): 'green' | 'amber' | 'blue' | 'ghost' {
  return s === 'resolved' ? 'green' : s === 'pending' ? 'amber' : s === 'open' ? 'blue' : 'ghost';
}

const TABS: Array<{ key: string; label: string; status?: TicketStatus }> = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open', status: 'open' },
  { key: 'pending', label: 'Pending', status: 'pending' },
  { key: 'resolved', label: 'Resolved', status: 'resolved' },
];

export function SupportPage() {
  const { admin } = useAuth();
  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const status = TABS.find((t) => t.key === tab)?.status;
  const list = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'tickets', { status }],
    queryFn: () => api.listTickets({ status, limit: 50 }),
    refetchInterval: 30_000,
  });

  const breaches = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'sla-breaches'],
    queryFn: api.slaBreaches,
    refetchInterval: 60_000,
  });

  const tickets = useMemo(() => {
    const rows = list.data?.tickets ?? [];
    if (!search.trim()) return rows;
    const needle = search.toLowerCase();
    return rows.filter(
      (t) =>
        t.subject.toLowerCase().includes(needle) ||
        t.customer_email.toLowerCase().includes(needle) ||
        (t.customer_name ?? '').toLowerCase().includes(needle)
    );
  }, [list.data, search]);

  useEffect(() => {
    if (!selectedId && tickets.length > 0) setSelectedId(tickets[0].id);
  }, [tickets, selectedId]);

  const breachIds = new Set((breaches.data?.breaches ?? []).map((b) => b.id));
  const selected = tickets.find((t) => t.id === selectedId) ?? null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '290px minmax(0,1fr) 250px', gap: 16, alignItems: 'start' }}>
      {/* ── Inbox list ── */}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 560 }}>
        <div className="card-pad" style={{ paddingBottom: 10 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="card-title">Inbox</div>
            {breachIds.size > 0 ? <Pill tone="red">{breachIds.size} SLA</Pill> : null}
          </div>
          <div className="searchbox" style={{ marginTop: 10 }}>
            <Icon name="search" size={13} />
            <input placeholder="Search tickets…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search tickets" />
          </div>
          <div className="tabs" style={{ marginTop: 10 }}>
            {TABS.map((t) => (
              <button key={t.key} className={`tab${tab === t.key ? ' active' : ''}`} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {breachIds.size > 0 ? (
          <div style={{ padding: '6px 14px', background: 'var(--red-wash)', borderTop: '1px solid oklch(0.9 0.05 25)', borderBottom: '1px solid oklch(0.9 0.05 25)', fontSize: 11, fontWeight: 700, color: 'var(--red-text)' }}>
            ⏱ {breachIds.size} SLA breach{breachIds.size > 1 ? 'es' : ''} — immediate action required
          </div>
        ) : null}

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {list.isPending ? (
            <Loading />
          ) : list.isError ? (
            <div className="card-pad"><ErrorState error={list.error} retry={() => void list.refetch()} /></div>
          ) : tickets.length === 0 ? (
            <EmptyState title="No tickets" hint="Nothing matches this view." />
          ) : (
            tickets.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px',
                  borderBottom: '1px solid var(--border-soft)',
                  borderLeft: selectedId === t.id ? '3px solid var(--blue)' : '3px solid transparent',
                  background: selectedId === t.id ? 'var(--blue-wash)' : breachIds.has(t.id) ? 'var(--red-wash)' : undefined,
                }}
              >
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <span style={{ fontWeight: 600, fontSize: 12.5, lineHeight: 1.35 }}>{t.subject}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{fmtAgo(t.last_message_at)}</span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-dim)', margin: '2px 0 5px' }}>{t.customer_name || t.customer_email}</div>
                <div className="row" style={{ gap: 5 }}>
                  <Pill tone={statusTone(t.status)}>{t.status}</Pill>
                  <Pill tone={priorityTone(t.priority)}>{t.priority}</Pill>
                  <Pill tone="ghost">{t.category}</Pill>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* ── Conversation ── */}
      {selected ? (
        <TicketThread key={selected.id} ticket={selected} />
      ) : (
        <div className="card"><EmptyState title="Select a ticket" hint="Choose a conversation from the inbox." /></div>
      )}

      {/* ── Details rail ── */}
      {selected ? <TicketDetailsRail ticket={selected} /> : <div />}
    </div>
  );
}

function TicketThread({ ticket }: { ticket: TicketRow }) {
  const { admin } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'ticket', ticket.id],
    queryFn: () => api.ticketDetail(ticket.id),
    refetchInterval: 20_000,
  });
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [text, setText] = useState('');

  useEffect(() => {
    void api.markTicketRead(ticket.id).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: ['admin', 'badges', 'support-unread'] });
  }, [ticket.id, queryClient]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'ticket', ticket.id] });
    void queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'tickets'] });
  };

  const send = useMutation({
    mutationFn: () => api.replyTicket(ticket.id, { body: text.trim(), internal: mode === 'note' }),
    onSuccess: () => {
      toast(mode === 'note' ? 'Internal note saved.' : `Reply sent to ${ticket.customer_email}.`);
      setText('');
      invalidate();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  const resolve = useMutation({
    mutationFn: () => api.updateTicket(ticket.id, { status: ticket.status === 'resolved' ? 'open' : 'resolved' }),
    onSuccess: () => {
      toast(ticket.status === 'resolved' ? 'Ticket reopened.' : 'Ticket resolved.');
      invalidate();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  const triage = useMutation({
    mutationFn: () => api.triageTicket(ticket.id),
    onSuccess: () => {
      toast('AI triage complete — suggested priority/category updated.');
      invalidate();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  const draft = useMutation({
    mutationFn: () => api.suggestReply(ticket.id),
    onSuccess: (d) => {
      setMode('reply');
      setText(d.draft);
      toast(`AI draft inserted (${d.model}) — review before sending.`);
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  const assignToMe = useMutation({
    mutationFn: () => api.updateTicket(ticket.id, { assign_to_me: true }),
    onSuccess: () => {
      toast('Assigned to you.');
      invalidate();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  const t = detail.data?.ticket ?? ticket;
  const messages = detail.data?.messages ?? [];

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 560 }}>
      <div className="card-pad row" style={{ justifyContent: 'space-between', borderBottom: '1px solid var(--border-soft)', paddingBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div className="card-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 }}>{t.subject}</div>
          <div className="section-note">
            {t.customer_name || t.customer_email} · <span className="mono">{t.id.slice(0, 8)}</span> · <Pill tone="ghost">{t.category}</Pill>
          </div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {!t.assigned_admin_user_id ? (
            <button className="btn sm" onClick={() => assignToMe.mutate()} disabled={assignToMe.isPending}>Assign to me</button>
          ) : null}
          <button className="btn sm" onClick={() => triage.mutate()} disabled={triage.isPending}>
            <Icon name="spark" size={12} /> {triage.isPending ? 'Triaging…' : 'AI triage'}
          </button>
          <button className={`btn sm ${t.status === 'resolved' ? '' : 'success'}`} onClick={() => resolve.mutate()} disabled={resolve.isPending}>
            {t.status === 'resolved' ? 'Reopen' : 'Resolve'}
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {detail.isPending ? <Loading label="Loading conversation…" /> : null}
        {detail.isError ? <ErrorState error={detail.error} retry={() => void detail.refetch()} /> : null}
        {messages.map((m) => {
          const isAgent = m.author_type === 'admin' && !m.internal;
          const isNote = m.internal;
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: isAgent || isNote ? 'flex-end' : 'flex-start' }}>
              <div
                style={{
                  maxWidth: '78%', borderRadius: 12, padding: '10px 14px', fontSize: 12.5, lineHeight: 1.5,
                  background: isNote ? 'var(--amber-wash)' : isAgent ? 'var(--blue)' : 'var(--bg-subtle)',
                  color: isAgent ? '#fff' : 'var(--text)',
                  border: isNote ? '1px dashed oklch(0.8 0.1 72)' : isAgent ? 'none' : '1px solid var(--border)',
                }}
              >
                {isNote ? (
                  <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.08em', color: 'var(--amber-text)', marginBottom: 4 }}>
                    INTERNAL NOTE · VISIBLE TO AGENTS ONLY
                  </div>
                ) : null}
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
                <div style={{ fontSize: 10.5, marginTop: 6, opacity: isAgent ? 1 : 0.75 }}>
                  {fmtDate(m.created_at)} · {m.author_admin_email ?? m.author_user_email ?? m.author_type}
                </div>
              </div>
            </div>
          );
        })}
        {!detail.isPending && messages.length === 0 ? <EmptyState title="No messages yet" /> : null}
      </div>

      <div style={{ borderTop: '1px solid var(--border-soft)', padding: '10px 18px 14px' }}>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <div className="tabs">
            <button className={`tab${mode === 'reply' ? ' active' : ''}`} onClick={() => setMode('reply')}>Reply</button>
            <button className={`tab${mode === 'note' ? ' active' : ''}`} onClick={() => setMode('note')}>Internal note</button>
          </div>
          <button className="btn sm" onClick={() => draft.mutate()} disabled={draft.isPending}>
            <Icon name="spark" size={12} /> {draft.isPending ? 'Drafting…' : 'AI draft'}
          </button>
        </div>
        <CannedBar category={t.category} onPick={(body) => { setMode('reply'); setText(body); }} />
        <textarea
          className="input"
          rows={3}
          placeholder={mode === 'note' ? 'Add an internal note (never sent to the customer)…' : `Reply to ${t.customer_email}…`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={mode === 'note' ? { background: 'var(--amber-wash)' } : undefined}
        />
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <span className="section-note">Replies are logged to the audit trail</span>
          <button className="btn primary" disabled={!text.trim() || send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? 'Sending…' : mode === 'note' ? 'Save note' : 'Send reply'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CannedBar({ category, onPick }: { category: string; onPick: (body: string) => void }) {
  const { admin } = useAuth();
  const canned = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'canned', category],
    queryFn: () => api.listCanned(category),
    staleTime: 300_000,
  });
  const items = canned.data?.canned_responses ?? [];
  if (items.length === 0) return null;
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
      <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 600 }}>Quick:</span>
      {items.slice(0, 6).map((c) => (
        <button key={c.id} className="btn sm" onClick={() => onPick(c.body)} title={c.body.slice(0, 200)}>
          {c.title}
        </button>
      ))}
    </div>
  );
}

function TicketDetailsRail({ ticket }: { ticket: TicketRow }) {
  const { admin } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'ticket', ticket.id],
    queryFn: () => api.ticketDetail(ticket.id),
  });
  const t = detail.data?.ticket ?? ticket;

  const patch = useMutation({
    mutationFn: (body: { priority?: string; category?: string; status?: string }) => api.updateTicket(ticket.id, body),
    onSuccess: () => {
      toast('Ticket updated.');
      void queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'ticket', ticket.id] });
      void queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'tickets'] });
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  const due = t.first_response_due_at ?? t.resolution_due_at;
  const dueMs = due ? new Date(due as string).getTime() - Date.now() : null;

  return (
    <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div className="card-title" style={{ fontSize: 13 }}>Ticket details</div>
        <div className="section-note mono">{t.id.slice(0, 8)}</div>
      </div>

      <div className="field">
        <label>Priority</label>
        <select aria-label="Ticket priority" className="select" value={t.priority} onChange={(e) => patch.mutate({ priority: e.target.value })}>
          {['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Status</label>
        <select aria-label="Ticket status" className="select" value={t.status} onChange={(e) => patch.mutate({ status: e.target.value })}>
          {['open', 'pending', 'resolved', 'closed'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Category</label>
        <select aria-label="Ticket category" className="select" value={t.category} onChange={(e) => patch.mutate({ category: e.target.value })}>
          {['general', 'billing', 'deliverability', 'technical', 'abuse', 'account'].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {dueMs !== null ? (
        <div>
          <div className="nav-group-label" style={{ padding: '0 0 5px' }}>SLA</div>
          <Pill tone={dueMs < 0 ? 'red' : dueMs < 30 * 60_000 ? 'amber' : 'green'}>
            {dueMs < 0 ? `breached ${fmtAgo(due as string)}` : `due ${fmtAgo(due as string).replace(' ago', '')}`}
          </Pill>
        </div>
      ) : null}

      <div>
        <div className="nav-group-label" style={{ padding: '0 0 5px' }}>Assignee</div>
        <div style={{ fontSize: 12.5 }}>{t.assigned_admin_email ?? <span className="section-note">Unassigned</span>}</div>
      </div>

      {t.ai_summary ? (
        <div>
          <div className="nav-group-label" style={{ padding: '0 0 5px' }}>AI summary</div>
          <div style={{ fontSize: 12, color: 'var(--text-mid)', lineHeight: 1.5, background: 'var(--bg-subtle)', borderRadius: 8, padding: '8px 10px' }}>
            {t.ai_summary}
            {t.ai_confidence != null ? <div className="section-note" style={{ marginTop: 4 }}>confidence {(Number(t.ai_confidence) * 100).toFixed(0)}%</div> : null}
          </div>
        </div>
      ) : null}

      <div>
        <div className="nav-group-label" style={{ padding: '0 0 5px' }}>Customer</div>
        <div className="row">
          <span className="avatar" style={{ width: 26, height: 26, fontSize: 10 }}>
            {(t.customer_name || t.customer_email).slice(0, 2).toUpperCase()}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 12 }}>{t.customer_name ?? '—'}</div>
            <div className="section-note mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.customer_email}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
