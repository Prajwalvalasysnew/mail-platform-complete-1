import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import * as api from '../api/operations';
import { useAuth } from '../auth/AuthContext';
import { EmptyState, ErrorState, Loading, Pill, PlanPill, StatusPill } from '../components/ui';
import { fmtAgo } from '../lib/format';

/**
 * KYC / verification.
 *
 * The backend tracks `kyc_level` per customer but does not yet expose
 * dedicated approve / request-info / reject endpoints (`/admin/kyc/*` is a
 * backend gap — see the workspace README). This screen gives operators the
 * read view over verification state; the action buttons land when the API
 * does.
 */
export function KycPage() {
  const { admin } = useAuth();
  const [level, setLevel] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const before = cursors.at(-1);

  const list = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'customers', { kyc: true, before }],
    queryFn: () => api.listCustomers({ limit: 50, before }),
    placeholderData: keepPreviousData,
  });

  const rows = (list.data?.customers ?? []).filter((c) => {
    const l = (c.kyc_level ?? 'none').toLowerCase();
    if (!level) return true;
    if (level === 'pending') return l !== 'verified' && l !== 'none';
    return l === level;
  });

  const pending = (list.data?.customers ?? []).filter((c) => {
    const l = (c.kyc_level ?? '').toLowerCase();
    return l && l !== 'verified' && l !== 'none';
  }).length;

  return (
    <>
      <div className="page-head">
        <div className="page-desc">Sender verification levels per tenant — higher levels unlock higher quotas and dedicated IPs.</div>
        <div className="row">
          {pending > 0 ? <Pill tone="blue">{pending} pending review</Pill> : null}
          <select className="select" style={{ width: 150 }} value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Filter KYC level">
            <option value="">All levels</option>
            <option value="none">None</option>
            <option value="pending">Pending</option>
            <option value="verified">Verified</option>
          </select>
        </div>
      </div>

      <div className="alert blue">
        <div className="body">
          <div className="t">Approve / request-info / reject actions are not wired yet</div>
          The current API tracks <span className="codechip">kyc_level</span> per tenant but has no{' '}
          <span className="codechip">/admin/kyc/*</span> decision endpoints. This view is read-only until those routes ship
          (tracked as a backend gap in the console README).
        </div>
      </div>

      <div className="card">
        {list.isPending ? (
          <Loading label="Loading verification queue…" />
        ) : list.isError ? (
          <div className="card-pad"><ErrorState error={list.error} retry={() => void list.refetch()} /></div>
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing to review" hint="No tenants match this verification filter." />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Tenant</th>
                    <th>Business name</th>
                    <th>Plan</th>
                    <th>Account status</th>
                    <th>KYC level</th>
                    <th>Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <div className="cell-main">{c.email}</div>
                        <div className="cell-sub mono">{c.id.slice(0, 8)}…</div>
                      </td>
                      <td>{c.name ?? <span className="section-note">—</span>}</td>
                      <td><PlanPill tier={c.tier} /></td>
                      <td><StatusPill status={c.status} /></td>
                      <td>
                        <Pill tone={(c.kyc_level ?? '').toLowerCase() === 'verified' ? 'green' : c.kyc_level ? 'amber' : 'ghost'}>
                          {c.kyc_level ?? 'none'}
                        </Pill>
                      </td>
                      <td style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{fmtAgo(c.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot">
              <span>{rows.length} tenants</span>
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
    </>
  );
}
