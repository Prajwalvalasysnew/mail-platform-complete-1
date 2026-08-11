import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/operations';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { ApiError, friendlyError } from '../lib/http';
import { ConfirmModal, EmptyState, ErrorState, Loading, Modal, PermissionState, Pill } from '../components/ui';
import { Icon } from '../components/icons';
import { fmtDate, fmtNum } from '../lib/format';
import type { ReconcileResult } from '../api/types';

export function BillingPage() {
  const { admin, hasRole } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirmReplay, setConfirmReplay] = useState<string | null>(null);
  const [reconcileResult, setReconcileResult] = useState<ReconcileResult | null>(null);

  const events = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'billing-events'],
    queryFn: () => api.billingEvents({ limit: 100 }),
    enabled: hasRole('operator'),
  });

  const reconcile = useMutation({
    mutationFn: api.reconcileMetering,
    onSuccess: (d) => {
      setReconcileResult(d);
      toast(d.alert === 'clean' ? 'Metering reconciled — no drift between Redis and Postgres.' : `Drift detected: ${d.total_drift} across ${d.by_customer.length} tenant(s).`, d.alert === 'clean' ? 'info' : 'error');
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  const replay = useMutation({
    mutationFn: (id: string) => api.replayBillingEvent(id),
    onSuccess: (d) => {
      toast(`Event ${d.replayed} replayed and re-applied.`);
      setConfirmReplay(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'billing-events'] });
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  if (!hasRole('operator')) return <PermissionState need="operator" />;

  const rows = events.data?.events ?? [];
  const byProvider = rows.reduce<Record<string, number>>((acc, e) => {
    const p = e.provider ?? 'stripe';
    acc[p] = (acc[p] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <div className="page-head">
        <div className="page-desc">
          Provider billing events and metering. Run reconciliation to detect drift between Redis usage counters and
          Postgres.
        </div>
        <button className="btn" onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
          <Icon name="refresh" size={13} /> {reconcile.isPending ? 'Reconciling…' : 'Reconcile metering'}
        </button>
      </div>

      {reconcileResult ? (
        <div className={`alert ${reconcileResult.alert === 'clean' ? 'blue' : 'red'}`}>
          <div className="body">
            <div className="t">
              {reconcileResult.alert === 'clean'
                ? 'Reconciliation clean — Redis counters match Postgres.'
                : `Drift detected — total ${fmtNum(reconcileResult.total_drift)} across ${reconcileResult.by_customer.length} tenant(s).`}
            </div>
            {reconcileResult.by_customer.slice(0, 5).map((c) => (
              <div key={c.customer_id} className="mono" style={{ fontSize: 11.5 }}>
                {c.customer_id}: drift {String(c.drift)}
              </div>
            ))}
          </div>
          <button className="btn sm" onClick={() => setReconcileResult(null)}>Dismiss</button>
        </div>
      ) : null}

      <div className="kpi-grid">
        {Object.entries(byProvider).map(([provider, n]) => (
          <div key={provider} className="card kpi">
            <div>
              <div className="klabel">{provider} events</div>
              <div className="kvalue">{fmtNum(n)}</div>
              <div className="kdelta">most recent 100 processed</div>
            </div>
          </div>
        ))}
        <div className="card kpi">
          <div>
            <div className="klabel">Replayable</div>
            <div className="kvalue">{fmtNum(rows.filter((r) => r.replayable).length)}</div>
            <div className="kdelta">events with stored raw payload</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-pad" style={{ paddingBottom: 8 }}>
          <div className="card-title">Provider billing events</div>
          <div className="card-sub">
            Replay re-parses the stored payload through the current provider parser and re-applies subscription state —
            admin role required.
          </div>
        </div>
        {events.isPending ? (
          <Loading label="Loading billing events…" />
        ) : events.isError ? (
          events.error instanceof ApiError && events.error.status === 403 ? (
            <PermissionState need="operator" />
          ) : (
            <div className="card-pad"><ErrorState error={events.error} retry={() => void events.refetch()} /></div>
          )
        ) : rows.length === 0 ? (
          <EmptyState title="No billing events" hint="Provider webhooks have not delivered any events yet." />
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table className="data">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Type</th>
                  <th>Provider</th>
                  <th>Processed</th>
                  <th>Replays</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.provider_event_id}>
                    <td className="mono" style={{ fontSize: 11.5, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.provider_event_id}
                    </td>
                    <td><Pill tone="outline">{e.type}</Pill></td>
                    <td><Pill tone="ghost">{e.provider ?? 'stripe'}</Pill></td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{fmtDate(e.processed_at)}</td>
                    <td>
                      {e.replay_count > 0 ? <Pill tone="amber">{e.replay_count}× replayed</Pill> : <span className="section-note">—</span>}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn sm" style={{ marginRight: 6 }} onClick={() => setDetailId(e.provider_event_id)}>
                        Inspect
                      </button>
                      {hasRole('admin') ? (
                        <button className="btn sm" disabled={!e.replayable} title={e.replayable ? '' : 'No stored payload'} onClick={() => setConfirmReplay(e.provider_event_id)}>
                          <Icon name="play" size={11} /> Replay
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-foot">
          <span>{rows.length} events</span>
          <span className="mono" style={{ fontSize: 10.5 }}>GET /admin/billing-events</span>
        </div>
      </div>

      {detailId ? <EventDetailModal id={detailId} onClose={() => setDetailId(null)} /> : null}

      {confirmReplay ? (
        <ConfirmModal
          title="Replay billing event"
          body={
            <>
              Replaying <span className="codechip">{confirmReplay}</span> re-parses the stored raw payload and re-applies
              subscription state, bypassing the idempotency guard. This mutates billing state and is audit-logged.
            </>
          }
          confirmLabel="Replay event"
          danger={false}
          busy={replay.isPending}
          onConfirm={() => replay.mutate(confirmReplay)}
          onClose={() => setConfirmReplay(null)}
        />
      ) : null}
    </>
  );
}

function EventDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { admin } = useAuth();
  const detail = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'billing-event', id],
    queryFn: () => api.billingEventDetail(id),
  });
  return (
    <Modal title="Billing event" onClose={onClose} width={640}>
      {detail.isPending ? (
        <Loading />
      ) : detail.isError ? (
        <ErrorState error={detail.error} />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12.5 }}>
            <div><span className="section-note">Event ID</span><div className="mono" style={{ fontSize: 11.5 }}>{detail.data.provider_event_id}</div></div>
            <div><span className="section-note">Type</span><div>{detail.data.type}</div></div>
            <div><span className="section-note">Provider</span><div>{detail.data.provider ?? 'stripe'}</div></div>
            <div><span className="section-note">Processed</span><div>{fmtDate(detail.data.processed_at)}</div></div>
          </div>
          <div className="field">
            <label>Raw payload</label>
            <pre
              className="mono"
              style={{ fontSize: 11, background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, maxHeight: 320, overflow: 'auto' }}
            >
              {detail.data.payload ? JSON.stringify(detail.data.payload, null, 2) : 'No stored payload (predates raw-payload storage).'}
            </pre>
          </div>
        </>
      )}
    </Modal>
  );
}
