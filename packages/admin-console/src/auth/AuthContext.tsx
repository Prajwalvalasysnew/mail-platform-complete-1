import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as api from '../api/operations';
import { registerSessionExpiredHandler, setSessionToken } from '../lib/http';
import type { AdminRole, Me } from '../api/types';
import { roleAtLeast } from '../api/types';

interface AuthState {
  status: 'anonymous' | 'authenticated';
  admin: Me | null;
  /** true while the user typed correct credentials but the account wants a TOTP code */
  login: (email: string, password: string, code?: string) => Promise<void>;
  logout: () => Promise<void>;
  hasRole: (min: AdminRole) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<Me | null>(null);
  const queryClient = useQueryClient();

  const clearIdentity = useCallback(() => {
    // Identity-boundary purge: cancel in-flight queries and drop every cached
    // response for the previous admin before showing the login screen.
    setSessionToken(null);
    setAdmin(null);
    queryClient.cancelQueries();
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    registerSessionExpiredHandler(clearIdentity);
  }, [clearIdentity]);

  const login = useCallback(
    async (email: string, password: string, code?: string) => {
      const res = await api.login({ email, password, code });
      setSessionToken(res.token);
      const who = await api.me();
      setAdmin(who);
    },
    []
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Even if revocation fails (network, expired token) the local identity
      // is still purged.
    }
    clearIdentity();
  }, [clearIdentity]);

  const value = useMemo<AuthState>(
    () => ({
      status: admin ? 'authenticated' : 'anonymous',
      admin,
      login,
      logout,
      hasRole: (min) => (admin ? roleAtLeast(admin.role, min) : false),
    }),
    [admin, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
