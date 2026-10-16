export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

let token: string | null = sessionStorage.getItem('valasys.session');
let onUnauthorized: (() => void) | null = null;

export function setToken(next: string | null) {
  token = next;
  if (next) sessionStorage.setItem('valasys.session', next);
  else sessionStorage.removeItem('valasys.session');
}

export function hasToken() { return Boolean(token); }
export function handleUnauthorized(fn: () => void) { onUnauthorized = fn; }

type Options = { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: unknown; anonymous?: boolean };

export async function request<T>(path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!options.anonymous && token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    if (response.status === 401 && !options.anonymous) onUnauthorized?.();
    throw new ApiError(response.status, payload?.error ?? `http_${response.status}`, payload?.message ?? 'Request failed', payload?.details);
  }
  return payload as T;
}

export interface Membership { customer_id: string; role: string; org_name?: string; customer_name?: string }
export interface Identity {
  user: { id: string; email: string; name?: string | null; mfa_enabled?: boolean };
  current_customer_id: string | null;
  current_role: string | null;
  memberships: Membership[];
}

export const api = {
  register: (body: { email: string; password: string; name?: string; org_name?: string }) => request<{ token: string }>('/auth/register', { method: 'POST', body, anonymous: true }),
  login: (body: { email: string; password: string }) => request<{ token: string; mfa_required: boolean }>('/auth/login', { method: 'POST', body, anonymous: true }),
  mfa: (code: string) => request<{ ok: true }>('/auth/mfa', { method: 'POST', body: { code } }),
  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST', body: {} }),
  me: () => request<Identity>('/auth/me'),
  switchOrg: (customer_id: string) => request('/auth/switch-org', { method: 'POST', body: { customer_id } }),
  domains: () => request<{ domains: any[] }>('/account/domains'),
  createDomain: (domain: string) => request<any>('/account/domains', { method: 'POST', body: { domain } }),
  verifyDomain: (id: string) => request<any>(`/account/domains/${encodeURIComponent(id)}/verify`, { method: 'POST' }),
  deleteDomain: (id: string) => request(`/account/domains/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  keys: () => request<{ keys: any[] }>('/account/api-keys'),
  createKey: (name: string) => request<any>('/account/api-keys', { method: 'POST', body: { name, scopes: ['send', 'messages', 'domains', 'templates', 'webhooks', 'workflows'] } }),
  deleteKey: (id: string) => request(`/account/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  webhooks: () => request<{ webhooks: any[] }>('/account/webhooks'),
  createWebhook: (url: string) => request<any>('/account/webhooks', { method: 'POST', body: { url, events: ['delivered', 'bounced', 'complained'] } }),
  updateWebhook: (id: string, body: { enabled?: boolean; events?: string[] }) => request<any>(`/account/webhooks/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  rotateWebhookSecret: (id: string) => request<any>(`/account/webhooks/${encodeURIComponent(id)}/rotate-secret`, { method: 'POST' }),
  deleteWebhook: (id: string) => request(`/account/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  team: () => request<{ members: any[] }>('/team/members'),
  billing: () => request<any>('/account/billing'),
  analytics: (period = '7d') => request<any>(`/account/data/analytics/summary?period=${encodeURIComponent(period)}`),
  messages: () => request<{ messages: any[] }>('/account/data/messages?limit=100'),
  message: (id: string) => request<{ message: any; events: any[] }>(`/account/data/messages/${encodeURIComponent(id)}`),
  messageActivity: () => request<{ events?: any[]; activity?: any[]; items?: any[] }>('/account/data/messages/activity?limit=100'),
  dmarcSummary: () => request<any>('/account/data/dmarc/summary?days=30'),
  dmarcSources: () => request<{ sources: any[] }>('/account/data/dmarc/sources?days=30&limit=100'),
  dmarcAddress: () => request<any>('/account/data/dmarc/reporting-address'),
  suppressions: () => request<{ suppressions: any[] }>('/account/data/suppressions?limit=100'),
  addSuppression: (email: string, reason = 'manual') => request('/account/data/suppressions', { method: 'POST', body: { email, reason } }),
  deleteSuppression: (email: string) => request(`/account/data/suppressions/${encodeURIComponent(email)}`, { method: 'DELETE' }),
  templates: () => request<{ templates: any[] }>('/account/data/templates'),
  createTemplate: (body: { name: string; subject: string; text_body: string }) => request<any>('/account/data/templates', { method: 'POST', body }),
  deleteTemplate: (id: string) => request(`/account/data/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workflows: () => request<{ workflows: any[]; total: number }>('/account/data/workflows'),
  createWorkflow: (body: { name: string; description?: string }) => request<any>('/account/data/workflows', { method: 'POST', body }),
  deleteWorkflow: (id: string) => request(`/account/data/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  sessions: () => request<{ sessions: any[] }>('/auth/sessions'),
  revokeSession: (id: string) => request(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  sso: () => request<{ sso_enforced: boolean }>('/account/settings/sso'),
  setSso: (enforced: boolean) => request<{ sso_enforced: boolean }>('/account/settings/sso', { method: 'PATCH', body: { enforced } }),
};
