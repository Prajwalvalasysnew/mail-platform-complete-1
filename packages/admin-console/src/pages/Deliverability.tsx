import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/operations';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { EmptyState, ErrorState, Kpi, Loading, Pill, StatusPill } from '../components/ui';
import { Icon } from '../components/icons';
import { friendlyError } from '../lib/http';
import { fmtNum, fmtPct } from '../lib/format';

export function DeliverabilityPage() {
  const { admin, hasRole } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const health = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'pool-health'],
    queryFn: api.poolHealth,
    refetchInterval: 60_000,
  });
  const rep = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'reputation-pools'],
    queryFn: api.reputationPools,
  });

  const scan = useMutation({
    mutationFn: api.blocklistScan,
    onSuccess: (d) => {
      toast(d.listings.length === 0 ? 'Blocklist scan complete — no listings found.' : `Blocklist scan found ${d.listings.length} listing(s).`, d.listings.length ? 'error' : 'info');
      void queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'reputation-pools'] });
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  if (health.isPending) return <Loading label="Loading deliverability…" />;
  if (health.isError) return <ErrorState error={health.error} retry={() => void health.refetch()} />;

  const pools = health.data.pools;
  const totSent = pools.reduce((a, p) => a + p.sent, 0);
  const totBounced = pools.reduce((a, p) => a + p.bounced, 0);
  const totComplained = pools.reduce((a, p) => a + p.complained, 0);
  const bounceRate = totSent ? totBounced / totSent : 0;
  const complaintRate = totSent ? totComplained / totSent : 0;

  const listings = (rep.data?.pools ?? []).flatMap((p) => p.ips.flatMap((ip) => ip.blocklist_listings));

  return (
    <>
      <div className="page-head">
        <div className="page-desc">Platform-wide sending reputation, bounce rates, and blocklist status — last 24 hours per pool.</div>
        {hasRole('operator') ? (
          <button className="btn" onClick={() => scan.mutate()} disabled={scan.isPending}>
            <Icon name="search" size={13} /> {scan.isPending ? 'Scanning…' : 'Scan blocklists'}
          </button>
        ) : null}
      </div>

      <div className="kpi-grid">
        <Kpi label="Platform delivery rate" value={fmtPct(totSent ? 1 - bounceRate : null)} tone="green" sub="last 24h, all pools" />
        <Kpi label="Platform bounce rate" value={fmtPct(bounceRate)} tone={bounceRate > 0.05 ? 'red' : 'plain'} sub={`${fmtNum(totBounced)} of ${fmtNum(totSent)} messages`} />
        <Kpi label="Complaint rate" value={fmtPct(complaintRate, 3)} tone={complaintRate > 0.001 ? 'red' : 'green'} sub="threshold 0.1%" />
        <Kpi label="Active blocklist listings" value={fmtNum(listings.length)} tone={listings.length ? 'red' : 'green'} sub="last 7 days, all IPs" />
      </div>

      <div className="card">
        <div className="card-pad" style={{ paddingBottom: 8 }}>
          <div className="card-title">Pool health — rolling 24h</div>
          <div className="card-sub">Thresholds: bounce ≥ 5% → pause · complaint ≥ 0.3% → pause. Recommended action is applied by the send path.</div>
        </div>
        {pools.length === 0 ? (
          <EmptyState title="No sends in the last 24 hours" />
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table className="data">
              <thead>
                <tr>
                  <th>Pool</th>
                  <th className="num">Sent 24h</th>
                  <th className="num">Bounced</th>
                  <th className="num">Bounce %</th>
                  <th className="num">Complaints</th>
                  <th className="num">Complaint %</th>
                  <th>Action</th>
                  <th>Reasons</th>
                </tr>
              </thead>
              <tbody>
                {pools.map((p) => (
                  <tr key={p.pool}>
                    <td className="cell-main mono">{p.pool}</td>
                    <td className="num">{fmtNum(p.sent)}</td>
                    <td className="num">{fmtNum(p.bounced)}</td>
                    <td className="num" style={{ color: p.bounce_rate >= 0.05 ? 'var(--red-text)' : undefined }}>{fmtPct(p.bounce_rate)}</td>
                    <td className="num">{fmtNum(p.complained)}</td>
                    <td className="num" style={{ color: p.complaint_rate >= 0.003 ? 'var(--red-text)' : undefined }}>{fmtPct(p.complaint_rate, 3)}</td>
                    <td><StatusPill status={p.action} /></td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{p.reasons.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-pad" style={{ paddingBottom: 8 }}>
          <div className="card-title">Blocklist listings — last 7 days</div>
        </div>
        {rep.isPending ? (
          <Loading />
        ) : listings.length === 0 ? (
          <EmptyState title="No blocklist listings" hint="All sending IPs are clean across monitored DNSBLs." />
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table className="data">
              <thead>
                <tr>
                  <th>IP</th>
                  <th>Provider</th>
                  <th>Return code</th>
                  <th>Checked</th>
                </tr>
              </thead>
              <tbody>
                {listings.map((l, i) => (
                  <tr key={`${l.ip}-${l.provider}-${i}`}>
                    <td className="mono">{l.ip}</td>
                    <td>
                      <Pill tone="red">{l.provider}</Pill>
                    </td>
                    <td className="mono">{l.return_code ?? '—'}</td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{new Date(l.checked_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
