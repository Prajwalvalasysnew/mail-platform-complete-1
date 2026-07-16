import { useEffect, useRef, useState, type ReactNode } from 'react';
import { friendlyError } from '../lib/http';
import { Icon } from './icons';

// ---------- Pills ----------
export function Pill({ tone, children }: { tone: 'green' | 'red' | 'amber' | 'blue' | 'outline' | 'ghost'; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function StatusPill({ status }: { status: string | null | undefined }) {
  const s = (status ?? '').toLowerCase();
  const tone =
    s === 'active' || s === 'trialing' || s === 'verified' || s === 'ok' || s === 'resolved' || s === 'delivered' || s === 'approved'
      ? 'green'
      : s === 'suspended' || s === 'canceled' || s === 'failed' || s === 'rejected' || s === 'urgent' || s === 'pause'
        ? 'red'
        : s === 'closed' || s === 'retired' || s === ''
          ? 'ghost'
          : 'amber';
  return <Pill tone={tone}>{status ?? '—'}</Pill>;
}

export function PlanPill({ tier }: { tier: string | null | undefined }) {
  const t = (tier ?? '').toLowerCase();
  if (t === 'enterprise') return <Pill tone="blue">enterprise</Pill>;
  if (t === 'paid' || t === 'pro') return <Pill tone="outline">{t}</Pill>;
  return <Pill tone="ghost">{t || 'free'}</Pill>;
}

export function RiskPill({ score }: { score: number }) {
  const tone = score >= 60 ? 'red' : score >= 30 ? 'amber' : 'green';
  return <Pill tone={tone}>{score}</Pill>;
}

// ---------- KPI ----------
export function Kpi({ label, value, unit, tone, sub }: { label: string; value: ReactNode; unit?: string; tone?: 'green' | 'red' | 'plain'; sub?: ReactNode }) {
  const color = tone === 'green' ? 'var(--green-strong)' : tone === 'red' ? 'var(--red-text)' : 'var(--text-strong)';
  return (
    <div className="card kpi">
      <div>
        <div className="klabel">{label}</div>
        <div className="kvalue" style={{ color }}>
          {value}
          {unit ? <span className="unit">{unit}</span> : null}
        </div>
        {sub ? <div className="kdelta">{sub}</div> : null}
      </div>
    </div>
  );
}

// ---------- Async states ----------
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="empty-state" role="status">
      <div className="row" style={{ justifyContent: 'center' }}>
        <span className="spinner" /> {label}
      </div>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty-state">
      <div className="t">{title}</div>
      {hint ? <div>{hint}</div> : null}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <span>{friendlyError(error)}</span>
      {retry ? (
        <button className="btn sm" onClick={retry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function PermissionState({ need }: { need: string }) {
  return (
    <div className="card card-pad empty-state">
      <div className="t">Insufficient role</div>
      <div>
        This area requires the <b>{need}</b> role or higher. Ask an admin for a just-in-time elevation
        (Admin team → Elevations) if you need temporary access.
      </div>
    </div>
  );
}

// ---------- Modal ----------
export function Modal({ title, onClose, children, width }: { title: ReactNode; onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <div className="modal-head">
          <div className="card-title">{title}</div>
          <button className="iconbtn" onClick={onClose} aria-label="Close dialog">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/**
 * Server-confirmed destructive action modal. `confirmWord` forces typed
 * confirmation for the riskiest operations (purge, suspend).
 */
export function ConfirmModal({
  title,
  body,
  confirmLabel,
  confirmWord,
  danger = true,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  confirmWord?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const ok = !confirmWord || typed === confirmWord;
  return (
    <Modal title={title} onClose={onClose}>
      <div style={{ fontSize: 12.5, color: 'var(--text-mid)', lineHeight: 1.55 }}>{body}</div>
      {confirmWord ? (
        <div className="field">
          <label>
            Type <span className="codechip">{confirmWord}</span> to confirm
          </label>
          <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </div>
      ) : null}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className={`btn ${danger ? 'danger-solid' : 'primary'}`} disabled={!ok || busy} onClick={onConfirm}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ---------- Small charts ----------
export function Sparkbars({ values, color, width = 60, height = 30 }: { values: number[]; color: string; width?: number; height?: number }) {
  const max = Math.max(...values, 1);
  const bw = width / values.length - 2;
  return (
    <svg width={width} height={height} aria-hidden>
      {values.map((v, i) => {
        const h = Math.max(3, (v / max) * (height - 2));
        const last = i === values.length - 1;
        return (
          <rect
            key={i}
            x={i * (bw + 2)}
            y={height - h}
            width={bw}
            height={h}
            rx={1.5}
            fill={color}
            opacity={last ? 1 : 0.42}
          />
        );
      })}
    </svg>
  );
}

export function Meter({ fraction, color }: { fraction: number; color: string }) {
  return (
    <div className="meterbar">
      <div style={{ width: `${Math.min(100, Math.max(0, fraction * 100))}%`, background: color }} />
    </div>
  );
}

// ---------- Debounced search input ----------
export function SearchInput({ placeholder, onChange, initial = '' }: { placeholder: string; onChange: (v: string) => void; initial?: string }) {
  const [val, setVal] = useState(initial);
  const timer = useRef<number | undefined>(undefined);
  return (
    <div className="searchbox" style={{ minWidth: 240 }}>
      <span style={{ color: 'var(--text-dim)' }}>
        <Icon name="search" size={14} />
      </span>
      <input
        value={val}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value;
          setVal(v);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => onChange(v), 300);
        }}
        aria-label={placeholder}
      />
    </div>
  );
}

// ---------- Toggle ----------
export function SwitchRow({ label, on, onToggle, disabled }: { label: string; on: boolean; onToggle: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="switch-row">
      <span>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={`switch${on ? ' on' : ''}`}
        onClick={() => !disabled && onToggle(!on)}
        style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
      />
    </div>
  );
}
