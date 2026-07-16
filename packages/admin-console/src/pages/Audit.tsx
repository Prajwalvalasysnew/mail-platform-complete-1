import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as api from '../api/operations';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../lib/http';
import { EmptyState, ErrorState, Loading, PermissionState, Pill, SearchInput } from '../components/ui';
import { Icon } from '../components/icons';
import { fmtDate } from '../lib/format';

export function AuditPage() {
  const { admin, hasRole } = useAuth();
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');

  const audit = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'audit'],
    queryFn: () => api.auditLog(300),
    enabled: hasRole('admin'),
    refetchInterval: 60_000,
  });

  const rows = useMemo(() => {
    let out = audit.data?.audit ?? [];
    if (action) out = out.filter((r) => r.action === action);
    if (q.trim()) {
      const needle = q.toLowerCase();
      out = out.filter((r) =>
        [r.actor, r.action, r.resource, r.ip, r.customer_id, JSON.stringify(r.detail ?? {})]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle))
      );
    }
    return out;
  }, [audit.data, q, action]);

  const actions = useMemo(() => [...new Set((audit.data?.audit ?? []).map((r) => r.action))].sort(), [audit.data]);

  if (!hasRole('admin')) return <PermissionState need="admin" />;

  function exportCsv() {
    const head = ['occurred_at', 'actor', 'action', 'resource', 'customer_id', 'ip', 'detail'];
    const lines = [head.join(',')].concat(
      rows.map((r) =>
        head
          .map((k) => {
            const v = k === 'detail' ? JSON.stringify(r.detail ?? {}) : ((r as Record<string, unknown>)[k] ?? '');
            return `"${String(v).replaceAll('"', '""')}"`;
          })
          .join(',')
      )
    );
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `admin-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="page-head">
        <div className="page-desc">Immutable audit trail — every platform and admin action is logged here.</div>
        <div className="row">
          <Pill tone="green"><span className="dot green" style={{ marginRight: 4 }} /> Live</Pill>
          <button className="btn" onClick={exportCsv} disabled={rows.length === 0}>
            <Icon name="download" size={13} /> Export
          </button>
        </div>
      </div>

      <div className="row">
        <div style={{ flex: 1 }}>
          <SearchInput placeholder="Search actor, resource, IP…" onChange={setQ} />
        </div>
        <select className="select" style={{ width: 220 }} value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter action">
          <option value="">All actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      <div className="card">
        {audit.isPending ? (
          <Loading label="Loading audit trail…" />
        ) : audit.isError ? (
          audit.error instanceof ApiError && audit.error.status === 403 ? (
            <PermissionState need="admin" />
          ) : (
            <div className="card-pad"><ErrorState error={audit.error} retry={() => void audit.refetch()} /></div>
          )
        ) : rows.length === 0 ? (
          <EmptyState title="No audit entries" hint="No admin actions match this filter." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>Tenant</th>
                  <th>IP</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono" style={{ fontSize: 11.5 }}>{r.actor ?? '—'}</td>
                    <td><Pill tone="outline">{r.action.replace(/^admin:/, '')}</Pill></td>
                    <td className="mono" style={{ fontSize: 11.5, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={JSON.stringify(r.detail ?? {})}>
                      {r.resource ?? '—'}
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{r.customer_id ? `${r.customer_id.slice(0, 8)}…` : '—'}</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{r.ip ?? '—'}</td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{fmtDate(r.occurred_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-foot">
          <span>{rows.length} entries (most recent 300)</span>
          <span className="mono" style={{ fontSize: 10.5 }}>GET /admin/audit</span>
        </div>
      </div>
    </>
  );
}
