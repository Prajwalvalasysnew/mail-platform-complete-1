import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import * as api from '../api/operations';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { friendlyError } from '../lib/http';
import { ConfirmModal, PermissionState } from '../components/ui';
import { Icon } from '../components/icons';

/**
 * Platform settings.
 *
 * The one live control today is the retention/cleanup runner
 * (POST /admin/retention/run). Sending-quota, bounce-threshold, warmup, and
 * security policy parameters are enforced server-side via environment
 * configuration and per-tenant columns; a settings CRUD API is a tracked
 * backend gap, so those panels render read-only defaults.
 */
export function SettingsPage() {
  const { hasRole } = useAuth();
  const toast = useToast();
  const [bodyDays, setBodyDays] = useState('90');
  const [eventDays, setEventDays] = useState('365');
  const [auditDays, setAuditDays] = useState('730');
  const [reviewDays, setReviewDays] = useState('30');
  const [confirmRun, setConfirmRun] = useState(false);
  const [lastResult, setLastResult] = useState<Record<string, unknown> | null>(null);

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

      <div className="grid2">
        <ReadOnlyPanel
          title="Sending quotas"
          sub="Default daily and monthly caps applied to all new tenants."
          fields={[
            ['Default daily quota', '50,000'],
            ['Default monthly quota', '1,500,000'],
          ]}
          note="Per-tenant overrides are editable from the tenant drawer (PATCH /admin/customers/:id). Platform defaults are environment configuration — no settings API yet."
        />
        <ReadOnlyPanel
          title="Bounce thresholds"
          sub="Auto-hold triggers when a tenant exceeds these rates over a 24h window."
          fields={[
            ['Soft bounce auto-hold (%)', '5.0'],
            ['Hard bounce auto-suspend (%)', '3.0'],
            ['Complaint auto-hold (%)', '0.1'],
          ]}
          note="Enforced by the send path and pool-health evaluator. Threshold tuning requires a settings API (tracked backend gap)."
        />
        <ReadOnlyPanel
          title="IP warmup"
          sub="New IP warmup schedule — ramp from initial volume over N days."
          fields={[
            ['Initial daily volume per IP', '500'],
            ['Ramp days to full volume', '30'],
          ]}
          note="Warmup stages advance automatically per sending IP; see IP pools for live per-IP stage."
        />
        <ReadOnlyPanel
          title="Security & auth"
          sub="Platform-level security policies applied to all admin users."
          fields={[
            ['Require MFA for admin users', 'Recommended — enroll via TOTP'],
            ['Session lifetime', '8 hours'],
            ['Admin login lockout', '5 failures → 15 min lock'],
          ]}
          note="MFA enrollment is available per admin account (POST /admin/auth/mfa/enroll). Policy enforcement flags need a settings API."
        />
      </div>

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

function ReadOnlyPanel({ title, sub, fields, note }: { title: string; sub: string; fields: Array<[string, string]>; note: string }) {
  return (
    <div className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div className="card-title">{title}</div>
        <div className="card-sub">{sub}</div>
      </div>
      {fields.map(([label, value]) => (
        <div key={label} className="field">
          <label>{label}</label>
          <input className="input mono" value={value} readOnly aria-readonly style={{ opacity: 0.75 }} />
        </div>
      ))}
      <div className="section-note" style={{ lineHeight: 1.5 }}>{note}</div>
    </div>
  );
}
