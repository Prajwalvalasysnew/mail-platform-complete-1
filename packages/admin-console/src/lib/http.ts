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
 * The current backend authenticates admins with a bearer session token
 * (`POST /admin/auth/login` -> `{ token }`). Until the gateway/identity layer
 * grows `__Host-` cookie sessions (a release-blocking backend prerequisite in
 * the frontend architecture doc), the token is held in memory only and
 * attached here. It is intentionally NOT persisted to local/session storage.
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
let onSessionExpired: (() => void) | null = null;

export function setSessionToken(token: string | null) {
  sessionToken = token;
}
export function hasSessionToken() {
  return sessionToken !== null;
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

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!opts.anonymous && sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;

  const res = await fetch(url.pathname + url.search, {
    method: opts.method ?? 'GET',
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
