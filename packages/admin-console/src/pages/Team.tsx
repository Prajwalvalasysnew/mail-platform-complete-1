import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/operations';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../components/Toast';
import { ApiError, friendlyError } from '../lib/http';
import { ConfirmModal, EmptyState, ErrorState, Loading, Modal, Pill } from '../components/ui';
import { Icon } from '../components/icons';
import { fmtAgo, fmtDate } from '../lib/format';
import type { AdminRole, AdminUserRow } from '../api/types';

const ROLE_CARDS: Array<{ role: AdminRole; can: string[]; cannot: string[] }> = [
  { role: 'superadmin', can: ['All admin + operator + support', 'Manage admin users & roles', 'Platform settings'], cannot: [] },
  { role: 'admin', can: ['Abuse queue & KYC', 'Suspend / warn tenants', 'Billing & gateways'], cannot: [] },
  { role: 'operator', can: ['Fleet, tenants, deliverability', 'IP pools & domains', 'Billing / suspend actions'], cannot: [] },
  { role: 'support', can: ['Support inbox only', 'Read-only tenant view'], cannot: ['No operational actions'] },
];

export function TeamPage() {
  const { admin, hasRole } = useAuth();
  const queryClient = useQueryClient();
  const isSuper = hasRole('superadmin');
  const [invite, setInvite] = useState(false);
  const [editing, setEditing] = useState<AdminUserRow | null>(null);

  const admins = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'admins'],
    queryFn: api.listAdmins,
    enabled: isSuper,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'admins'] });

  return (
    <>
      <div className="page-head">
        <div className="page-desc">
          Platform admins authenticate with email + password (bcrypt) and optionally TOTP 2FA. Roles:{' '}
          <b>support</b> → <b>operator</b> → <b>admin</b> → <b>superadmin</b>. All privileged actions are audit-logged.
        </div>
        {isSuper ? (
          <button className="btn primary" onClick={() => setInvite(true)}>
            <Icon name="plus" size={13} /> Invite admin
          </button>
        ) : null}
      </div>

      <div className="card card-pad">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 12 }}>
          {ROLE_CARDS.map((rc) => (
            <div
              key={rc.role}
              style={{
                border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px',
                background: admin?.role === rc.role ? 'var(--blue-wash)' : 'var(--bg-subtle)',
                borderColor: admin?.role === rc.role ? 'oklch(0.85 0.08 264)' : undefined,
              }}
            >
              <Pill tone={rc.role === 'superadmin' || rc.role === 'admin' ? 'blue' : 'outline'}>{rc.role}</Pill>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {rc.can.map((c) => (
                  <div key={c} style={{ fontSize: 11.5, color: 'var(--text-mid)' }}>✓ {c}</div>
                ))}
                {rc.cannot.map((c) => (
                  <div key={c} style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>✗ {c}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-pad" style={{ paddingBottom: 8 }}>
          <div className="card-title">Admin users</div>
        </div>
        {!isSuper ? (
          <div className="card-pad">
            <EmptyState title="Superadmin only" hint="Listing and managing admin users requires the superadmin role. Your own account details are in the sidebar." />
          </div>
        ) : admins.isPending ? (
          <Loading label="Loading admin users…" />
        ) : admins.isError ? (
          <div className="card-pad">
            {admins.error instanceof ApiError && admins.error.status === 403 ? (
              <EmptyState title="Superadmin only" />
            ) : (
              <ErrorState error={admins.error} retry={() => void admins.refetch()} />
            )}
          </div>
        ) : (
          <div className="table-wrap" tabIndex={0}>
            <table className="data">
              <thead>
                <tr>
                  <th>Admin user</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last login</th>
                  <th>Created</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {admins.data.admins.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="row">
                        <span className="avatar" style={{ width: 26, height: 26, fontSize: 10 }}>{a.email.slice(0, 2).toUpperCase()}</span>
                        <div>
                          <div className="cell-main">{a.name || a.email}</div>
                          <div className="cell-sub mono">{a.email}</div>
                        </div>
                      </div>
                    </td>
                    <td><Pill tone={a.role === 'superadmin' || a.role === 'admin' ? 'blue' : 'outline'}>{a.role}</Pill></td>
                    <td>{a.disabled ? <Pill tone="red">disabled</Pill> : <Pill tone="green">active</Pill>}</td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{a.last_login_at ? fmtAgo(a.last_login_at) : 'never'}</td>
                    <td style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{fmtDate(a.created_at)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn sm" onClick={() => setEditing(a)}>Edit</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {isSuper && admins.data ? (
          <div className="table-foot">
            <span>{admins.data.admins.length} admin users · sessions expire after 8h · all actions audit-logged</span>
          </div>
        ) : null}
      </div>

      <ElevationsCard />

      {invite ? <InviteModal onClose={() => { setInvite(false); invalidate(); }} /> : null}
      {editing ? <EditAdminModal row={editing} self={admin?.admin_user_id === editing.id} onClose={() => { setEditing(null); invalidate(); }} /> : null}
    </>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<AdminRole>('support');
  const [password, setPassword] = useState('');

  const create = useMutation({
    mutationFn: () => api.createAdmin({ email, name: name || undefined, role, password }),
    onSuccess: (d) => {
      toast(`Admin ${d.email} created with role ${d.role}.`);
      onClose();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  return (
    <Modal title="Invite admin" onClose={onClose}>
      <div className="field">
        <label>Email</label>
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label>Name (optional)</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Role</label>
        <select className="select" value={role} onChange={(e) => setRole(e.target.value as AdminRole)}>
          {(['support', 'operator', 'admin', 'superadmin'] as const).map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Temporary password (min 12 chars)</label>
        <input className="input mono" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <div className="section-note">Share out-of-band; the admin should rotate it and enroll TOTP on first login.</div>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!email || password.length < 12 || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Creating…' : 'Create admin'}
        </button>
      </div>
    </Modal>
  );
}

function EditAdminModal({ row, self, onClose }: { row: AdminUserRow; self: boolean; onClose: () => void }) {
  const toast = useToast();
  const [role, setRole] = useState<AdminRole>(row.role);
  const [disabled, setDisabled] = useState(row.disabled);
  const [newPassword, setNewPassword] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      if (role !== row.role || disabled !== row.disabled) {
        await api.updateAdmin(row.id, { role: role !== row.role ? role : undefined, disabled: disabled !== row.disabled ? disabled : undefined });
      }
      if (newPassword) await api.resetAdminPassword(row.id, newPassword);
    },
    onSuccess: () => {
      toast('Admin updated.');
      onClose();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  return (
    <Modal title={`Edit ${row.email}`} onClose={onClose}>
      {self ? (
        <div className="alert amber">
          <div className="body">You cannot demote or disable your own superadmin account.</div>
        </div>
      ) : null}
      <div className="field">
        <label>Role</label>
        <select className="select" value={role} onChange={(e) => setRole(e.target.value as AdminRole)} disabled={self}>
          {(['support', 'operator', 'admin', 'superadmin'] as const).map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <div className="switch-row">
        <span>Account disabled</span>
        <button
          type="button"
          role="switch"
          aria-checked={disabled}
          className={`switch${disabled ? ' on' : ''}`}
          onClick={() => !self && setDisabled(!disabled)}
          style={self ? { opacity: 0.5 } : undefined}
        />
      </div>
      <div className="field">
        <label>Reset password (min 12 chars, optional)</label>
        <input className="input mono" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={save.isPending || (newPassword.length > 0 && newPassword.length < 12)}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </Modal>
  );
}

function ElevationsCard() {
  const { admin, hasRole } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canSee = hasRole('operator');
  const [grant, setGrant] = useState(false);
  const [breakGlassOpen, setBreakGlassOpen] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);

  const elevations = useQuery({
    queryKey: ['admin', admin?.admin_user_id, 'elevations'],
    queryFn: api.listElevations,
    enabled: canSee,
    refetchInterval: 30_000,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['admin', admin?.admin_user_id, 'elevations'] });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeElevation(id),
    onSuccess: () => {
      toast('Elevation revoked.');
      setRevokeId(null);
      invalidate();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  if (!canSee) return null;

  const rows = elevations.data?.elevations ?? [];

  return (
    <div className="card">
      <div className="card-pad row" style={{ justifyContent: 'space-between', paddingBottom: 8 }}>
        <div>
          <div className="card-title">Just-in-time elevations</div>
          <div className="card-sub">Temporary role grants with reason, TTL, and full audit — four-eyes enforced for grants to others.</div>
        </div>
        <div className="row">
          {hasRole('admin') ? (
            <button className="btn sm" onClick={() => setGrant(true)}>Grant elevation</button>
          ) : null}
          <button className="btn sm danger" onClick={() => setBreakGlassOpen(true)}>Break-glass</button>
        </div>
      </div>
      {elevations.isPending ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState title="No active elevations" hint="Standing roles apply. Grants appear here with a live expiry." />
      ) : (
        <div className="table-wrap" tabIndex={0}>
          <table className="data">
            <thead>
              <tr>
                <th>Admin</th>
                <th>Effective role</th>
                <th>Reason</th>
                <th>Type</th>
                <th>Expires</th>
                {hasRole('admin') ? <th style={{ textAlign: 'right' }}>Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="mono" style={{ fontSize: 11.5 }}>{e.email}</td>
                  <td><Pill tone="blue">{e.role}</Pill></td>
                  <td style={{ fontSize: 12, maxWidth: 260 }}>{e.reason}</td>
                  <td>{e.break_glass ? <Pill tone="red">break-glass</Pill> : <Pill tone="outline">granted</Pill>}</td>
                  <td style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{fmtDate(e.expires_at)}</td>
                  {hasRole('admin') ? (
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn sm danger" onClick={() => setRevokeId(e.id)}>Revoke</button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {grant ? <GrantModal onClose={() => { setGrant(false); invalidate(); }} /> : null}
      {breakGlassOpen ? <BreakGlassModal onClose={() => { setBreakGlassOpen(false); invalidate(); }} /> : null}
      {revokeId ? (
        <ConfirmModal
          title="Revoke elevation"
          body="The elevated session loses its temporary role immediately. This is audit-logged."
          confirmLabel="Revoke"
          busy={revoke.isPending}
          onConfirm={() => revoke.mutate(revokeId)}
          onClose={() => setRevokeId(null)}
        />
      ) : null}
    </div>
  );
}

function GrantModal({ onClose }: { onClose: () => void }) {
  const { admin } = useAuth();
  const toast = useToast();
  const admins = useQuery({ queryKey: ['admin', admin?.admin_user_id, 'admins'], queryFn: api.listAdmins });
  const [target, setTarget] = useState('');
  const [role, setRole] = useState<AdminRole>('operator');
  const [reason, setReason] = useState('');
  const [ttl, setTtl] = useState('60');

  const grant = useMutation({
    mutationFn: () => api.grantElevation({ admin_user_id: target, role, reason, ttl_minutes: Number(ttl) }),
    onSuccess: () => {
      toast('Elevation granted.');
      onClose();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  return (
    <Modal title="Grant just-in-time elevation" onClose={onClose}>
      <div className="field">
        <label>Admin user</label>
        <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Select admin…</option>
          {(admins.data?.admins ?? [])
            .filter((a) => a.id !== admin?.admin_user_id && !a.disabled)
            .map((a) => (
              <option key={a.id} value={a.id}>{a.email} ({a.role})</option>
            ))}
        </select>
        <div className="section-note">Four-eyes: you cannot grant an elevation to yourself — use break-glass for emergencies.</div>
      </div>
      <div className="field">
        <label>Elevated role</label>
        <select className="select" value={role} onChange={(e) => setRole(e.target.value as AdminRole)}>
          {(['operator', 'admin', 'superadmin'] as const).map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Reason (audit-logged)</label>
        <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Incident #, change ticket, justification…" />
      </div>
      <div className="field">
        <label>TTL (minutes, max 1440)</label>
        <input className="input mono" type="number" min={1} max={1440} value={ttl} onChange={(e) => setTtl(e.target.value)} />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!target || reason.trim().length < 3 || grant.isPending} onClick={() => grant.mutate()}>
          {grant.isPending ? 'Granting…' : 'Grant elevation'}
        </button>
      </div>
    </Modal>
  );
}

function BreakGlassModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [role, setRole] = useState<AdminRole>('admin');
  const [reason, setReason] = useState('');
  const [ttl, setTtl] = useState('30');

  const bg = useMutation({
    mutationFn: () => api.breakGlass({ role, reason, ttl_minutes: Number(ttl) }),
    onSuccess: () => {
      toast('Break-glass elevation active — heavily audited. Re-login to pick up the new role.');
      onClose();
    },
    onError: (e) => toast(friendlyError(e), 'error'),
  });

  return (
    <Modal title="Break-glass self-elevation" onClose={onClose}>
      <div className="alert red">
        <div className="body">
          <div className="t">Emergency use only</div>
          Break-glass grants are flagged, short-TTL, and reviewed. Use a normal four-eyes grant when another admin is
          available.
        </div>
      </div>
      <div className="field">
        <label>Elevated role</label>
        <select className="select" value={role} onChange={(e) => setRole(e.target.value as AdminRole)}>
          {(['operator', 'admin', 'superadmin'] as const).map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Reason (audit-logged, required)</label>
        <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Describe the emergency…" />
      </div>
      <div className="field">
        <label>TTL (minutes)</label>
        <input className="input mono" type="number" min={1} max={1440} value={ttl} onChange={(e) => setTtl(e.target.value)} />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger-solid" disabled={reason.trim().length < 3 || bg.isPending} onClick={() => bg.mutate()}>
          {bg.isPending ? 'Elevating…' : 'Break glass'}
        </button>
      </div>
    </Modal>
  );
}
