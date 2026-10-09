import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import * as api from '../api/operations';
import type { TimeseriesDay } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorState, Kpi, Loading, Meter, Pill, PlanPill } from '../components/ui';
import { fmtCompact, fmtNum, fmtPct } from '../lib/format';

export function FleetPage() {
  const { admin, hasRole } = useAuth();
  const key = ['admin', admin?.admin_user_id];
  const ov = useQuery({ queryKey: [...key, 'overview'], queryFn: api.overview, refetchInterval: 30_000 });
  const pools = useQuery({ queryKey: [...key, 'pool-health'], queryFn: api.poolHealth, refetchInterval: 60_000 });
  const timeseries = useQuery({ queryKey: [...key, 'timeseries', 7], queryFn: () => api.overviewTimeseries(7), refetchInterval: 60_000 });
  const top = useQuery({ queryKey: [...key, 'top-tenants'], queryFn: () => api.topTenants({ hours: 168, limit: 6 }), refetchInterval: 60_000 });
  const review = useQuery({ queryKey: [...key, 'review-stats'], queryFn: api.reviewQueueStats, refetchInterval: 60_000 });
  const dlq = useQuery({ queryKey: [...key, 'dlq-count'], queryFn: () => api.listDlq({ limit: 1 }), enabled: hasRole('operator'), refetchInterval: 120_000 });

  if (ov.isPending) return <Loading label="Loading fleet overview…" />;
  if (ov.isError) return <ErrorState error={ov.error} retry={() => void ov.refetch()} />;

  const o = ov.data;
  const active = o.customers_by_status.active ?? 0;
  const pending = o.customers_by_status.pending ?? 0;
  const suspended = o.customers_by_status.suspended ?? 0;
  const totalTenants = Object.values(o.customers_by_status).reduce((sum, value) => sum + value, 0);
  const queue = o.send_queue;
  const history = timeseries.data?.series ?? [];
  const badPools = (pools.data?.pools ?? []).filter((pool) => pool.action !== 'ok');
  const failedJobs = queue.failed ?? 0;
  const dlqTotal = dlq.data?.total ?? 0;
  const health = [
    { name: 'API', badge: 'OK', detail: 'online', warn: false },
    { name: 'Send worker', badge: failedJobs ? 'WARN' : 'OK', detail: `${fmtNum(failedJobs)} failed`, warn: failedJobs > 0 },
    { name: 'Event worker', badge: 'OK', detail: 'online', warn: false },
    { name: 'Tracker', badge: 'OK', detail: 'online', warn: false },
    { name: 'Haraka outbound', badge: badPools.length ? 'WARN' : 'OK', detail: badPools.length ? `${badPools.length} pool alert` : 'healthy', warn: badPools.length > 0 },
    { name: 'PostgreSQL', badge: 'OK', detail: 'connected', warn: false },
    { name: 'Redis', badge: 'OK', detail: 'connected', warn: false },
  ];
  const warnings = health.filter((item) => item.warn).length;

  return (
    <>
      <div className="kpi-grid fleet-kpis">
        <Kpi label="Messages today" value={fmtCompact(o.messages_24h.total)} sub="last 24 hours" spark={history.map((d) => d.total)} />
        <Kpi label="Delivery rate" value={fmtPct(o.rates_24h.delivery_rate)} tone="green" sub="platform-wide" spark={history.map((d) => d.total ? d.delivered / d.total : 0)} />
        <Kpi label="Bounce rate" value={fmtPct(o.rates_24h.bounce_rate)} tone={o.rates_24h.bounce_rate > .05 ? 'red' : 'plain'} sub="hard + soft" spark={history.map((d) => d.total ? d.bounced / d.total : 0)} />
        <Kpi label="Platform MRR" value={formatMoneyCompact(o.platform_mrr_cents)} sub="current billing period" />
        <Kpi label="Active tenants" value={fmtNum(active)} sub={`${fmtNum(totalTenants)} total`} />
        <Kpi label="Suppressions" value={fmtNum(o.suppressions_total)} sub="platform-wide list" />
      </div>

      <div className="health-strip card">
        <div className="health-summary"><small>Platform</small><strong className={warnings ? 'warn' : 'ok'}><span className="dot" />{warnings ? `${warnings} warn` : 'Healthy'}</strong></div>
        <div className="health-services" role="region" aria-label="Platform service health" tabIndex={0}>
          {health.map((item) => <div className={item.warn ? 'health-service warning' : 'health-service'} key={item.name}><span className={item.warn ? 'dot amber' : 'dot green'} /><div><b>{item.name}</b><div><em>{item.badge}</em><span>{item.detail}</span></div></div></div>)}
        </div>
      </div>

      <div className="fleet-primary-grid">
        <section className="card volume-card">
          <div className="fleet-card-head"><div><h3>Platform volume — last 7 days</h3><p>Delivered (solid) vs bounced (orange)</p></div></div>
          {timeseries.isPending ? <Loading label="Loading volume history…" /> : history.every((d) => d.total === 0) ? <div className="empty-state">No messages sent in the last 7 days.</div> : <VolumeChart series={history} />}
        </section>
        <aside className="fleet-side-stack">
          <section className="card compact-panel"><h3>Queue depth</h3>{[
            ['waiting', queue.waiting ?? 0, 'var(--blue)'], ['active', queue.active ?? 0, 'var(--green)'], ['delayed', queue.delayed ?? 0, 'var(--amber-strong)'], ['failed', failedJobs, 'var(--red)'],
          ].map(([label, value, color]) => <div className="queue-row" key={String(label)}><div><b>{label}</b><span style={{ color: String(color) }}>{fmtNum(Number(value))}</span></div><Meter fraction={Number(value) / Math.max(queue.waiting ?? 0, failedJobs, 1)} color={String(color)} /></div>)}
          {hasRole('operator') && <div className="dlq-row"><span>Dead-letter queue</span><Pill tone={dlqTotal ? 'red' : 'green'}>{dlqTotal ? `${fmtNum(dlqTotal)} dead` : 'empty'}</Pill></div>}</section>
          <section className="card compact-panel"><h3>Tenant status</h3>{[['Active', active, 'var(--green)'], ['Pending', pending, 'var(--amber-strong)'], ['Suspended', suspended, 'var(--red)']].map(([label, value, color]) => <div className="tenant-status-row" key={String(label)}><span className="dot" style={{ background: String(color) }} /><span>{label}</span><Meter fraction={Number(value) / Math.max(totalTenants, 1)} color={String(color)} /><b>{fmtNum(Number(value))}</b></div>)}</section>
        </aside>
      </div>

      {(failedJobs > 0 || badPools.length > 0 || (review.data?.pending ?? 0) > 0) && <div className="fleet-alerts">
        {failedJobs > 0 && <div className="alert amber"><div className="alert-icon">!</div><div className="body"><div className="t">Send queue has {fmtNum(failedJobs)} failed jobs</div>Inspect and replay failed work from the dead-letter queue.</div><Link to="/dlq" className="btn sm">View queue</Link></div>}
        {badPools.slice(0, 1).map((pool) => <div className="alert red" key={pool.pool}><div className="alert-icon">!</div><div className="body"><div className="t">IP pool “{pool.pool}” requires attention</div>{pool.reasons.join(' · ') || `Recommended action: ${pool.action}`}</div><Link to="/pools" className="btn sm">View IP pools</Link></div>)}
      </div>}

      <div className="fleet-bottom-grid">
        <section className="card top-tenants-card"><div className="fleet-card-head"><h3>Top tenants by volume</h3><Link to="/tenants" className="btn sm">View all →</Link></div>
          {top.isPending ? <Loading /> : !top.data?.tenants.length ? <div className="empty-state">No tenant send activity in the last 7 days.</div> : <div className="table-wrap"><table className="data"><thead><tr><th>Tenant</th><th>Plan</th><th className="num">Msgs 7d</th><th className="num">Bounce %</th><th>Risk</th></tr></thead><tbody>{top.data.tenants.map((t) => <tr key={t.customer_id}><td><div className="cell-main">{t.name ?? t.email}</div><div className="cell-sub mono">{t.email}</div></td><td><PlanPill tier={t.tier} /></td><td className="num">{fmtNum(t.total)}</td><td className="num" style={{ color: t.bounce_rate > .05 ? 'var(--red-text)' : undefined }}>{fmtPct(t.bounce_rate)}</td><td><Pill tone={t.bounce_rate > .05 ? 'red' : t.bounce_rate > .02 ? 'amber' : 'green'}>{t.bounce_rate > .05 ? 'high' : t.bounce_rate > .02 ? 'medium' : 'low'}</Pill></td></tr>)}</tbody></table></div>}
        </section>
        <section className="card recent-events"><div className="fleet-card-head"><h3>Recent events</h3></div>{[
          ['!', 'Failed queue jobs', `${fmtNum(failedJobs)} jobs require review`], ['✓', 'Active tenants', `${fmtNum(active)} accounts sending`], ['⚠', 'Abuse review queue', `${fmtNum(review.data?.pending ?? 0)} pending`], ['+', 'Suppressions', `${fmtNum(o.suppressions_total)} total entries`],
        ].map(([icon, label, detail]) => <div className="event-row" key={label}><i>{icon}</i><div><b>{label}</b><span>{detail}</span></div></div>)}</section>
      </div>
    </>
  );
}

function VolumeChart({ series }: { series: TimeseriesDay[] }) {
  const deliveredMax = Math.max(...series.map((d) => d.delivered), 1);
  const bouncedMax = Math.max(...series.map((d) => d.bounced), 1);
  return <div className="fleet-volume-chart"><div className="chart-legend"><span><i style={{ background: 'var(--blue)' }} />Delivered</span><span><i style={{ background: 'var(--red)' }} />Bounced</span></div><div className="chart-plot"><div className="chart-grid"><i /><i /><i /></div>{series.map((d) => <div key={d.day} className="chart-column" title={`${d.day}: ${fmtNum(d.delivered)} delivered · ${fmtNum(d.bounced)} bounced`}><div className="chart-bars"><i className="bounced" style={{ height: `${Math.max(d.bounced ? 3 : 0, Math.round(d.bounced / bouncedMax * 16))}%` }} /><i className="delivered" style={{ height: `${Math.max(d.delivered ? 4 : 0, Math.round(d.delivered / deliveredMax * 88))}%` }} /></div><span>{new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${d.day}T00:00:00Z`))}</span></div>)}</div></div>;
}

function formatMoneyCompact(cents: number | null | undefined): string {
  const amount = Number.isFinite(Number(cents)) ? Number(cents) / 100 : 0;
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
}
