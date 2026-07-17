import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/operations';
import type { PlatformSettings } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { friendlyError } from '../lib/http';
import { ConfirmModal, ErrorState, Loading, PermissionState, SwitchRow } from '../components/ui';
import { Icon } from '../components/icons';

/**
 * Platform settings.
 *
 * Quotas / bounce thresholds / warmup / security panels persist via the
 * platform settings API (GET/PUT /admin/settings, admin role to write). The
 * retention/cleanup runner (POST /admin/retention/run) stays as the live
 * purge control.
 */
export function SettingsPage() {
  const { admin, hasRole } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canWrite = hasRole('admin');

  const [bodyDays, setBodyDays] = useState('90');
  const [eventDays, setEventDays] = useState('365');
  const [auditDays, setAuditDays] = useState('730');
  const [reviewDays, setReviewDays] = useState('30');
  const [confirmRun, setConfirmRun] = useState(false);
  const [lastResult, setLastResult] = useState<Record<string, unknown> | null>(null);

  const settings = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'settings'],
    queryFn: api.getSettings,
    enabled: hasRole('operator'),
  });

  const save = useMutation({
    mutationFn: (patch: Partial<PlatformSettings>) => api.updateSettings(patch),
    onSuccess: (d) => {
      queryClient.setQueryData(['admin', admin?.admin_user_id, 'settings'], { settings: d.settings });
      toast('Settings saved — changes take effect immediately.');
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  const run = useMutation({
    mutationFn: () =>
      api.runRetention({
        message_body_retention_days: Number(bodyDays),
        event_retention_days: Number(eventDays),
        audit_retention_days: Number(auditDays),
        review_queue_retention_days: Number(reviewDays),
      }),
    onSuccess: (d) => {
      setLastResult(d.result);
      setConfirmRun(false);
      toast('Retention run complete — purge counts below.');
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  if (!hasRole('operator')) return <PermissionState need="operator" />;

  return (
    <>
      <div className="page-desc">Platform-wide operational parameters — changes take effect immediately for all tenants.</div>

      <div className="card">
        <div className="card-pad row" style={{ justifyContent: 'space-between', paddingBottom: 10 }}>
          <div>
            <div className="card-title">Retention & cleanup</div>
            <div className="card-sub">
              Purge old message bodies, events, audit logs, and review-queue entries. Maps to{' '}
              <span className="codechip">POST /admin/retention/run</span>
            </div>
          </div>
          <button className="btn" onClick={() => setConfirmRun(true)} disabled={run.isPending}>
            <Icon name="trash" size={13} /> {run.isPending ? 'Running…' : 'Run retention now'}
          </button>
        </div>
        <div className="card-pad" style={{ paddingTop: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          <RetentionField label="Message body retention" value={bodyDays} onChange={setBodyDays} hint="HTML/text bodies purged after N days. message_id and metadata kept." />
          <RetentionField label="Event log retention" value={eventDays} onChange={setEventDays} hint="Delivery events (opened, clicked, bounced) retained for N days." />
          <RetentionField label="Audit log retention" value={auditDays} onChange={setAuditDays} hint="Admin action audit trail — minimum 2 years recommended." />
          <RetentionField label="Review queue retention" value={reviewDays} onChange={setReviewDays} hint="Resolved review-queue entries cleaned after N days." />
        </div>
        {lastResult ? (
          <div className="card-pad" style={{ paddingTop: 0 }}>
            <div className="alert blue">
              <div className="body">
                <div className="t">Last run result</div>
                <span className="mono" style={{ fontSize: 11.5 }}>{JSON.stringify(lastResult)}</span>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {settings.isPending ? (
        <Loading label="Loading platform settings…" />
      ) : settings.isError ? (
        <ErrorState error={settings.error} retry={() => void settings.refetch()} />
      ) : (
        <SettingsPanels
          settings={settings.data.settings}
          canWrite={canWrite}
          saving={save.isPending}
          onSave={(patch) => save.mutate(patch)}
        />
      )}

      {confirmRun ? (
        <ConfirmModal
          title="Run retention now"
          body={
            <>
              This immediately and permanently purges data older than the configured windows: message bodies &gt;{' '}
              <b>{bodyDays}d</b>, events &gt; <b>{eventDays}d</b>, audit entries &gt; <b>{auditDays}d</b>, resolved
              review-queue items &gt; <b>{reviewDays}d</b>. Purged data cannot be recovered.
            </>
          }
          confirmLabel="Run retention"
          confirmWord="PURGE"
          busy={run.isPending}
          onConfirm={() => run.mutate()}
          onClose={() => setConfirmRun(false)}
        />
      ) : null}
    </>
  );
}

function SettingsPanels({
  settings,
  canWrite,
  saving,
  onSave,
}: {
  settings: PlatformSettings;
  canWrite: boolean;
  saving: boolean;
  onSave: (patch: Partial<PlatformSettings>) => void;
}) {
  // Local editable copies, re-seeded whenever the server document changes.
  const [quotas, setQuotas] = useState(settings.quotas);
  const [bounce, setBounce] = useState(settings.bounce_thresholds);
  const [warmup, setWarmup] = useState(settings.warmup);
  const [security, setSecurity] = useState(settings.security);
  useEffect(() => {
    setQuotas(settings.quotas);
    setBounce(settings.bounce_thresholds);
    setWarmup(settings.warmup);
    setSecurity(settings.security);
  }, [settings]);

  return (
    <div className="grid2">
      <SettingsPanel
        title="Sending quotas"
        sub="Default daily and monthly caps applied to new tenants."
        canWrite={canWrite}
        saving={saving}
        dirty={JSON.stringify(quotas) !== JSON.stringify(settings.quotas)}
        onSave={() => onSave({ quotas })}
        note="Per-tenant overrides are editable from the tenant drawer (PATCH /admin/customers/:id)."
      >
        <NumberField label="Default daily quota" value={quotas.default_daily_quota} disabled={!canWrite}
          onChange={(v) => setQuotas({ ...quotas, default_daily_quota: v })} />
        <NumberField label="Default monthly quota" value={quotas.default_monthly_quota} disabled={!canWrite}
          onChange={(v) => setQuotas({ ...quotas, default_monthly_quota: v })} />
      </SettingsPanel>

      <SettingsPanel
        title="Bounce thresholds"
        sub="Auto-hold triggers when a tenant exceeds these rates over a 24h window."
        canWrite={canWrite}
        saving={saving}
        dirty={JSON.stringify(bounce) !== JSON.stringify(settings.bounce_thresholds)}
        onSave={() => onSave({ bounce_thresholds: bounce })}
        note="Consumed by the send path and pool-health evaluator."
      >
        <NumberField label="Soft bounce auto-hold (%)" value={bounce.soft_bounce_hold_pct} step={0.1} disabled={!canWrite}
          onChange={(v) => setBounce({ ...bounce, soft_bounce_hold_pct: v })} />
        <NumberField label="Hard bounce auto-suspend (%)" value={bounce.hard_bounce_suspend_pct} step={0.1} disabled={!canWrite}
          onChange={(v) => setBounce({ ...bounce, hard_bounce_suspend_pct: v })} />
        <NumberField label="Complaint auto-hold (%)" value={bounce.complaint_hold_pct} step={0.01} disabled={!canWrite}
          onChange={(v) => setBounce({ ...bounce, complaint_hold_pct: v })} />
      </SettingsPanel>

      <SettingsPanel
        title="IP warmup"
        sub="New IP warmup schedule — ramp from initial volume over N days."
        canWrite={canWrite}
        saving={saving}
        dirty={JSON.stringify(warmup) !== JSON.stringify(settings.warmup)}
        onSave={() => onSave({ warmup })}
        note="Warmup stages advance automatically per sending IP; see IP pools for live per-IP stage."
      >
        <NumberField label="Initial daily volume per IP" value={warmup.initial_daily_volume} disabled={!canWrite}
          onChange={(v) => setWarmup({ ...warmup, initial_daily_volume: v })} />
        <NumberField label="Ramp days to full volume" value={warmup.ramp_days} disabled={!canWrite}
          onChange={(v) => setWarmup({ ...warmup, ramp_days: v })} />
      </SettingsPanel>

      <SettingsPanel
        title="Security & auth"
        sub="Platform-level security policies applied to all admin users."
        canWrite={canWrite}
        saving={saving}
        dirty={JSON.stringify(security) !== JSON.stringify(settings.security)}
        onSave={() => onSave({ security })}
        note="MFA enrollment is per admin account (POST /admin/auth/mfa/enroll); this flag marks it as required policy."
      >
        <SwitchRow label="Require MFA for admin users" on={security.require_admin_mfa} disabled={!canWrite}
          onToggle={(v) => setSecurity({ ...security, require_admin_mfa: v })} />
        <NumberField label="Session lifetime (hours)" value={security.session_lifetime_hours} disabled={!canWrite}
          onChange={(v) => setSecurity({ ...security, session_lifetime_hours: v })} />
        <NumberField label="Lockout after N failed logins" value={security.lockout_threshold} disabled={!canWrite}
          onChange={(v) => setSecurity({ ...security, lockout_threshold: v })} />
        <NumberField label="Lockout duration (minutes)" value={security.lockout_minutes} disabled={!canWrite}
          onChange={(v) => setSecurity({ ...security, lockout_minutes: v })} />
      </SettingsPanel>
    </div>
  );
}

function SettingsPanel({
  title,
  sub,
  note,
  canWrite,
  saving,
  dirty,
  onSave,
  children,
}: {
  title: string;
  sub: string;
  note: string;
  canWrite: boolean;
  saving: boolean;
  dirty: boolean;
  onSave: () => void;
  children: ReactNode;
}) {
  return (
    <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="card-title">{title}</div>
          <div className="card-sub">{sub}</div>
        </div>
        {canWrite ? (
          <button className="btn sm primary" disabled={!dirty || saving} onClick={onSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        ) : null}
      </div>
      {children}
      <div className="section-note" style={{ lineHeight: 1.5 }}>
        {note}
        {!canWrite ? ' Editing requires the admin role.' : ''}
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange, disabled, step }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean; step?: number }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        className="input mono"
        type="number"
        step={step ?? 1}
        min={0}
        value={Number.isFinite(value) ? value : 0}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        style={disabled ? { opacity: 0.75 } : undefined}
      />
    </div>
  );
}

function RetentionField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint: string }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px', background: 'var(--bg-subtle)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input mono"
          style={{ width: 90, background: '#fff' }}
          type="number"
          min={0}
          max={3650}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
        />
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>days</span>
      </div>
      <div className="section-note" style={{ marginTop: 6, lineHeight: 1.45 }}>{hint}</div>
    </div>
  );
}
