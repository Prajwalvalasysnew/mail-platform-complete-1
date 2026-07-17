/**
 * Closed, typed operation registry for the admin plane.
 *
 * Every network call the console can make is enumerated here as a named
 * function with a fixed method + path. Nothing outside this file derives an
 * endpoint from a string, which is the client-side-CSRF control required by
 * the frontend architecture contract.
 */
import { request } from '../lib/http';
import type {
  AdminUserRow,
  AuditRow,
  BillingEventSummary,
  BootstrapResponse,
  CannedResponse,
  CustomerListResponse,
  CustomerOverview,
  DeadLetterItem,
  DeadLetterList,
  ElevationRow,
  GatewayInfo,
  GatewayKey,
  KycListResponse,
  KycLevel,
  KycStatus,
  LoginResponse,
  Me,
  OverviewResponse,
  PlatformSettings,
  PoolHealth,
  ReconcileResult,
  ReputationPool,
  RetentionParams,
  ReviewQueueList,
  ReviewQueueStats,
  SupportNote,
  TicketDetail,
  TicketMessage,
  TicketRow,
  TimeseriesResponse,
  TopTenantsResponse,
} from './types';

// ---- Auth ----
export const login = (body: { email: string; password: string; code?: string }) =>
  request<LoginResponse>('/auth/login', { method: 'POST', body, anonymous: true });
export const logout = () => request<{ ok: true }>('/auth/logout', { method: 'POST' });
export const me = () => request<Me>('/auth/me');
/** Cookie-session restore on page load: identity + fresh CSRF secret + capability map. */
export const bootstrap = () => request<BootstrapResponse>('/auth/bootstrap');

// ---- Platform overview ----
export const overview = () => request<OverviewResponse>('/overview');
export const overviewTimeseries = (days = 7) => request<TimeseriesResponse>('/overview/timeseries', { query: { days } });
export const topTenants = (q: { hours?: number; limit?: number } = {}) =>
  request<TopTenantsResponse>('/overview/top-tenants', { query: q });

// ---- Tenants ----
export const listCustomers = (q: { q?: string; status?: string; tier?: string; limit?: number; before?: string }) =>
  request<CustomerListResponse>('/customers', { query: q });
export const customerOverview = (id: string) => request<CustomerOverview>(`/customers/${encodeURIComponent(id)}`);
export const listCustomerNotes = (id: string) =>
  request<{ notes: SupportNote[] }>(`/customers/${encodeURIComponent(id)}/support-notes`);
export const createCustomerNote = (id: string, body: { body: string; visibility?: 'internal' | 'escalation' }) =>
  request<{ note: SupportNote }>(`/customers/${encodeURIComponent(id)}/support-notes`, { method: 'POST', body });
export const suspendCustomer = (body: { customer_id: string; reason?: string }) =>
  request<{ suspended: string }>('/customers/suspend', { method: 'POST', body });
export const reinstateCustomer = (body: { customer_id: string }) =>
  request<{ reinstated: string }>('/customers/reinstate', { method: 'POST', body });
export const updateCustomer = (
  id: string,
  body: { tier?: string; daily_quota?: number; monthly_quota?: number; events_retention_days?: number | null; body_retention_days?: number | null }
) => request<{ updated: string }>(`/customers/${encodeURIComponent(id)}`, { method: 'PATCH', body });

// ---- KYC / verification ----
export const kycList = (q: { status?: KycStatus | 'open' | 'all'; limit?: number; before?: string }) =>
  request<KycListResponse>('/kyc', { query: q });
export const kycApprove = (id: string, body: { note?: string; level?: KycLevel } = {}) =>
  request<{ customer_id: string; kyc_status: KycStatus; kyc_level: string }>(`/kyc/${encodeURIComponent(id)}/approve`, { method: 'POST', body });
export const kycRequestInfo = (id: string, body: { note: string }) =>
  request<{ customer_id: string; kyc_status: KycStatus; kyc_level: string }>(`/kyc/${encodeURIComponent(id)}/request-info`, { method: 'POST', body });
export const kycReject = (id: string, body: { note: string }) =>
  request<{ customer_id: string; kyc_status: KycStatus; kyc_level: string }>(`/kyc/${encodeURIComponent(id)}/reject`, { method: 'POST', body });

// ---- Support ----
export const listTickets = (q: { status?: string; priority?: string; category?: string; assigned?: 'me' | 'unassigned'; customer_id?: string; limit?: number; before?: string }) =>
  request<{ tickets: TicketRow[]; next_cursor: string | null }>('/support-tickets', { query: q });
export const ticketUnreadCount = () => request<{ unread: number }>('/support-tickets/unread-count');
export const ticketDetail = (id: string) => request<TicketDetail>(`/support-tickets/${encodeURIComponent(id)}`);
export const markTicketRead = (id: string) =>
  request<{ ok: true }>(`/support-tickets/${encodeURIComponent(id)}/read`, { method: 'POST' });
export const replyTicket = (id: string, body: { body: string; internal?: boolean }) =>
  request<{ message: TicketMessage }>(`/support-tickets/${encodeURIComponent(id)}/messages`, { method: 'POST', body });
export const updateTicket = (
  id: string,
  body: { status?: string; priority?: string; category?: string; assign_to_me?: boolean; assigned_admin_user_id?: string | null }
) => request<{ ticket: TicketRow }>(`/support-tickets/${encodeURIComponent(id)}`, { method: 'PATCH', body });
export const triageTicket = (id: string) =>
  request<{ ticket: TicketRow; triage: Record<string, unknown> }>(`/support-tickets/${encodeURIComponent(id)}/triage`, { method: 'POST' });
export const suggestReply = (id: string) =>
  request<{ draft: string; model: string }>(`/support-tickets/${encodeURIComponent(id)}/suggest-reply`, { method: 'POST' });
export const slaBreaches = () => request<{ breaches: TicketRow[] }>('/support-tickets/sla-breaches');
export const listCanned = (category?: string) =>
  request<{ canned_responses: CannedResponse[] }>('/support/canned-responses', { query: { category } });

// ---- Review queue (abuse) ----
export const reviewQueue = (q: { limit?: number; cursor?: string; min_score?: number; max_score?: number }) =>
  request<ReviewQueueList>('/review-queue', { query: q });
export const reviewQueueStats = () => request<ReviewQueueStats>('/review-queue/stats');
export const approveReview = (id: string) =>
  request<{ approved: string }>(`/review-queue/${encodeURIComponent(id)}/approve`, { method: 'POST' });
export const rejectReview = (id: string) =>
  request<{ rejected: string }>(`/review-queue/${encodeURIComponent(id)}/reject`, { method: 'POST' });
export const bulkReview = (body: { action: 'approve' | 'reject'; ids: string[] }) =>
  request<{ action: string; approved: string[]; rejected: string[]; processed: number }>('/review-queue/bulk', { method: 'POST', body });

// ---- Deliverability ----
export const poolHealth = () => request<{ pools: PoolHealth[] }>('/deliverability/pool-health');
export const reputationPools = () => request<{ pools: ReputationPool[] }>('/reputation/pools');
export const blocklistScan = () =>
  request<{ listings: Array<Record<string, unknown>> }>('/deliverability/blocklist-scan', { method: 'POST' });

// ---- DLQ ----
export const listDlq = (q: { limit?: number; offset?: number }) => request<DeadLetterList>('/dlq', { query: q });
export const dlqDetail = (id: string) => request<{ job: DeadLetterItem & { state: string } }>(`/dlq/${encodeURIComponent(id)}`);
export const replayDlq = (id: string) =>
  request<{ replayed: boolean; id: string; source_queue: string; new_job_id?: string }>(`/dlq/${encodeURIComponent(id)}/replay`, { method: 'POST' });
export const deleteDlq = (id: string) => request<{ deleted: string }>(`/dlq/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const purgeDlq = () => request<{ purged: number }>('/dlq/purge', { method: 'POST', body: { confirm: true } });

// ---- Audit ----
export const auditLog = (q: { limit?: number; cursor?: number; action?: string } = {}) =>
  request<{ audit: AuditRow[]; next_cursor: number | null }>('/audit', { query: q });

// ---- Billing ----
export const billingEvents = (q: { limit?: number; before?: string }) =>
  request<{ events: BillingEventSummary[] }>('/billing-events', { query: q });
export const billingEventDetail = (id: string) =>
  request<BillingEventSummary & { payload: unknown }>(`/billing-events/${encodeURIComponent(id)}`);
export const replayBillingEvent = (id: string) =>
  request<{ replayed: string; applied: unknown }>(`/billing-events/${encodeURIComponent(id)}/replay`, { method: 'POST' });
export const reconcileMetering = () => request<ReconcileResult>('/billing/reconcile', { method: 'POST' });

// ---- Payment gateways ----
export const paymentGateways = () => request<{ gateways: GatewayInfo[] }>('/payment-gateways');
export const updatePaymentGateway = (key: GatewayKey, body: { enabled: boolean; mode?: 'live' | 'test' }) =>
  request<{ gateway: GatewayKey; config: { enabled: boolean; mode?: 'live' | 'test' } }>(`/payment-gateways/${encodeURIComponent(key)}`, { method: 'PUT', body });

// ---- Settings / retention ----
export const getSettings = () => request<{ settings: PlatformSettings }>('/settings');
export const updateSettings = (body: Partial<PlatformSettings>) =>
  request<{ ok: true; updated_groups: string[]; settings: PlatformSettings }>('/settings', { method: 'PUT', body });
export const runRetention = (body: RetentionParams) => request<{ ok: true; result: Record<string, unknown> }>('/retention/run', { method: 'POST', body });

// ---- Admin team ----
export const listAdmins = () => request<{ admins: AdminUserRow[] }>('/admins');
export const createAdmin = (body: { email: string; name?: string; role: string; password: string }) =>
  request<{ id: string; email: string; role: string }>('/admins', { method: 'POST', body });
export const updateAdmin = (id: string, body: { role?: string; disabled?: boolean; name?: string | null }) =>
  request<{ updated: string }>(`/admins/${encodeURIComponent(id)}`, { method: 'PATCH', body });
export const resetAdminPassword = (id: string, password: string) =>
  request<{ ok: true }>(`/admins/${encodeURIComponent(id)}/password`, { method: 'POST', body: { password } });

// ---- Elevations ----
export const listElevations = () => request<{ elevations: ElevationRow[] }>('/elevations');
export const grantElevation = (body: { admin_user_id: string; role: string; reason: string; ttl_minutes: number }) =>
  request<ElevationRow>('/elevations', { method: 'POST', body });
export const breakGlass = (body: { role: string; reason: string; ttl_minutes: number }) =>
  request<ElevationRow>('/elevations/break-glass', { method: 'POST', body });
export const revokeElevation = (id: string) => request<void>(`/elevations/${encodeURIComponent(id)}`, { method: 'DELETE' });
