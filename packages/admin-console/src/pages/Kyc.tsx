import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/operations';
import type { KycLevel, KycRow, KycStatus } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { friendlyError } from '../lib/http';
import { EmptyState, ErrorState, Loading, Modal, Pill, PlanPill, StatusPill } from '../components/ui';
import { fmtAgo } from '../lib/format';

/**
 * KYC / verification decisions.
 *
 * Backed by the /admin/kyc/* decision endpoints: operators can approve
 * (optionally raising the verification level), request more information, or
 * reject — each decision is audited and stamps reviewer + timestamp.
 */

const STATUS_TONE: Record<KycStatus, 'green' | 'red' | 'amber' | 'blue' | 'ghost'> = {
  approved: 'green',
  rejected: 'red',
  pending: 'amber',
  more_info: 'blue',
  none: 'ghost',
};

const STATUS_LABEL: Record<KycStatus, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  pending: 'Pending review',
  more_info: 'More info requested',
  none: 'Not submitted',
};

type Decision = 'approve' | 'request-info' | 'reject';

export function KycPage() {
  const { admin, hasRole } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<KycStatus | 'open' | 'all'>('open');
  const [cursors, setCursors] = useState<string[]>([]);
  const before = cursors.at(-1);
  const [decide, setDecide] = useState<{ row: KycRow; decision: Decision } | null>(null);

  const list = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'kyc', { status, before }],
    queryFn: () => api.kycList({ status, limit: 50, before }),
    placeholderData: keepPreviousData,
  });

  const canDecide = hasRole('operator');
  const rows = list.data?.customers ?? [];
  const counts = list.data?.counts_by_status ?? {};
  const openCount = (counts.pending ?? 0) + (counts.more_info ?? 0);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'kyc'] });

  return (
    <>
      <div className="page-head">
        <div className="page-desc">Sender verification per tenant — approve, request more info, or reject. Higher levels unlock higher quotas and dedicated IPs.</div>
        <div className="row">
          {openCount > 0 ? <Pill tone="amber">{openCount} awaiting decision</Pill> : <Pill tone="green">queue clear</Pill>}
          <select className="select" style={{ width: 180 }} value={status} onChange={(e) => { setStatus(e.target.value as typeof status); setCursors([]); }} aria-label="Filter KYC status">
            <option value="open">Needs decision</option>
            <option value="all">All tenants</option>
            <option value="pending">Pending</option>
            <option value="more_info">More info requested</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="none">Not submitted</option>
          </select>
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
            <div className="table-wrap" tabIndex={0}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Tenant</th>
                    <th>Plan</th>
                    <th>Account</th>
                    <th>KYC level</th>
                    <th>Decision</th>
                    <th>Updated</th>
                    {canDecide ? <th style={{ textAlign: 'right' }}>Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <div className="cell-main">{c.email}</div>
                        <div className="cell-sub mono">{c.name ?? `${c.id.slice(0, 8)}…`}</div>
                      </td>
                      <td><PlanPill tier={c.tier} /></td>
                      <td><StatusPill status={c.account_status} /></td>
                      <td><Pill tone="outline">{c.kyc_level}</Pill></td>
                      <td>
                        <Pill tone={STATUS_TONE[c.kyc_status] ?? 'ghost'}>{STATUS_LABEL[c.kyc_status] ?? c.kyc_status}</Pill>
                        {c.kyc_note ? (
                          <div className="section-note" style={{ marginTop: 4, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.kyc_note}>
                            {c.kyc_note}
                          </div>
                        ) : null}
                      </td>
                      <td style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{fmtAgo(c.kyc_reviewed_at ?? c.updated_at)}</td>
                      {canDecide ? (
                        <td>
                          <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                            <button className="btn sm" disabled={c.kyc_status === 'approved'} onClick={() => setDecide({ row: c, decision: 'approve' })}>Approve</button>
                            <button className="btn sm" onClick={() => setDecide({ row: c, decision: 'request-info' })}>More info</button>
                            <button className="btn sm danger" disabled={c.kyc_status === 'rejected'} onClick={() => setDecide({ row: c, decision: 'reject' })}>Reject</button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot">
              <span>{rows.length} tenants{!canDecide ? ' · decisions require operator role' : ''}</span>
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

      {decide ? (
        <KycDecisionModal
          row={decide.row}
          decision={decide.decision}
          onDone={() => { setDecide(null); void invalidate(); }}
          onClose={() => setDecide(null)}
          notify={toast}
        />
      ) : null}
    </>
  );
}

function KycDecisionModal({
  row,
  decision,
  onDone,
  onClose,
  notify,
}: {
  row: KycRow;
  decision: Decision;
  onDone: () => void;
  onClose: () => void;
  notify: ReturnType<typeof useToast>;
}) {
  const [note, setNote] = useState('');
  const [level, setLevel] = useState<KycLevel | ''>('');
  const noteRequired = decision !== 'approve';

  const titles: Record<Decision, string> = {
    approve: `Approve verification — ${row.email}`,
    'request-info': `Request more information — ${row.email}`,
    reject: `Reject verification — ${row.email}`,
  };

  const run = useMutation({
    mutationFn: () => {
      if (decision === 'approve') return api.kycApprove(row.id, { note: note.trim() || undefined, level: level || undefined });
      if (decision === 'request-info') return api.kycRequestInfo(row.id, { note: note.trim() });
      return api.kycReject(row.id, { note: note.trim() });
    },
    onSuccess: (d) => {
      notify(
        decision === 'approve'
          ? `Approved — ${row.email} is now level "${d.kyc_level}".`
          : decision === 'request-info'
            ? `More information requested from ${row.email}.`
            : `Verification rejected for ${row.email}.`
      );
      onDone();
    },
    onError: (e) => notify(friendlyError(e), 'error'),
  });

  return (
    <Modal title={titles[decision]} onClose={onClose} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {decision === 'approve' ? (
          <div className="field">
            <label>Verification level</label>
            <select className="select" value={level} onChange={(e) => setLevel(e.target.value as KycLevel | '')} aria-label="Verification level">
              <option value="">Keep current ({row.kyc_level})</option>
              <option value="domain">domain</option>
              <option value="payment">payment</option>
              <option value="business">business</option>
            </select>
          </div>
        ) : null}
        <div className="field">
          <label>{noteRequired ? 'Note (required — shared with the tenant)' : 'Note (optional)'}</label>
          <textarea
            className="input"
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              decision === 'request-info'
                ? 'What additional documentation or detail is needed?'
                : decision === 'reject'
                  ? 'Why is this verification being rejected?'
                  : 'Internal context for this approval…'
            }
            aria-label="Decision note"
          />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={onClose} disabled={run.isPending}>Cancel</button>
          <button
            className={decision === 'reject' ? 'btn danger-solid' : 'btn primary'}
            disabled={run.isPending || (noteRequired && !note.trim())}
            onClick={() => run.mutate()}
          >
            {run.isPending ? 'Saving…' : decision === 'approve' ? 'Approve' : decision === 'request-info' ? 'Request info' : 'Reject'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
