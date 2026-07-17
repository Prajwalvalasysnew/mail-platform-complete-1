import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as api from '../api/operations';
import { registerSessionExpiredHandler, setCsrfToken, setSessionToken } from '../lib/http';
import type { AdminRole, Me } from '../api/types';
import { roleAtLeast } from '../api/types';

interface AuthState {
  /** `restoring` while the cookie-session bootstrap probe is in flight on load. */
  status: 'restoring' | 'anonymous' | 'authenticated';
  admin: Me | null;
  /** Server-derived capability map from /auth/bootstrap (role → allowed actions). */
  capabilities: Record<string, boolean>;
  login: (email: string, password: string, code?: string) => Promise<void>;
  logout: () => Promise<void>;
  hasRole: (min: AdminRole) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<Me | null>(null);
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({});
  const [restoring, setRestoring] = useState(true);
  const queryClient = useQueryClient();
  const bootProbeSent = useRef(false);

  const clearIdentity = useCallback(() => {
    // Identity-boundary purge: cancel in-flight queries and drop every cached
    // response for the previous admin before showing the login screen.
    setSessionToken(null);
    setCsrfToken(null);
    setAdmin(null);
    setCapabilities({});
    queryClient.cancelQueries();
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    registerSessionExpiredHandler(clearIdentity);
  }, [clearIdentity]);

  // Cookie-session restore: the __Host- session cookie survives reloads, so a
  // single bootstrap call re-establishes identity + a fresh CSRF secret
  // without forcing a re-login. 401 just means "no live session" — show login.
  useEffect(() => {
    if (bootProbeSent.current) return;
    bootProbeSent.current = true;
    (async () => {
      try {
        const res = await api.bootstrap();
        setCsrfToken(res.csrf_token);
        setCapabilities(res.capabilities ?? {});
        setAdmin(res.admin);
      } catch {
        // No session cookie (or expired) — anonymous is the correct state.
      } finally {
        setRestoring(false);
      }
    })();
  }, []);

  const login = useCallback(
    async (email: string, password: string, code?: string) => {
      const res = await api.login({ email, password, code });
      // The HttpOnly cookie set by the server is the primary session carrier;
      // the bearer token is kept in memory only as a non-cookie fallback.
      setSessionToken(res.token);
      setCsrfToken(res.csrf_token ?? null);
      const boot = await api.bootstrap();
      setCapabilities(boot.capabilities ?? {});
      setAdmin(boot.admin);
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
      status: admin ? 'authenticated' : restoring ? 'restoring' : 'anonymous',
      admin,
      capabilities,
      login,
      logout,
      hasRole: (min) => (admin ? roleAtLeast(admin.role, min) : false),
    }),
    [admin, capabilities, restoring, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
