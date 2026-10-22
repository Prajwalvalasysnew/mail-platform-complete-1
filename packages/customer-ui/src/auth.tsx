import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, handleUnauthorized, hasToken, setToken, type Identity } from './api';

type Status = 'restoring' | 'anonymous' | 'mfa' | 'authenticated';
interface AuthValue {
  status: Status;
  identity: Identity | null;
  login(email: string, password: string): Promise<void>;
  register(input: { email: string; password: string; name: string; org_name: string }): Promise<void>;
  confirmMfa(code: string): Promise<void>;
  logout(): Promise<void>;
  switchOrg(id: string): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('restoring');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const queryClient = useQueryClient();

  const clear = useCallback(() => {
    setToken(null); sessionStorage.removeItem('valasys.mfa_pending'); setIdentity(null); setStatus('anonymous'); queryClient.clear();
  }, [queryClient]);

  const loadIdentity = useCallback(async () => {
    const me = await api.me(); setIdentity(me); setStatus('authenticated');
  }, []);

  useEffect(() => { handleUnauthorized(clear); }, [clear]);
  useEffect(() => {
    if (!hasToken()) { setStatus('anonymous'); return; }
    if (sessionStorage.getItem('valasys.mfa_pending') === 'true') { setStatus('mfa'); return; }
    void loadIdentity().catch(clear);
  }, [clear, loadIdentity]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login({ email, password });
    setToken(result.token);
    if (result.mfa_required) { sessionStorage.setItem('valasys.mfa_pending', 'true'); setStatus('mfa'); }
    else { sessionStorage.removeItem('valasys.mfa_pending'); await loadIdentity(); }
  }, [loadIdentity]);

  const register = useCallback(async (input: { email: string; password: string; name: string; org_name: string }) => {
    const result = await api.register(input); setToken(result.token); sessionStorage.removeItem('valasys.mfa_pending'); sessionStorage.setItem('valasys.onboarding', 'true'); await loadIdentity();
  }, [loadIdentity]);

  const confirmMfa = useCallback(async (code: string) => { await api.mfa(code); sessionStorage.removeItem('valasys.mfa_pending'); await loadIdentity(); }, [loadIdentity]);
  const logout = useCallback(async () => { try { await api.logout(); } finally { clear(); } }, [clear]);
  const switchOrg = useCallback(async (id: string) => { await api.switchOrg(id); queryClient.clear(); await loadIdentity(); }, [loadIdentity, queryClient]);

  const value = useMemo(() => ({ status, identity, login, register, confirmMfa, logout, switchOrg }), [status, identity, login, register, confirmMfa, logout, switchOrg]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
