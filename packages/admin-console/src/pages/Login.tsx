import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError, friendlyError } from '../lib/http';
import { Icon } from '../components/icons';

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password, needsMfa && code ? code : undefined);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'mfa_required') {
        setNeedsMfa(true);
      } else {
        setError(friendlyError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <div className="card card-pad login-card">
        <div className="row" style={{ marginBottom: 18 }}>
          <div className="sidebar-logo">
            <Icon name="mail" size={16} />
          </div>
          <div>
            <div className="sidebar-title" style={{ fontSize: 15 }}>Valasys Mail</div>
            <div className="sidebar-sub">
              <span className="env">ADMIN</span> console
            </div>
          </div>
        </div>

        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="field">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              className="input"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={needsMfa}
            />
          </div>
          <div className="field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={needsMfa}
            />
          </div>
          {needsMfa ? (
            <div className="field">
              <label htmlFor="login-code">Two-factor code</label>
              <input
                id="login-code"
                className="input mono"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123 456"
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\s+/g, ''))}
              />
              <div className="section-note">This account has TOTP enabled. Codes can be pasted.</div>
            </div>
          ) : null}
          {error ? (
            <div className="error-banner" role="alert">
              {error}
            </div>
          ) : null}
          <button className="btn primary block" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : needsMfa ? 'Verify & sign in' : 'Sign in'}
          </button>
          {needsMfa ? (
            <button
              type="button"
              className="btn block"
              onClick={() => {
                setNeedsMfa(false);
                setCode('');
                setError(null);
              }}
            >
              Back
            </button>
          ) : null}
        </form>

        <div className="section-note" style={{ marginTop: 16, textAlign: 'center' }}>
          Internal operators only. All privileged actions are audit-logged.
        </div>
      </div>
    </div>
  );
}
