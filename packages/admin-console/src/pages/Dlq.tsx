import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/operations';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { ApiError, friendlyError } from '../lib/http';
import { ConfirmModal, EmptyState, ErrorState, Kpi, Loading, Modal, PermissionState, Pill } from '../components/ui';
import { Icon } from '../components/icons';
import { fmtAgo, fmtNum } from '../lib/format';

const PAGE = 50;

export function DlqPage() {
  const { admin, hasRole } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);

  const list = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'dlq', { offset }],
    queryFn: () => api.listDlq({ limit: PAGE, offset }),
    enabled: hasRole('operator'),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'dlq'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'badges', 'dlq'] });
  };

  const replay = useMutation({
    mutationFn: (id: string) => api.replayDlq(id),
    onSuccess: (d) => {
      toast(`Job re-enqueued to ${d.source_queue}${d.new_job_id ? ` (new job ${d.new_job_id})` : ''}.`);
      invalidate();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteDlq(id),
    onSuccess: () => {
      toast('Dead-letter job discarded.');
      setDeleteId(null);
      invalidate();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  const purge = useMutation({
    mutationFn: api.purgeDlq,
    onSuccess: (d) => {
      toast(`Purged ${d.purged} dead-letter job(s).`);
      setPurgeOpen(false);
      invalidate();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  if (!hasRole('operator')) return <PermissionState need="operator" />;

  const jobs = list.data?.jobs ?? [];
  const total = list.data?.total ?? 0;
  const byQueue = jobs.reduce<Record<string, number>>((acc, j) => {
    acc[j.source_queue] = (acc[j.source_queue] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <div className="page-head">
        <div className="page-desc">
          Jobs that have exhausted all retry attempts are parked here. Inspect the failure reason, then <b>replay</b> to
          re-enqueue or <b>purge</b> to discard permanently. All actions are audit-logged.
        </div>
        <button className="btn danger" onClick={() => setPurgeOpen(true)} disabled={total === 0}>
          <Icon name="trash" size={13} /> Purge all
        </button>
      </div>

      <div className="kpi-grid">
        <Kpi label="Total dead" value={fmtNum(total)} tone={total > 0 ? 'red' : 'plain'} />
        {Object.entries(byQueue).map(([q, n]) => (
          <Kpi key={q} label={q} value={fmtNum(n)} sub="on this page" />
        ))}
      </div>

      <div className="card">
        <div className="card-pad" style={{ paddingBottom: 8 }}>
          <div className="card-title">Failed jobs</div>
        </div>
        {list.isPending ? (
          <Loading label="Loading dead-letter queue…" />
        ) : list.isError ? (
          list.error instanceof ApiError && list.error.status === 403 ? (
            <PermissionState need="operator" />
          ) : (
            <div className="card-pad"><ErrorState error={list.error} retry={() => void list.refetch()} /></div>
          )
        ) : jobs.length === 0 ? (
          <EmptyState title="Dead-letter queue is empty" hint="No failed jobs are parked — the pipeline is healthy." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Queue</th>
                  <th>Failure reason</th>
                  <th className="num">Attempts</th>
                  <th>Age</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <button className="mono" style={{ fontSize: 11.5, color: 'var(--blue-text)', textDecoration: 'underline' }} onClick={() => setDetailId(j.id)}>
                        {j.id}
                      </button>
                      {j.original_job_id ? <div className="cell-sub mono">orig {j.original_job_id}</div> : null}
                    </td>
                    <td><Pill tone="outline">{j.source_queue}</Pill></td>
                    <td style={{ fontSize: 11.5, color: 'var(--red-text)', maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={j.failed_reason}>
                      {j.failed_reason}
                    </td>
                    <td className="num">{j.attempts_made}</td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{fmtAgo(j.dead_lettered_at)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn sm" style={{ marginRight: 6 }} disabled={replay.isPending} onClick={() => replay.mutate(j.id)}>
                        <Icon name="play" size={11} /> Replay
                      </button>
                      <button className="btn sm danger" onClick={() => setDeleteId(j.id)} aria-label={`Discard ${j.id}`}>
                        <Icon name="trash" size={11} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-foot">
          <span>
            {fmtNum(total)} jobs · replays re-enqueue at original priority · purge is irreversible
          </span>
          <div className="row">
            <span className="mono" style={{ fontSize: 10.5 }}>GET /admin/dlq</span>
            <button className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>← Prev</button>
            <button className="btn sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next →</button>
          </div>
        </div>
      </div>

      <div className="card card-pad">
        <div className="card-title" style={{ fontSize: 13, marginBottom: 6 }}>How the DLQ works</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-mid)', lineHeight: 1.6 }}>
          BullMQ moves a job to the dead-letter queue after it exhausts its retry backoff schedule. Each queue (
          <span className="codechip">send</span>, <span className="codechip">webhooks</span>,{' '}
          <span className="codechip">events</span>) has a separate DLQ. <b>Replay</b> calls{' '}
          <span className="codechip">POST /admin/dlq/:id/replay</span> and re-enqueues the job with its original data.{' '}
          <b>Purge all</b> requires <span className="codechip">{'{ "confirm": true }'}</span> in the request body as a
          safeguard.
        </div>
      </div>

      {detailId ? <DlqDetailModal id={detailId} onClose={() => setDetailId(null)} /> : null}

      {deleteId ? (
        <ConfirmModal
          title="Discard dead-letter job"
          body={
            <>
              Permanently delete job <span className="codechip">{deleteId}</span>? The job data cannot be recovered and
              the original work will NOT be performed.
            </>
          }
          confirmLabel="Discard job"
          busy={del.isPending}
          onConfirm={() => del.mutate(deleteId)}
          onClose={() => setDeleteId(null)}
        />
      ) : null}

      {purgeOpen ? (
        <ConfirmModal
          title="Purge entire dead-letter queue"
          body={
            <>
              This permanently discards all <b>{fmtNum(total)}</b> dead-lettered jobs across every queue. None of the
              failed work will be retried. This cannot be undone.
            </>
          }
          confirmLabel="Purge all jobs"
          confirmWord="PURGE"
          busy={purge.isPending}
          onConfirm={() => purge.mutate()}
          onClose={() => setPurgeOpen(false)}
        />
      ) : null}
    </>
  );
}

function DlqDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { admin } = useAuth();
  const detail = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'dlq-job', id],
    queryFn: () => api.dlqDetail(id),
  });
  return (
    <Modal title={`Dead-letter job ${id}`} onClose={onClose} width={640}>
      {detail.isPending ? (
        <Loading />
      ) : detail.isError ? (
        <ErrorState error={detail.error} />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12.5 }}>
            <div><span className="section-note">Source queue</span><div>{detail.data.job.source_queue}</div></div>
            <div><span className="section-note">State</span><div>{detail.data.job.state}</div></div>
            <div><span className="section-note">Attempts</span><div>{detail.data.job.attempts_made}</div></div>
            <div><span className="section-note">Dead-lettered</span><div>{fmtAgo(detail.data.job.dead_lettered_at)}</div></div>
          </div>
          <div className="field">
            <label>Failure reason</label>
            <div className="alert red" style={{ padding: '8px 12px' }}>
              <div className="body mono" style={{ fontSize: 11.5 }}>{detail.data.job.failed_reason}</div>
            </div>
          </div>
          <div className="field">
            <label>Payload</label>
            <pre className="mono" style={{ fontSize: 11, background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, maxHeight: 300, overflow: 'auto' }}>
              {JSON.stringify(detail.data.job.payload, null, 2)}
            </pre>
          </div>
        </>
      )}
    </Modal>
  );
}
