/**
 * Response/request types for the admin plane, transcribed from
 * `packages/api/src/routes/admin.ts` and the shared query helpers.
 * When the OpenAPI artifact grows the /admin plane these should be replaced
 * by the generated client (`@platform/api-client/admin`).
 */

export type AdminRole = 'support' | 'operator' | 'admin' | 'superadmin';

export const ROLE_ORDER: AdminRole[] = ['support', 'operator', 'admin', 'superadmin'];
export function roleAtLeast(role: AdminRole, min: AdminRole): boolean {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);
}

export interface LoginResponse {
  token: string;
  role: AdminRole;
  expires_at: string;
}

export interface Me {
  admin_user_id: string;
  email: string;
  role: AdminRole;
}

// ---- Tenants ----
export type CustomerStatus = 'active' | 'pending' | 'suspended' | string;
export type CustomerTier = 'free' | 'paid' | 'enterprise' | string;

export interface CustomerRow {
  id: string;
  email: string;
  name: string | null;
  tier: CustomerTier;
  status: CustomerStatus;
  billing_status: string | null;
  kyc_level: string | null;
  daily_quota: number;
  monthly_quota: number;
  created_at: string;
  updated_at: string;
}

export interface CustomerListResponse {
  customers: CustomerRow[];
  next_cursor: string | null;
}

export interface CustomerOverview {
  customer: CustomerRow & Record<string, unknown>;
  members?: Array<{ id: string; email: string; name: string | null; status: string; mfa_enabled: boolean; role: string }>;
  api_keys?: Array<{ id: string; name: string; key_prefix: string; scopes: string[]; key_type: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null; created_at: string }>;
  domains?: Array<{ id: string; domain: string; status: string; created_at: string } & Record<string, unknown>>;
  recent_messages?: Array<Record<string, unknown>>;
  usage?: Record<string, unknown>;
  notes?: SupportNote[];
  audit?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface SupportNote {
  id: string;
  body: string;
  visibility: 'internal' | 'escalation';
  created_at: string;
  admin_email?: string | null;
  [k: string]: unknown;
}

// ---- Platform overview ----
export interface OverviewResponse {
  customers_by_status: Record<string, number>;
  messages_24h: { by_status: Record<string, number>; total: number };
  rates_24h: { bounce_rate: number; delivery_rate: number };
  send_queue: { waiting?: number; active?: number; delayed?: number; failed?: number };
  suppressions_total: number;
}

// ---- Review queue (abuse) ----
export interface ReviewQueueItem {
  id: string;
  message_id: string;
  customer_id: string;
  risk_score: number;
  reasons: string[] | string | null;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  reviewed_at: string | null;
  [k: string]: unknown;
}

export interface ReviewQueueList {
  items: ReviewQueueItem[];
  next_cursor?: string;
}

export interface ReviewQueueStats {
  pending: number;
  approved_today: number;
  rejected_today: number;
  avg_risk_score: number;
  oldest_pending_seconds: number;
}

// ---- Deliverability ----
export interface PoolHealth {
  pool: string;
  sent: number;
  bounced: number;
  complained: number;
  bounce_rate: number;
  complaint_rate: number;
  action: 'ok' | 'throttle' | 'pause';
  reasons: string[];
}

export interface BlocklistListing {
  ip: string;
  provider: string;
  listed: boolean;
  return_code: string | null;
  checked_at: string;
}

export interface ReputationSnapshot {
  ip: string;
  snapshot_date: string;
  google_reputation: string | null;
  google_spam_rate: number | null;
  snds_color: string | null;
  bounce_rate: number | null;
  complaint_rate: number | null;
}

export interface PoolIp {
  ip: string;
  ptr_record: string | null;
  warmup_stage: number;
  status: string;
  dedicated_customer_id: string | null;
  blocklist_listings: BlocklistListing[];
  reputation_snapshot: ReputationSnapshot | null;
}

export interface ReputationPool {
  pool_id: string;
  health: PoolHealth | null;
  ips: PoolIp[];
}

// ---- Support tickets ----
export type TicketStatus = 'open' | 'pending' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TicketCategory = 'general' | 'billing' | 'deliverability' | 'technical' | 'abuse' | 'account';

export interface TicketRow {
  id: string;
  customer_id: string;
  customer_email: string;
  customer_name: string | null;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: TicketCategory;
  assigned_admin_user_id: string | null;
  assigned_admin_email: string | null;
  ai_summary: string | null;
  ai_suggested_priority: string | null;
  ai_suggested_category: string | null;
  ai_confidence: number | null;
  last_message_at: string;
  created_at: string;
  updated_at: string;
  first_response_due_at?: string | null;
  resolution_due_at?: string | null;
  unread?: boolean;
  [k: string]: unknown;
}

export interface TicketMessage {
  id: string;
  author_type: 'customer' | 'admin' | 'system' | string;
  author_user_email?: string | null;
  author_admin_email?: string | null;
  body: string;
  internal: boolean;
  created_at: string;
  [k: string]: unknown;
}

export interface TicketDetail {
  ticket: TicketRow;
  messages: TicketMessage[];
  [k: string]: unknown;
}

export interface CannedResponse {
  id: string;
  title: string;
  body: string;
  category: TicketCategory | null;
  [k: string]: unknown;
}

// ---- DLQ ----
export interface DeadLetterItem {
  id: string;
  original_job_id?: string;
  source_queue: string;
  failed_reason: string;
  attempts_made: number;
  dead_lettered_at: string;
  payload: unknown;
}

export interface DeadLetterList {
  jobs: DeadLetterItem[];
  limit: number;
  offset: number;
  total: number;
}

// ---- Audit ----
export interface AuditRow {
  id: string;
  actor: string | null;
  action: string;
  resource: string | null;
  customer_id: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  occurred_at: string;
  [k: string]: unknown;
}

// ---- Billing ----
export interface BillingEventSummary {
  provider_event_id: string;
  type: string;
  provider: string | null;
  processed_at: string;
  replayed_at: string | null;
  replay_count: number;
  replayable: boolean;
}

export interface ReconcileResult {
  ok: boolean;
  total_drift: number;
  by_customer: Array<{ customer_id: string; drift: number } & Record<string, unknown>>;
  alert: 'drift_detected' | 'clean';
}

// ---- Admin team / elevations ----
export interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  role: AdminRole;
  disabled: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface ElevationRow {
  id: string;
  admin_user_id: string;
  email: string;
  role: AdminRole;
  reason: string;
  granted_by: string;
  break_glass: boolean;
  expires_at: string;
  created_at: string;
}

// ---- Retention ----
export interface RetentionParams {
  message_body_retention_days?: number;
  event_retention_days?: number;
  audit_retention_days?: number;
  review_queue_retention_days?: number;
}
