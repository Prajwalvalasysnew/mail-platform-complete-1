import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/operations';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { EmptyState, ErrorState, Kpi, Loading, Pill, RiskPill } from '../components/ui';
import { friendlyError } from '../lib/http';
import { fmtAgo, fmtDuration, fmtNum } from '../lib/format';
import type { ReviewQueueItem } from '../api/types';

function flagsOf(item: ReviewQueueItem): string[] {
  if (Array.isArray(item.reasons)) return item.reasons;
  if (typeof item.reasons === 'string' && item.reasons) {
    try {
      const parsed = JSON.parse(item.reasons);
      return Array.isArray(parsed) ? parsed : [item.reasons];
    } catch {
      return item.reasons.split(',').map((s) => s.trim());
    }
  }
  return [];
}

export function AbusePage() {
  const { admin, hasRole } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canAct = hasRole('operator');
  const [minScore, setMinScore] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());

  const stats = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'review-stats'],
    queryFn: api.reviewQueueStats,
    refetchInterval: 30_000,
  });
  const queue = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'review-queue', { minScore }],
    queryFn: () => api.reviewQueue({ limit: 100, min_score: minScore ? Number(minScore) : undefined }),
    refetchInterval: 30_000,
  });

  const invalidate = () => {
    setChecked(new Set());
    void queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'review-queue'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'review-stats'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'badges', 'review-stats'] });
  };

  const single = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'approve' | 'reject' }): Promise<unknown> =>
      action === 'approve' ? api.approveReview(id) : api.rejectReview(id),
    onSuccess: (_d, v) => {
      toast(v.action === 'approve' ? 'Message approved — released for sending.' : 'Message rejected — marked failed.');
      invalidate();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  const bulk = useMutation({
    mutationFn: (action: 'approve' | 'reject') => api.bulkReview({ action, ids: [...checked] }),
    onSuccess: (d) => {
      toast(`Bulk ${d.action}: ${d.processed} item(s) processed.`);
      invalidate();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  const items = queue.data?.items ?? [];
  const allChecked = items.length > 0 && items.every((i) => checked.has(i.id));

  return (
    <>
      <div className="page-head">
        <div className="page-desc">
          Messages flagged by automated risk scoring (<span className="codechip">score ≥ 30</span> = review,{' '}
          <span className="codechip">≥ 60</span> = block). Every action is audit-logged.
        </div>
        <Pill tone="red">
          <span className="dot red" style={{ marginRight: 4 }} /> AUTO-SCORING LIVE
        </Pill>
      </div>

      <div className="kpi-grid">
        <Kpi label="Pending review" value={stats.data ? fmtNum(stats.data.pending) : '…'} tone={stats.data && stats.data.pending > 0 ? 'red' : 'plain'} />
        <Kpi label="Approved today" value={stats.data ? fmtNum(stats.data.approved_today) : '…'} tone="green" />
        <Kpi label="Rejected today" value={stats.data ? fmtNum(stats.data.rejected_today) : '…'} tone="red" />
        <Kpi label="Avg risk score" value={stats.data?.avg_risk_score ?? '…'} />
        <Kpi label="Oldest pending" value={stats.data ? fmtDuration(stats.data.oldest_pending_seconds) : '…'} />
      </div>

      <div className="card">
        <div className="card-pad row" style={{ justifyContent: 'space-between', paddingBottom: 10 }}>
          <div className="row">
            <div className="card-title">Review queue</div>
            {items.length ? <Pill tone="red">{items.length} flagged</Pill> : null}
          </div>
          <div className="row">
            <select className="select" style={{ width: 150 }} value={minScore} onChange={(e) => setMinScore(e.target.value)} aria-label="Minimum risk score">
              <option value="">Any score</option>
              <option value="30">Score ≥ 30</option>
              <option value="60">Score ≥ 60</option>
              <option value="80">Score ≥ 80</option>
            </select>
            {canAct && checked.size > 0 ? (
              <>
                <button className="btn sm success" disabled={bulk.isPending} onClick={() => bulk.mutate('approve')}>
                  Approve {checked.size}
                </button>
                <button className="btn sm danger" disabled={bulk.isPending} onClick={() => bulk.mutate('reject')}>
                  Reject {checked.size}
                </button>
              </>
            ) : null}
          </div>
        </div>

        {queue.isPending ? (
          <Loading label="Loading review queue…" />
        ) : queue.isError ? (
          <div className="card-pad"><ErrorState error={queue.error} retry={() => void queue.refetch()} /></div>
        ) : items.length === 0 ? (
          <EmptyState title="Queue is clear" hint="No messages are waiting for review." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  {canAct ? (
                    <th style={{ width: 34 }}>
                      <input
                        type="checkbox"
                        checked={allChecked}
                        onChange={(e) => setChecked(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())}
                        aria-label="Select all"
                      />
                    </th>
                  ) : null}
                  <th>Message</th>
                  <th>Tenant</th>
                  <th className="num">Risk score</th>
                  <th>Classifier flags</th>
                  <th>Flagged</th>
                  {canAct ? <th style={{ textAlign: 'right' }}>Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    {canAct ? (
                      <td>
                        <input
                          type="checkbox"
                          checked={checked.has(item.id)}
                          onChange={(e) => {
                            const next = new Set(checked);
                            if (e.target.checked) next.add(item.id);
                            else next.delete(item.id);
                            setChecked(next);
                          }}
                          aria-label={`Select ${item.message_id}`}
                        />
                      </td>
                    ) : null}
                    <td className="mono" style={{ fontSize: 11.5 }}>{item.message_id.slice(0, 16)}…</td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{item.customer_id.slice(0, 8)}…</td>
                    <td className="num"><RiskPill score={item.risk_score} /></td>
                    <td>
                      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                        {flagsOf(item).map((f, i) => (
                          <Pill key={i} tone="outline">{f}</Pill>
                        ))}
                      </div>
                    </td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{fmtAgo(item.created_at)}</td>
                    {canAct ? (
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button
                          className="btn sm success"
                          style={{ marginRight: 6 }}
                          disabled={single.isPending}
                          onClick={() => single.mutate({ id: item.id, action: 'approve' })}
                        >
                          Approve
                        </button>
                        <button className="btn sm danger" disabled={single.isPending} onClick={() => single.mutate({ id: item.id, action: 'reject' })}>
                          Reject
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!canAct ? (
          <div className="table-foot">Approve/reject requires the operator role — you have read-only access.</div>
        ) : null}
      </div>
    </>
  );
}
