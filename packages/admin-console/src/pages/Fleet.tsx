import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import * as api from '../api/operations';
import { useAuth } from '../auth/AuthContext';
import { ErrorState, Kpi, Loading, Meter, Pill } from '../components/ui';
import { fmtCompact, fmtDuration, fmtNum, fmtPct } from '../lib/format';

const STATUS_COLORS: Record<string, string> = {
  delivered: 'var(--blue)',
  sent: 'var(--blue)',
  queued: 'var(--amber-strong)',
  processing: 'var(--amber-strong)',
  held_for_review: 'var(--amber-strong)',
  hard_bounced: 'var(--red)',
  soft_bounced: 'var(--red)',
  failed: 'var(--red)',
  suppressed: 'var(--text-dim)',
};

export function FleetPage() {
  const { admin, hasRole } = useAuth();
  const ov = useQuery({ queryKey: ['admin', admin?.admin_user_id, 'overview'], queryFn: api.overview, refetchInterval: 30_000 });
  const review = useQuery({ queryKey: ['admin', admin?.admin_user_id, 'review-stats'], queryFn: api.reviewQueueStats, refetchInterval: 60_000 });
  const pools = useQuery({ queryKey: ['admin', admin?.admin_user_id, 'pool-health'], queryFn: api.poolHealth, refetchInterval: 60_000 });
  const sla = useQuery({ queryKey: ['admin', admin?.admin_user_id, 'sla-breaches'], queryFn: api.slaBreaches, refetchInterval: 60_000 });
  const dlq = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'dlq-count'],
    queryFn: () => api.listDlq({ limit: 1 }),
    enabled: hasRole('operator'),
    refetchInterval: 120_000,
  });

  if (ov.isPending) return <Loading label="Loading fleet overview…" />;
  if (ov.isError) return <ErrorState error={ov.error} retry={() => void ov.refetch()} />;

  const o = ov.data;
  const activeTenants = o.customers_by_status['active'] ?? 0;
  const pendingTenants = o.customers_by_status['pending'] ?? 0;
  const suspendedTenants = o.customers_by_status['suspended'] ?? 0;
  const totalTenants = Object.values(o.customers_by_status).reduce((a, b) => a + b, 0);
  const queue = o.send_queue;
  const queueWaiting = queue.waiting ?? 0;

  const byStatus = Object.entries(o.messages_24h.by_status).sort((a, b) => b[1] - a[1]);
  const maxStatus = Math.max(...byStatus.map(([, v]) => v), 1);

  const badPools = (pools.data?.pools ?? []).filter((p) => p.action !== 'ok');

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Messages (24h)" value={fmtCompact(o.messages_24h.total)} sub="all statuses, platform-wide" />
        <Kpi label="Delivery rate" value={fmtPct(o.rates_24h.delivery_rate)} tone="green" sub="last 24 hours" />
        <Kpi label="Bounce rate" value={fmtPct(o.rates_24h.bounce_rate)} tone={o.rates_24h.bounce_rate > 0.05 ? 'red' : 'plain'} sub="hard + soft, last 24h" />
        <Kpi label="Active tenants" value={fmtNum(activeTenants)} sub={`${fmtNum(totalTenants)} total`} />
        <Kpi label="Suppressions" value={fmtNum(o.suppressions_total)} sub="platform-wide list" />
        <Kpi label="Send queue" value={fmtNum(queueWaiting)} tone={queueWaiting > 100 ? 'red' : 'plain'} sub="jobs waiting" />
      </div>

      {/* Derived operational alerts */}
      {o.rates_24h.bounce_rate > 0.05 ? (
        <div className="alert red">
          <div className="body">
            <div className="t">High platform bounce rate — {fmtPct(o.rates_24h.bounce_rate)} over last 24h</div>
            Auto-hold thresholds may be triggering. Review flagged senders in the abuse queue.
          </div>
          <Link to="/abuse" className="btn sm">View abuse queue</Link>
        </div>
      ) : null}
      {queueWaiting > 100 ? (
        <div className="alert amber">
          <div className="body">
            <div className="t">Send queue depth elevated — {fmtNum(queueWaiting)} waiting</div>
            Normal threshold is &lt;100. No delivery failures yet; monitor closely.
          </div>
        </div>
      ) : null}
      {badPools.map((p) => (
        <div key={p.pool} className={`alert ${p.action === 'pause' ? 'red' : 'amber'}`}>
          <div className="body">
            <div className="t">
              IP pool “{p.pool}” — recommended action: {p.action}
            </div>
            {p.reasons.join(' · ') || `bounce ${fmtPct(p.bounce_rate)} · complaint ${fmtPct(p.complaint_rate, 3)}`}
          </div>
          <Link to="/pools" className="btn sm">View pools</Link>
        </div>
      ))}

      <div className="grid2">
        <div className="card">
          <div className="card-pad" style={{ paddingBottom: 8 }}>
            <div className="card-title">Message volume — last 24h</div>
            <div className="card-sub">by delivery status</div>
          </div>
          <div style={{ padding: '4px 18px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {byStatus.length === 0 ? (
              <div className="empty-state">No messages in the last 24 hours.</div>
            ) : (
              byStatus.map(([status, count]) => (
                <div key={status} className="row">
                  <span style={{ width: 120, fontSize: 11.5, color: 'var(--text-mid)', fontFamily: 'var(--font-mono)' }}>{status}</span>
                  <Meter fraction={count / maxStatus} color={STATUS_COLORS[status] ?? 'var(--blue)'} />
                  <span className="mono" style={{ width: 70, textAlign: 'right', fontSize: 11.5 }}>{fmtNum(count)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-pad" style={{ paddingBottom: 8 }}>
              <div className="card-title">Queue depth</div>
            </div>
            <div style={{ padding: '0 18px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(['waiting', 'active', 'delayed', 'failed'] as const).map((k) => {
                const v = queue[k] ?? 0;
                const color = k === 'failed' ? 'var(--red)' : k === 'waiting' ? 'var(--blue)' : 'var(--green)';
                return (
                  <div key={k} className="row">
                    <span className="mono" style={{ width: 80, fontSize: 11.5, fontWeight: 600 }}>{k}</span>
                    <Meter fraction={Math.min(1, v / Math.max(queueWaiting, 50))} color={color} />
                    <span className="mono" style={{ width: 56, textAlign: 'right', fontSize: 11.5, color: k === 'failed' && v > 0 ? 'var(--red-text)' : undefined }}>
                      {fmtNum(v)}
                    </span>
                  </div>
                );
              })}
              {hasRole('operator') ? (
                <div className="row" style={{ justifyContent: 'space-between', paddingTop: 4, borderTop: '1px solid var(--border-soft)' }}>
                  <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>Dead-letter queue</span>
                  {dlq.data && dlq.data.total > 0 ? (
                    <Link to="/dlq"><Pill tone="red">{fmtNum(dlq.data.total)} dead</Pill></Link>
                  ) : (
                    <Pill tone="green">empty</Pill>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          <div className="card">
            <div className="card-pad" style={{ paddingBottom: 8 }}>
              <div className="card-title">Tenant status</div>
            </div>
            <div style={{ padding: '0 18px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                ['Active', activeTenants, 'var(--green)'],
                ['Pending', pendingTenants, 'var(--amber-strong)'],
                ['Suspended', suspendedTenants, 'var(--red)'],
              ].map(([label, v, color]) => (
                <div key={label as string} className="row">
                  <span className="dot" style={{ background: color as string }} />
                  <span style={{ width: 90, fontSize: 12 }}>{label}</span>
                  <Meter fraction={(v as number) / Math.max(totalTenants, 1)} color={color as string} />
                  <span className="mono" style={{ width: 64, textAlign: 'right', fontSize: 11.5, fontWeight: 700 }}>{fmtNum(v as number)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="card-pad row" style={{ justifyContent: 'space-between', paddingBottom: 8 }}>
            <div className="card-title">Abuse review queue</div>
            <Link to="/abuse" className="btn sm">Open queue</Link>
          </div>
          <div style={{ padding: '0 18px 16px' }}>
            {review.isError ? (
              <div className="section-note">Review stats unavailable for your role.</div>
            ) : review.data ? (
              <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
                <div><div className="kpi klabel">Pending</div><div style={{ fontSize: 20, fontWeight: 800, color: review.data.pending > 0 ? 'var(--red-text)' : 'var(--text-strong)' }}>{review.data.pending}</div></div>
                <div><div className="kpi klabel">Approved today</div><div style={{ fontSize: 20, fontWeight: 800, color: 'var(--green-text)' }}>{review.data.approved_today}</div></div>
                <div><div className="kpi klabel">Rejected today</div><div style={{ fontSize: 20, fontWeight: 800, color: 'var(--red-text)' }}>{review.data.rejected_today}</div></div>
                <div><div className="kpi klabel">Avg risk</div><div style={{ fontSize: 20, fontWeight: 800 }}>{review.data.avg_risk_score}</div></div>
                <div><div className="kpi klabel">Oldest pending</div><div style={{ fontSize: 20, fontWeight: 800 }}>{fmtDuration(review.data.oldest_pending_seconds)}</div></div>
              </div>
            ) : (
              <Loading />
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-pad row" style={{ justifyContent: 'space-between', paddingBottom: 8 }}>
            <div className="card-title">SLA breaches</div>
            <Link to="/support" className="btn sm">Support inbox</Link>
          </div>
          <div style={{ padding: '0 18px 16px' }}>
            {sla.data && sla.data.breaches.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sla.data.breaches.slice(0, 5).map((t) => (
                  <div key={t.id} className="row" style={{ justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.subject}</span>
                    <Pill tone="red">{t.priority}</Pill>
                  </div>
                ))}
              </div>
            ) : (
              <div className="section-note">No SLA breaches — support queue is healthy.</div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
