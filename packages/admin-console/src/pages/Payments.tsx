import { useQuery } from '@tanstack/react-query';
import * as api from '../api/operations';
import { useAuth } from '../auth/AuthContext';
import { PermissionState, Pill } from '../components/ui';
import { Icon } from '../components/icons';
import { fmtDate, fmtNum } from '../lib/format';

interface Gateway {
  key: string;
  name: string;
  short: string;
  desc: string;
  features: string[];
}

const GATEWAYS: Gateway[] = [
  { key: 'stripe', name: 'Stripe', short: 'S', desc: 'Credit & debit cards — global', features: ['Cards', 'Subscriptions', 'Webhooks', 'SCA / 3DS2'] },
  { key: 'paypal', name: 'PayPal', short: 'PP', desc: 'PayPal wallet + card checkout', features: ['PayPal balance', 'Debit/Credit', 'Buy now pay later'] },
  { key: 'cashfree', name: 'Cashfree', short: 'CF', desc: 'INR payments — India market', features: ['UPI', 'NetBanking', 'Cards (INR)', 'Wallets'] },
];

/**
 * Payment gateways.
 *
 * Gateway credentials are provisioned via environment configuration on the
 * API (there is no /admin/payment-gateways CRUD yet — a tracked backend gap).
 * Activity per provider is derived from the processed billing-event stream,
 * which is the most truthful signal of which gateways are live.
 */
export function PaymentsPage() {
  const { admin, hasRole } = useAuth();

  const events = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'billing-events'],
    queryFn: () => api.billingEvents({ limit: 200 }),
    enabled: hasRole('operator'),
  });

  if (!hasRole('operator')) return <PermissionState need="operator" />;

  const rows = events.data?.events ?? [];
  const stats = new Map<string, { count: number; last: string | null }>();
  for (const e of rows) {
    const p = (e.provider ?? 'stripe').toLowerCase();
    const cur = stats.get(p) ?? { count: 0, last: null };
    cur.count += 1;
    if (!cur.last || e.processed_at > cur.last) cur.last = e.processed_at;
    stats.set(p, cur);
  }

  return (
    <>
      <div className="page-desc">
        Payment gateways used for tenant billing. Keys are stored encrypted in server environment configuration and never
        logged — status below is derived from live webhook activity.
      </div>

      <div className="alert blue">
        <div className="body">
          <div className="t">Gateway credential editing is not exposed here yet</div>
          The API has no <span className="codechip">/admin/payment-gateways</span> configuration endpoints — credentials
          are managed via deployment environment variables. This screen reports observed activity per provider from{' '}
          <span className="codechip">GET /admin/billing-events</span>.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {GATEWAYS.map((g) => {
          const s = stats.get(g.key);
          const active = (s?.count ?? 0) > 0;
          return (
            <div key={g.key} className="card">
              <div className="card-pad row" style={{ justifyContent: 'space-between', borderBottom: '1px solid var(--border-soft)' }}>
                <div className="row">
                  <div
                    style={{
                      width: 38, height: 38, borderRadius: 10, background: 'var(--blue-soft)', color: 'var(--blue-text)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13,
                    }}
                  >
                    {g.short}
                  </div>
                  <div>
                    <div className="card-title">{g.name}</div>
                    <div className="card-sub">{g.desc}</div>
                  </div>
                </div>
                <div className="row">
                  {active ? <Pill tone="green">Active</Pill> : <Pill tone="ghost">Inactive</Pill>}
                  {s ? (
                    <span className="section-note">
                      {fmtNum(s.count)} events · last {fmtDate(s.last)}
                    </span>
                  ) : (
                    <span className="section-note">no webhook activity</span>
                  )}
                </div>
              </div>
              <div className="card-pad row" style={{ flexWrap: 'wrap', gap: 18, paddingTop: 12, paddingBottom: 12 }}>
                {g.features.map((f) => (
                  <span key={f} className="row" style={{ gap: 6, fontSize: 12.5, color: 'var(--text-mid)' }}>
                    <span style={{ color: 'var(--green-strong)' }}>
                      <Icon name="check" size={13} />
                    </span>
                    {f}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
