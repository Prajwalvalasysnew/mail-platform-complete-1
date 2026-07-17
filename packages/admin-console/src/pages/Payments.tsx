import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/operations';
import type { GatewayInfo, GatewayKey } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { friendlyError } from '../lib/http';
import { ErrorState, Loading, Modal, PermissionState, Pill, SwitchRow } from '../components/ui';
import { Icon } from '../components/icons';
import { fmtDate, fmtNum } from '../lib/format';

interface GatewayMeta {
  key: GatewayKey;
  name: string;
  short: string;
  desc: string;
  features: string[];
}

const GATEWAY_META: Record<GatewayKey, GatewayMeta> = {
  stripe: { key: 'stripe', name: 'Stripe', short: 'S', desc: 'Credit & debit cards — global', features: ['Cards', 'Subscriptions', 'Webhooks', 'SCA / 3DS2'] },
  paypal: { key: 'paypal', name: 'PayPal', short: 'PP', desc: 'PayPal wallet + card checkout', features: ['PayPal balance', 'Debit/Credit', 'Buy now pay later'] },
  cashfree: { key: 'cashfree', name: 'Cashfree', short: 'CF', desc: 'INR payments — India market', features: ['UPI', 'NetBanking', 'Cards (INR)', 'Wallets'] },
};

/**
 * Payment gateways.
 *
 * Backed by GET/PUT /admin/payment-gateways. Credentials stay in server
 * environment configuration and are only reported present/absent (never
 * echoed); the enable toggle + mode label persist server-side, and activity
 * comes from the processed billing-event stream.
 */
export function PaymentsPage() {
  const { admin, hasRole } = useAuth();
  const [configure, setConfigure] = useState<GatewayInfo | null>(null);

  const gateways = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'payment-gateways'],
    queryFn: api.paymentGateways,
    enabled: hasRole('operator'),
  });

  if (!hasRole('operator')) return <PermissionState need="operator" />;

  return (
    <>
      <div className="page-desc">
        Payment gateways used for tenant billing. Keys are stored in server environment configuration and never
        logged — status combines credential presence, the platform enable toggle, and live webhook activity.
      </div>

      {gateways.isPending ? (
        <Loading label="Loading gateway status…" />
      ) : gateways.isError ? (
        <ErrorState error={gateways.error} retry={() => void gateways.refetch()} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {gateways.data.gateways.map((g) => {
            const meta = GATEWAY_META[g.key];
            const active = g.enabled && g.configured;
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
                      {meta.short}
                    </div>
                    <div>
                      <div className="card-title">{meta.name}</div>
                      <div className="card-sub">{meta.desc}</div>
                    </div>
                  </div>
                  <div className="row">
                    {!g.configured ? (
                      <Pill tone="amber">Credentials missing</Pill>
                    ) : active ? (
                      <Pill tone="green">Active</Pill>
                    ) : (
                      <Pill tone="ghost">Disabled</Pill>
                    )}
                    {g.mode ? <Pill tone="outline">{g.mode}</Pill> : null}
                    {g.activity.events_processed > 0 ? (
                      <span className="section-note">
                        {fmtNum(g.activity.events_processed)} events · last {fmtDate(g.activity.last_event_at)}
                      </span>
                    ) : (
                      <span className="section-note">no webhook activity</span>
                    )}
                    <button className="btn sm" onClick={() => setConfigure(g)}>
                      <Icon name="settings" size={13} /> Configure
                    </button>
                  </div>
                </div>
                <div className="card-pad row" style={{ flexWrap: 'wrap', gap: 18, paddingTop: 12, paddingBottom: 12 }}>
                  {meta.features.map((f) => (
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
      )}

      {configure ? (
        <GatewayConfigModal
          gateway={configure}
          canEdit={hasRole('admin')}
          onClose={() => setConfigure(null)}
        />
      ) : null}
    </>
  );
}

function GatewayConfigModal({ gateway, canEdit, onClose }: { gateway: GatewayInfo; canEdit: boolean; onClose: () => void }) {
  const { admin } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const meta = GATEWAY_META[gateway.key];
  const [enabled, setEnabled] = useState(gateway.enabled);
  const [mode, setMode] = useState<'live' | 'test'>(gateway.mode ?? 'live');

  const save = useMutation({
    mutationFn: () => api.updatePaymentGateway(gateway.key, { enabled, mode }),
    onSuccess: () => {
      toast(`${meta.name} configuration saved.`);
      void queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'payment-gateways'] });
      onClose();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  return (
    <Modal title={`Configure ${meta.name}`} onClose={onClose} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Credentials (environment-managed)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {Object.entries(gateway.env).map(([name, present]) => (
              <div key={name} className="row" style={{ justifyContent: 'space-between' }}>
                <span className="mono" style={{ fontSize: 11.5 }}>{name}</span>
                {present ? <Pill tone="green">set</Pill> : <Pill tone="amber">missing</Pill>}
              </div>
            ))}
          </div>
          <div className="section-note" style={{ marginTop: 8, lineHeight: 1.5 }}>
            Credential values are provisioned via deployment environment variables and are never displayed or stored
            in the database — only their presence is reported here.
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <SwitchRow label={`Enable ${meta.name} for tenant billing`} on={enabled} onToggle={setEnabled} disabled={!canEdit} />
          <div className="field">
            <label>Checkout mode</label>
            <select className="select" value={mode} onChange={(e) => setMode(e.target.value as 'live' | 'test')} disabled={!canEdit} aria-label="Checkout mode">
              <option value="live">live</option>
              <option value="test">test</option>
            </select>
          </div>
          {!canEdit ? <div className="section-note">Changing gateway configuration requires the admin role.</div> : null}
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={onClose} disabled={save.isPending}>Close</button>
          {canEdit ? (
            <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
