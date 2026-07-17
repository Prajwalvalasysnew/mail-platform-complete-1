/**
 * Request layer for the admin plane.
 *
 * Every request goes to a RELATIVE `/api/...` path with same-origin
 * credentials — the deployment gateway (or the Vite dev proxy) maps
 * `admin.<domain>/api/*` to the core API's `/admin/*` plane. Browser code
 * never sees or constructs the API origin, and endpoints are never derived
 * from URL params / postMessage input: only the closed operation registry in
 * `src/api/operations.ts` calls this module.
 *
 * Sessions: the backend sets a `__Host-`-prefixed, HttpOnly, SameSite=Strict
 * session cookie at login, so the browser carries identity automatically and
 * the token never has to touch storage. Login also returns a per-session CSRF
 * secret which is held in memory and attached to every mutating request as
 * `x-csrf-token`; after a page reload `GET /admin/auth/bootstrap` restores the
 * identity from the cookie and rotates a fresh CSRF secret. The bearer token
 * from the login response is additionally kept in memory (never persisted) as
 * a fallback for deployments where the cookie can't be set.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, retryAfter?: number, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.details = details;
  }
}

let sessionToken: string | null = null;
let csrfToken: string | null = null;
let onSessionExpired: (() => void) | null = null;

export function setSessionToken(token: string | null) {
  sessionToken = token;
}
export function hasSessionToken() {
  return sessionToken !== null;
}
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}
export function registerSessionExpiredHandler(fn: () => void) {
  onSessionExpired = fn;
}

const FRIENDLY: Record<string, string> = {
  admin_auth_required: 'You need to sign in to the admin console.',
  invalid_admin_session: 'Your session has expired. Sign in again.',
  insufficient_role: 'Your admin role does not permit this action.',
  invalid_credentials: 'Email or password is incorrect.',
  mfa_required: 'Enter your two-factor authentication code.',
  mfa_invalid: 'That authentication code is not valid.',
  account_locked: 'Account temporarily locked after repeated failed logins.',
  rate_limited: 'Too many requests — slow down and retry shortly.',
  not_found: 'The requested record no longer exists.',
  validation_failed: 'The request was rejected by server-side validation.',
  cannot_self_demote: 'You cannot demote or disable your own superadmin account.',
  email_exists: 'An admin with this email already exists.',
  not_replayable: 'This event predates raw-payload storage and cannot be replayed.',
  password_login_disabled: 'Password login is disabled — use SSO.',
  csrf_failed: 'Security token expired — reload the page and try again.',
  origin_mismatch: 'Request blocked: unexpected origin for the admin console.',
  cross_site_blocked: 'Request blocked: cross-site requests are not allowed here.',
  note_required: 'A note explaining the decision is required.',
};

export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    const base = FRIENDLY[err.code] ?? err.message ?? err.code;
    if (err.status === 429 && err.retryAfter) return `${base} Retry in ${err.retryAfter}s.`;
    return base;
  }
  if (err instanceof TypeError) return 'Network error — the API gateway is unreachable.';
  return err instanceof Error ? err.message : 'Unexpected error.';
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** login/MFA endpoints run without a session */
  anonymous?: boolean;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(`/api${path}`, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }

  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!opts.anonymous && sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;
  // Cookie-session CSRF: attach the per-session secret to every mutation.
  if (!opts.anonymous && csrfToken && method !== 'GET') headers['x-csrf-token'] = csrfToken;

  const res = await fetch(url.pathname + url.search, {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  let payload: any = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const code = payload?.error ?? `http_${res.status}`;
    const retryAfter =
      payload?.retry_after ?? (res.headers.get('Retry-After') ? Number(res.headers.get('Retry-After')) : undefined);
    const err = new ApiError(res.status, code, payload?.message ?? FRIENDLY[code] ?? `Request failed (${res.status})`, retryAfter, payload?.details);
    // A dead session anywhere in the app stops mutations and returns to login.
    if (res.status === 401 && !opts.anonymous && onSessionExpired) onSessionExpired();
    throw err;
  }

  return payload as T;
}
