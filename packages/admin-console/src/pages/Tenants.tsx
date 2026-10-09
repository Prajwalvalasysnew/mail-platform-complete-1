import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/operations';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { ConfirmModal, EmptyState, ErrorState, Loading, Modal, Pill, PlanPill, SearchInput, StatusPill } from '../components/ui';
import { Icon } from '../components/icons';
import { friendlyError } from '../lib/http';
import { fmtAgo, fmtDate, fmtNum, fmtPct } from '../lib/format';
import type { CustomerRow } from '../api/types';

const PAGE_SIZE = 25;

export function TenantsPage() {
  const { admin } = useAuth();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [tier, setTier] = useState('');
  const [cursors, setCursors] = useState<string[]>([]); // cursor stack for prev/next
  const before = cursors.at(-1);
  const [selected, setSelected] = useState<CustomerRow | null>(null);

  const list = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'customers', { q, status, tier, before }],
    queryFn: () => api.listCustomers({ q: q || undefined, status: status || undefined, tier: tier || undefined, limit: PAGE_SIZE, before }),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="page-head">
        <div className="page-desc">All customer accounts — search, filter, and drill into any tenant.</div>
        <div className="row">
          <select className="select" style={{ width: 130 }} value={status} onChange={(e) => { setStatus(e.target.value); setCursors([]); }} aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="pending">Pending</option>
            <option value="suspended">Suspended</option>
          </select>
          <select className="select" style={{ width: 130 }} value={tier} onChange={(e) => { setTier(e.target.value); setCursors([]); }} aria-label="Filter by plan">
            <option value="">All plans</option>
            <option value="free">Free</option>
            <option value="paid">Paid</option>
            <option value="enterprise">Enterprise</option>
          </select>
          <SearchInput placeholder="Search by name, email, ID…" onChange={(v) => { setQ(v); setCursors([]); }} />
          <button className="btn primary"><Icon name="plus" size={13} /> Invite tenant</button>
        </div>
      </div>

      <div className="card">
        {list.isPending ? (
          <Loading label="Loading tenants…" />
        ) : list.isError ? (
          <div className="card-pad"><ErrorState error={list.error} retry={() => void list.refetch()} /></div>
        ) : list.data.customers.length === 0 ? (
          <EmptyState title="No tenants match" hint="Adjust the search or filters." />
        ) : (
          <>
            <div className="table-wrap" tabIndex={0}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Tenant</th>
                    <th>Plan</th>
                    <th>Status</th>
                    <th className="num">Msgs 7d</th>
                    <th className="num">Bounce %</th>
                    <th>Daily quota</th>
                    <th className="num">MRR</th>
                    <th className="num">Domains</th>
                    <th>Last active</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.customers.map((c) => (
                    <tr key={c.id} className="rowlink" onClick={() => setSelected(c)}>
                      <td>
                        <div className="cell-main">{c.name || c.email}</div>
                        <div className="cell-sub mono">{c.email}</div>
                      </td>
                      <td><PlanPill tier={c.tier} /></td>
                      <td><StatusPill status={c.status} /></td>
                      <td className="num">{fmtNum(c.messages_7d ?? 0)}</td>
                      <td className="num" style={{ color: (c.bounced_7d ?? 0) / Math.max(c.messages_7d ?? 0, 1) > .05 ? 'var(--red-text)' : undefined }}>{fmtPct((c.bounced_7d ?? 0) / Math.max(c.messages_7d ?? 0, 1))}</td>
                      <td><QuotaCell used={Math.min(c.messages_7d ?? 0, c.daily_quota)} limit={c.daily_quota} /></td>
                      <td className="num">{formatMoney(c.mrr_cents)}</td>
                      <td className="num">{fmtNum(c.domain_count ?? 0)}</td>
                      <td style={{ color: 'var(--text-dim)', fontSize: 11.5, whiteSpace: 'nowrap' }}>{c.last_active_at ? fmtAgo(c.last_active_at) : 'Never'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot">
              <span>{list.data.customers.length} tenants on this page{list.isFetching ? ' · refreshing…' : ''}</span>
              <div className="row">
                <button className="btn sm" disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>← Prev</button>
                <button
                  className="btn sm"
                  disabled={!list.data.next_cursor}
                  onClick={() => list.data.next_cursor && setCursors((c) => [...c, list.data.next_cursor!])}
                >
                  Next →
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {selected ? <TenantDrawer id={selected.id} fallback={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}

function QuotaCell({ used, limit }: { used: number; limit: number }) {
  const fraction = used / Math.max(limit, 1);
  const color = fraction > .9 ? 'var(--red)' : fraction > .75 ? 'var(--amber-strong)' : 'var(--blue)';
  return <div className="tenant-quota-cell"><div className="meterbar"><div style={{ width: `${Math.min(100, fraction * 100)}%`, background: color }} /></div><b style={{ color }}>{fmtCompactNumber(used)} / {fmtCompactNumber(limit)}</b></div>;
}

function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return <div className="tenant-stat"><span>{label}</span><b className={small ? 'small' : ''}>{value}</b></div>;
}

function QuotaBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const fraction = used / Math.max(limit, 1);
  const color = fraction > .9 ? 'var(--red)' : fraction > .75 ? 'var(--amber-strong)' : 'var(--blue)';
  return <div className="drawer-quota"><div><span>{label}</span><b>{fmtNum(used)} / {fmtNum(limit)}</b></div><div className="meterbar"><div style={{ width: `${Math.min(100, fraction * 100)}%`, background: color }} /></div><small>{Math.round(fraction * 100)}% used</small></div>;
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return <div className="tenant-info-row"><span>{label}</span><b className={mono ? 'mono' : ''}>{value}</b></div>;
}

function Resource({ label, value }: { label: string; value: number }) {
  return <div><b>{fmtNum(value)}</b><span>{label}</span></div>;
}

function fmtCompactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatMoney(cents?: number | null): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format((Number(cents) || 0) / 100);
}

function TenantDrawer({ id, fallback, onClose }: { id: string; fallback: CustomerRow; onClose: () => void }) {
  const { admin, hasRole } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'customer', id],
    queryFn: () => api.customerOverview(id),
  });
  const [confirmSuspend, setConfirmSuspend] = useState<null | 'suspend' | 'reinstate'>(null);
  const [editPlan, setEditPlan] = useState(false);
  const [noteBody, setNoteBody] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmSuspend && !editPlan) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirmSuspend, editPlan]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'customer', id] });
    void queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'customers'] });
  };

  const suspend = useMutation({
    mutationFn: async (action: 'suspend' | 'reinstate'): Promise<unknown> =>
      action === 'suspend' ? api.suspendCustomer({ customer_id: id, reason: 'Suspended from admin console' }) : api.reinstateCustomer({ customer_id: id }),
    onSuccess: (_d, action) => {
      toast(action === 'suspend' ? 'Tenant suspended — sending stopped.' : 'Tenant reinstated.');
      setConfirmSuspend(null);
      invalidate();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  const addNote = useMutation({
    mutationFn: () => api.createCustomerNote(id, { body: noteBody }),
    onSuccess: () => {
      toast('Internal note saved.');
      setNoteBody('');
      invalidate();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  const c = (detail.data?.customer ?? fallback) as CustomerRow;
  const cd = detail.data;
  const usage = cd?.usage_30d ?? [];
  const todayKey = new Date().toISOString().slice(0, 10);
  const sevenDayStart = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const usage7d = usage.filter((row) => String(row.usage_date).slice(0, 10) >= sevenDayStart);
  const sent7d = c.messages_7d ?? usage7d.reduce((sum, row) => sum + Number(row.sent), 0);
  const bounced7d = c.bounced_7d ?? usage7d.reduce((sum, row) => sum + Number(row.bounced), 0);
  const sent30d = usage.reduce((sum, row) => sum + Number(row.sent), 0);
  const todaySent = usage.filter((row) => String(row.usage_date).slice(0, 10) === todayKey).reduce((sum, row) => sum + Number(row.sent), 0);
  const lastActive = (cd?.recent_messages?.[0]?.queued_at as string | undefined) ?? c.last_active_at;
  const initials = (c.name || c.email).split(/\s+|@/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer tenant-drawer" role="dialog" aria-modal="true" aria-label={`Tenant ${c.name ?? c.email}`}>
        <div className="tenant-drawer-head">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="tenant-identity">
              <span className="tenant-logo">{initials}</span>
              <div><div className="tenant-name">{c.name || c.email}</div><div className="section-note mono">{c.email}</div></div>
            </div>
            <div className="row"><button className="iconbtn drawer-close" onClick={onClose} aria-label="Close">
                <Icon name="x" />
              </button></div>
          </div>
        </div>

        <div className="tenant-drawer-body">
          {detail.isPending ? <Loading label="Loading tenant detail…" /> : null}
          {detail.isError ? <ErrorState error={detail.error} retry={() => void detail.refetch()} /> : null}

          <div className="tenant-badges"><PlanPill tier={c.tier} /><StatusPill status={c.status} />{c.billing_status && <StatusPill status={c.billing_status} />}<Pill tone={(bounced7d / Math.max(sent7d, 1)) > .05 ? 'red' : 'green'}>{(bounced7d / Math.max(sent7d, 1)) > .05 ? 'high risk' : 'low risk'}</Pill></div>
          <div className="tenant-stat-grid">
            <Stat label="Messages (7d)" value={fmtNum(sent7d)} /><Stat label="MRR" value={formatMoney(cd?.billing?.amount_cents ?? c.mrr_cents)} /><Stat label="Bounce rate" value={fmtPct(bounced7d / Math.max(sent7d, 1))} /><Stat label="Last active" value={lastActive ? fmtAgo(lastActive) : 'Never'} small />
          </div>
          <section className="tenant-panel"><div className="tenant-section-title">Quota</div><QuotaBar label="Daily" used={todaySent} limit={c.daily_quota} /><QuotaBar label="Monthly" used={sent30d} limit={c.monthly_quota} /></section>
          <section className="tenant-panel"><div className="tenant-section-title">Billing</div><InfoRow label="Provider" value={(c as CustomerRow & { billing_provider?: string }).billing_provider ?? '—'} /><InfoRow label="Subscription" value={c.billing_status ?? '—'} /><InfoRow label="MRR" value={formatMoney(cd?.billing?.amount_cents ?? c.mrr_cents)} mono /></section>
          <div className="tenant-resource-grid"><Resource label="API keys" value={cd?.api_keys?.length ?? 0} /><Resource label="Webhooks" value={cd?.resources?.webhook_count ?? 0} /><Resource label="Sups" value={cd?.resources?.suppression_count ?? 0} /><Resource label="Tickets" value={cd?.resources?.ticket_count ?? 0} /></div>

          <section>
            <div className="nav-group-label" style={{ padding: '0 0 6px' }}>Account</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12.5 }}>
              <div><span className="section-note">Email</span><div className="mono">{c.email}</div></div>
              <div><span className="section-note">Created</span><div>{fmtDate(c.created_at)}</div></div>
              <div><span className="section-note">Daily quota</span><div className="mono">{fmtNum(c.daily_quota)}</div></div>
              <div><span className="section-note">Monthly quota</span><div className="mono">{fmtNum(c.monthly_quota)}</div></div>
              <div><span className="section-note">Billing status</span><div>{c.billing_status ?? '—'}</div></div>
              <div><span className="section-note">KYC level</span><div>{c.kyc_level ?? '—'}</div></div>
            </div>
          </section>

          {cd?.members?.length ? (
            <section>
              <div className="nav-group-label" style={{ padding: '0 0 6px' }}>Members ({cd.members.length})</div>
              {cd.members.map((m) => (
                <div key={m.id} className="row" style={{ justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border-soft)' }}>
                  <span className="mono" style={{ fontSize: 12 }}>{m.email}</span>
                  <span className="row">
                    {m.mfa_enabled ? <Pill tone="green">MFA</Pill> : <Pill tone="ghost">no MFA</Pill>}
                    <Pill tone="outline">{m.role}</Pill>
                  </span>
                </div>
              ))}
            </section>
          ) : null}

          {cd?.domains?.length ? (
            <section>
              <div className="nav-group-label" style={{ padding: '0 0 6px' }}>Sending domains ({cd.domains.length})</div>
              {cd.domains.map((d) => (
                <div key={d.id} className="row" style={{ justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border-soft)' }}>
                  <span className="mono" style={{ fontSize: 12 }}>{d.domain}</span>
                  <StatusPill status={d.status} />
                </div>
              ))}
            </section>
          ) : null}

          {cd?.api_keys?.length ? (
            <section>
              <div className="nav-group-label" style={{ padding: '0 0 6px' }}>API keys ({cd.api_keys.length})</div>
              {cd.api_keys.map((k) => (
                <div key={k.id} className="row" style={{ justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border-soft)' }}>
                  <span>
                    <span className="mono" style={{ fontSize: 12 }}>{k.key_prefix}…</span>
                    <span className="section-note" style={{ marginLeft: 8 }}>{k.name}</span>
                  </span>
                  <span className="row">
                    {k.revoked_at ? <Pill tone="red">revoked</Pill> : k.expires_at ? <Pill tone="amber">expiring</Pill> : <Pill tone="green">active</Pill>}
                    <span className="section-note">{k.last_used_at ? `used ${fmtAgo(k.last_used_at)}` : 'never used'}</span>
                  </span>
                </div>
              ))}
            </section>
          ) : null}

          <section>
            <div className="nav-group-label" style={{ padding: '0 0 6px' }}>Support notes</div>
            {(cd?.support_notes ?? []).map((n) => (
              <div key={n.id} style={{ padding: '7px 10px', background: 'var(--amber-wash)', borderRadius: 8, marginBottom: 6, fontSize: 12.5 }}>
                <div>{n.body}</div>
                <div className="section-note" style={{ marginTop: 3 }}>{fmtDate(n.created_at)}</div>
              </div>
            ))}
            <div className="row" style={{ alignItems: 'stretch' }}>
              <textarea
                className="input"
                rows={2}
                placeholder="Add an internal note…"
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                style={{ flex: 1 }}
              />
              <button className="btn" disabled={!noteBody.trim() || addNote.isPending} onClick={() => addNote.mutate()}>
                Save
              </button>
            </div>
          </section>
        </div>
        <div className="tenant-drawer-foot">
          {hasRole('operator') && <button className="btn" onClick={() => setEditPlan(true)}>Edit quota</button>}
          {hasRole('admin') && (c.status === 'suspended' ? <button className="btn success" onClick={() => setConfirmSuspend('reinstate')}>Reinstate</button> : <button className="btn danger" onClick={() => setConfirmSuspend('suspend')}>Suspend</button>)}
        </div>
      </div>

      {confirmSuspend ? (
        <ConfirmModal
          title={confirmSuspend === 'suspend' ? 'Suspend tenant' : 'Reinstate tenant'}
          body={
            confirmSuspend === 'suspend' ? (
              <>
                Suspending <b>{c.name || c.email}</b> immediately stops all sending for this tenant. The action is
                audit-logged and reversible via Reinstate.
              </>
            ) : (
              <>Reinstate <b>{c.name || c.email}</b> and resume sending?</>
            )
          }
          confirmLabel={confirmSuspend === 'suspend' ? 'Suspend tenant' : 'Reinstate'}
          confirmWord={confirmSuspend === 'suspend' ? 'SUSPEND' : undefined}
          danger={confirmSuspend === 'suspend'}
          busy={suspend.isPending}
          onConfirm={() => suspend.mutate(confirmSuspend)}
          onClose={() => setConfirmSuspend(null)}
        />
      ) : null}

      {editPlan ? <EditPlanModal customer={c} onClose={() => { setEditPlan(false); invalidate(); }} /> : null}
    </div>
  );
}

function EditPlanModal({ customer, onClose }: { customer: CustomerRow; onClose: () => void }) {
  const toast = useToast();
  const [tier, setTier] = useState(customer.tier);
  const [daily, setDaily] = useState(String(customer.daily_quota));
  const [monthly, setMonthly] = useState(String(customer.monthly_quota));

  const save = useMutation({
    mutationFn: () =>
      api.updateCustomer(customer.id, {
        tier: tier !== customer.tier ? tier : undefined,
        daily_quota: Number(daily) !== customer.daily_quota ? Number(daily) : undefined,
        monthly_quota: Number(monthly) !== customer.monthly_quota ? Number(monthly) : undefined,
      }),
    onSuccess: () => {
      toast('Tenant plan updated.');
      onClose();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  return (
    <Modal title="Edit plan & quotas" onClose={onClose}>
      <div className="field">
        <label>Plan tier</label>
        <select className="select" value={tier} onChange={(e) => setTier(e.target.value)}>
          <option value="free">free</option>
          <option value="paid">paid</option>
          <option value="enterprise">enterprise</option>
        </select>
      </div>
      <div className="field">
        <label>Daily quota</label>
        <input className="input mono" type="number" min={0} value={daily} onChange={(e) => setDaily(e.target.value)} />
      </div>
      <div className="field">
        <label>Monthly quota</label>
        <input className="input mono" type="number" min={0} value={monthly} onChange={(e) => setMonthly(e.target.value)} />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </Modal>
  );
}
