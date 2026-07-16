import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/operations';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { EmptyState, ErrorState, Loading, Meter, Pill, StatusPill } from '../components/ui';
import { Icon } from '../components/icons';
import { friendlyError } from '../lib/http';
import { fmtNum, fmtPct } from '../lib/format';
import type { ReputationPool } from '../api/types';

const WARMUP_FULL_STAGE = 30;

export function PoolsPage() {
  const { admin, hasRole } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const rep = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'reputation-pools'],
    queryFn: api.reputationPools,
    refetchInterval: 120_000,
  });

  const scan = useMutation({
    mutationFn: api.blocklistScan,
    onSuccess: (d) => {
      toast(d.listings.length === 0 ? 'Blocklist scan complete — all clean.' : `Scan found ${d.listings.length} listing(s).`, d.listings.length ? 'error' : 'info');
      void queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'reputation-pools'] });
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  if (rep.isPending) return <Loading label="Loading IP pools…" />;
  if (rep.isError) return <ErrorState error={rep.error} retry={() => void rep.refetch()} />;

  return (
    <>
      <div className="page-head">
        <div className="page-desc">
          Sending pools with warmup schedules, pool health actions, and per-IP blocklist + postmaster reputation.
          Thresholds: bounce ≥ 5% → pause, complaint ≥ 0.3% → pause.
        </div>
        {hasRole('operator') ? (
          <button className="btn" onClick={() => scan.mutate()} disabled={scan.isPending}>
            <Icon name="search" size={13} /> {scan.isPending ? 'Scanning…' : 'Scan blocklists'}
          </button>
        ) : null}
      </div>

      {rep.data.pools.length === 0 ? (
        <div className="card">
          <EmptyState title="No sending IPs configured" hint="Add sending IPs via infrastructure provisioning; they will appear here with warmup state." />
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(390px, 1fr))', gap: 16 }}>
          {rep.data.pools.map((pool) => (
            <PoolCard key={pool.pool_id} pool={pool} />
          ))}
        </div>
      )}
    </>
  );
}

function PoolCard({ pool }: { pool: ReputationPool }) {
  const h = pool.health;
  const avgStage = pool.ips.length ? pool.ips.reduce((a, ip) => a + ip.warmup_stage, 0) / pool.ips.length : 0;
  const fullyWarmed = pool.ips.length > 0 && pool.ips.every((ip) => ip.warmup_stage >= WARMUP_FULL_STAGE);
  const anyListed = pool.ips.some((ip) => ip.blocklist_listings.length > 0);

  return (
    <div className="card">
      <div className="card-pad row" style={{ justifyContent: 'space-between', paddingBottom: 10, borderBottom: '1px solid var(--border-soft)' }}>
        <div>
          <div className="card-title" style={{ textTransform: 'capitalize' }}>{pool.pool_id}</div>
          <div className="card-sub">{fmtNum(pool.ips.length)} sending IP{pool.ips.length === 1 ? '' : 's'}</div>
        </div>
        {h ? <StatusPill status={h.action === 'ok' ? 'active' : h.action === 'throttle' ? 'throttled' : 'paused'} /> : <Pill tone="ghost">no traffic</Pill>}
      </div>

      <div style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-mid)' }}>Sent (24h)</span>
          <b className="mono">{fmtNum(h?.sent ?? 0)}</b>
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-mid)' }}>Bounce rate (24h)</span>
          <b className="mono" style={{ color: (h?.bounce_rate ?? 0) >= 0.05 ? 'var(--red-text)' : undefined }}>{fmtPct(h?.bounce_rate ?? 0)}</b>
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-mid)' }}>Complaint rate (24h)</span>
          <b className="mono" style={{ color: (h?.complaint_rate ?? 0) >= 0.003 ? 'var(--red-text)' : undefined }}>{fmtPct(h?.complaint_rate ?? 0, 3)}</b>
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--text-mid)' }}>Pool action</span>
          {h ? <StatusPill status={h.action} /> : <span className="section-note">—</span>}
        </div>

        <div style={{ marginTop: 4 }}>
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 5 }}>
            <span style={{ fontWeight: 600 }}>Warmup</span>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: fullyWarmed ? 'var(--green-text)' : 'var(--amber-text)' }}>
              {fullyWarmed ? 'Fully warmed' : pool.ips.length ? `Stage ${Math.round(avgStage)} / ${WARMUP_FULL_STAGE}` : '—'}
            </span>
          </div>
          <Meter fraction={pool.ips.length ? Math.min(1, avgStage / WARMUP_FULL_STAGE) : 0} color={fullyWarmed ? 'var(--green)' : 'var(--amber-strong)'} />
        </div>

        <div style={{ marginTop: 4 }}>
          <div style={{ fontWeight: 600, marginBottom: 5 }}>IP health</div>
          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            {pool.ips.map((ip) => {
              const listed = ip.blocklist_listings.length > 0;
              const warm = ip.warmup_stage >= WARMUP_FULL_STAGE;
              const color = listed ? 'var(--red)' : ip.status !== 'active' ? 'oklch(0.9 0.003 264)' : warm ? 'var(--green)' : 'var(--amber-strong)';
              return (
                <span
                  key={ip.ip}
                  title={`${ip.ip} · ${ip.status} · warmup ${ip.warmup_stage}${listed ? ` · LISTED (${ip.blocklist_listings.map((l) => l.provider).join(', ')})` : ''}`}
                  style={{ width: 12, height: 12, borderRadius: 3, background: color, display: 'inline-block' }}
                />
              );
            })}
            {pool.ips.length === 0 ? <span className="section-note">no IPs assigned</span> : null}
          </div>
        </div>
      </div>

      {pool.ips.length > 0 ? (
        <div className="table-wrap" style={{ borderTop: '1px solid var(--border-soft)' }}>
          <table className="data">
            <thead>
              <tr>
                <th>IP</th>
                <th>PTR</th>
                <th className="num">Warmup</th>
                <th>Google rep</th>
                <th>SNDS</th>
                <th>Blocklist</th>
              </tr>
            </thead>
            <tbody>
              {pool.ips.map((ip) => (
                <tr key={ip.ip}>
                  <td className="mono" style={{ fontSize: 11.5 }}>{ip.ip}</td>
                  <td className="mono" style={{ fontSize: 11, color: 'var(--text-dim)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ip.ptr_record ?? '—'}</td>
                  <td className="num">{ip.warmup_stage >= WARMUP_FULL_STAGE ? <Pill tone="green">full</Pill> : <Pill tone="amber">{ip.warmup_stage}/{WARMUP_FULL_STAGE}</Pill>}</td>
                  <td>{ip.reputation_snapshot?.google_reputation ? <StatusPill status={ip.reputation_snapshot.google_reputation} /> : <span className="section-note">—</span>}</td>
                  <td>{ip.reputation_snapshot?.snds_color ? <StatusPill status={ip.reputation_snapshot.snds_color} /> : <span className="section-note">—</span>}</td>
                  <td>
                    {ip.blocklist_listings.length ? (
                      <Pill tone="red">{ip.blocklist_listings.map((l) => l.provider).join(', ')}</Pill>
                    ) : (
                      <Pill tone="green">clean</Pill>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {anyListed ? (
        <div className="card-pad" style={{ paddingTop: 10 }}>
          <div className="alert red" style={{ padding: '8px 12px' }}>
            <div className="body">One or more IPs in this pool are on a public blocklist — investigate before resuming full volume.</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
