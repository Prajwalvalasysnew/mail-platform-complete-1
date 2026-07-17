import { useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import * as api from '../api/operations';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../lib/http';
import { EmptyState, ErrorState, Loading, PermissionState, Pill, SearchInput } from '../components/ui';
import { Icon } from '../components/icons';
import { fmtDate } from '../lib/format';

const PAGE_SIZE = 100;

export function AuditPage() {
  const { admin, hasRole } = useAuth();
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');

  // Cursor-paginated: GET /admin/audit?cursor=<last id> walks the trail
  // backwards page by page, so the list can grow unbounded server-side.
  const audit = useInfiniteQuery({
    queryKey: ['admin', admin?.admin_user_id, 'audit', { action }],
    queryFn: ({ pageParam }) => api.auditLog({ limit: PAGE_SIZE, cursor: pageParam, action: action || undefined }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: hasRole('admin'),
  });

  const loaded = useMemo(() => (audit.data?.pages ?? []).flatMap((p) => p.audit), [audit.data]);

  const rows = useMemo(() => {
    let out = loaded;
    if (q.trim()) {
      const needle = q.toLowerCase();
      out = out.filter((r) =>
        [r.actor, r.action, r.resource, r.ip, r.customer_id, JSON.stringify(r.detail ?? {})]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle))
      );
    }
    return out;
  }, [loaded, q]);

  const actions = useMemo(() => [...new Set(loaded.map((r) => r.action))].sort(), [loaded]);

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
          <button className="btn sm" onClick={() => void audit.refetch()} disabled={audit.isFetching}>
            <Icon name="refresh" size={13} /> {audit.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
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
          <span>
            {rows.length} shown · {loaded.length} loaded
            {audit.hasNextPage ? '' : ' · end of trail'}
          </span>
          <div className="row">
            <span className="mono" style={{ fontSize: 10.5 }}>GET /admin/audit</span>
            {audit.hasNextPage ? (
              <button className="btn sm" onClick={() => void audit.fetchNextPage()} disabled={audit.isFetchingNextPage}>
                {audit.isFetchingNextPage ? 'Loading…' : `Load ${PAGE_SIZE} more`}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
