import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import * as api from '../api/operations';
import { Icon } from './icons';
import type { AdminRole } from '../api/types';

export interface NavItem {
  key: string;
  path: string;
  label: string;
  minRole: AdminRole;
}

export const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Operations',
    items: [
      { key: 'fleet', path: '/', label: 'Fleet overview', minRole: 'support' },
      { key: 'tenants', path: '/tenants', label: 'Tenants', minRole: 'support' },
      { key: 'deliverability', path: '/deliverability', label: 'Deliverability', minRole: 'support' },
      { key: 'pools', path: '/pools', label: 'IP pools', minRole: 'support' },
    ],
  },
  {
    label: 'Trust & safety',
    items: [
      { key: 'support', path: '/support', label: 'Support inbox', minRole: 'support' },
      { key: 'abuse', path: '/abuse', label: 'Abuse queue', minRole: 'support' },
      { key: 'kyc', path: '/kyc', label: 'KYC / verification', minRole: 'support' },
      { key: 'audit', path: '/audit', label: 'Audit log', minRole: 'admin' },
    ],
  },
  {
    label: 'Platform',
    items: [
      { key: 'billing', path: '/billing', label: 'Billing & metering', minRole: 'operator' },
      { key: 'payments', path: '/payments', label: 'Payment gateways', minRole: 'operator' },
      { key: 'settings', path: '/settings', label: 'Settings', minRole: 'operator' },
      { key: 'team', path: '/team', label: 'Admin team', minRole: 'operator' },
      { key: 'dlq', path: '/dlq', label: 'Dead-letter queue', minRole: 'operator' },
    ],
  },
];

const TITLES: Record<string, string> = Object.fromEntries(
  NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.path, i.label]))
);

function useBadges(enabled: boolean, operator: boolean) {
  const unread = useQuery({
    queryKey: ['admin', 'badges', 'support-unread'],
    queryFn: api.ticketUnreadCount,
    enabled,
    refetchInterval: 60_000,
  });
  const review = useQuery({
    queryKey: ['admin', 'badges', 'review-stats'],
    queryFn: api.reviewQueueStats,
    enabled,
    refetchInterval: 60_000,
  });
  const dlq = useQuery({
    queryKey: ['admin', 'badges', 'dlq'],
    queryFn: () => api.listDlq({ limit: 1 }),
    enabled: enabled && operator,
    refetchInterval: 120_000,
  });
  return {
    support: unread.data?.unread ?? 0,
    abuse: review.data?.pending ?? 0,
    dlqAlert: (dlq.data?.total ?? 0) > 0,
  };
}

export function Shell() {
  const { admin, logout, hasRole } = useAuth();
  const routerState = useRouterState();
  const path = routerState.location.pathname;
  const badges = useBadges(!!admin, hasRole('operator'));

  const title = TITLES[path] ?? TITLES['/' + path.split('/')[1]] ?? 'Admin console';
  const initials = (admin?.email ?? '?').slice(0, 2).toUpperCase();
  const displayName = admin?.email?.split('@')[0] || 'Admin';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-brand-row">
            <div className="sidebar-logo">
              <Icon name="mail" size={16} />
            </div>
            <div>
              <div className="sidebar-title">Valasys Mail</div>
              <div className="sidebar-sub">
                <span className="env">ADMIN</span> console
              </div>
            </div>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Primary">
          {NAV_GROUPS
            .map((grp) => ({ ...grp, items: grp.items.filter((item) => hasRole(item.minRole)) }))
            .filter((grp) => grp.items.length > 0)
            .map((grp) => (
            <div key={grp.label}>
              <div className="nav-group-label">{grp.label}</div>
              {grp.items.map((item) => {
                const active = item.path === '/' ? path === '/' : path.startsWith(item.path);
                const badge =
                  item.key === 'support' && badges.support > 0 ? String(badges.support) :
                  item.key === 'abuse' && badges.abuse > 0 ? String(badges.abuse) :
                  item.key === 'dlq' && badges.dlqAlert ? '!' : '';
                const urgent = item.key === 'support' || item.key === 'dlq';
                return (
                  <Link key={item.key} to={item.path} className={`nav-item${active ? ' active' : ''}`}>
                    <Icon name={item.key} />
                    <span className="label">{item.label}</span>
                    {badge ? <span className={`nav-badge${urgent ? ' urgent' : ''}`}>{badge}</span> : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className={`sysstatus${badges.dlqAlert ? ' warning' : ''}`}>
            <span className={`dot ${badges.dlqAlert ? 'amber' : 'green'}`} /> {badges.dlqAlert ? 'System warning detected' : 'All systems operational'}
          </div>
          <div className="sidebar-user">
            <span className="avatar">
              {initials}
              <span className="presence" />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {admin?.email}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>{admin?.role} · Platform</div>
            </div>
            <button className="iconbtn" onClick={() => void logout()} title="Sign out" aria-label="Sign out">
              <Icon name="logout" size={14} />
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumb">
            <span
              style={{
                width: 26, height: 26, borderRadius: 7, background: 'var(--blue)', color: '#fff',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Icon name="mail" size={13} />
            </span>
            <span className="chev">›</span>
            {title}
          </div>
          <div className="topbar-search">
            <div className="box">
              <Icon name="search" size={14} />
              <input placeholder="Search tenants, messages, tickets…" aria-label="Global search" readOnly />
              <span className="kbd">⌘K</span>
            </div>
          </div>
          <span className="env-pill">
            <span className="dot amber" /> Local development
          </span>
          <button className="iconbtn topbar-action" title="Refresh data" aria-label="Refresh data" onClick={() => window.location.reload()}>
            <Icon name="refresh" size={16} />
          </button>
          <span className="topbar-notifications" aria-label={`${badges.support} notifications`}>
            <Icon name="support" size={16} />
            {badges.support > 0 ? <b>{badges.support}</b> : null}
          </span>
          <div className="topbar-user">
            <span className="avatar">{initials}</span>
            <strong>{displayName}</strong>
            <span className="chev">⌄</span>
          </div>
        </header>
        <main className="content">
          <div className="content-inner">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
