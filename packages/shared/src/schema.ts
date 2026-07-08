import type { Generated, ColumnType } from 'kysely';

// Helpers
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

// =====================================================
// Table interfaces (mirror the SQL migration)
// =====================================================

export interface CustomersTable {
  id: Generated<string>;
  email: string;
  name: string | null;
  tier: Generated<'free' | 'paid' | 'enterprise'>;
  daily_quota: Generated<number>;
  monthly_quota: Generated<number>;
  billing_provider: Generated<'stripe' | 'paypal' | 'cashfree' | 'mock'>;
  stripe_customer_id: string | null;
  stripe_subscription_item_id: string | null;
  billing_status: Generated<'active' | 'past_due' | 'canceled' | 'trialing'>;
  status: Generated<'active' | 'suspended' | 'banned'>;
  kyc_level: Generated<'email' | 'domain' | 'payment' | 'business'>;
  new_account_until: Timestamp | null;
  email_verified_at: Timestamp | null;
  email_verify_token_hash: string | null;
  email_verify_token_expires_at: Timestamp | null;
  physical_address: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface ApiKeysTable {
  id: Generated<string>;
  customer_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes: Generated<string[]>;
  key_type: Generated<'secret' | 'publishable' | 'test'>;
  rotated_from: string | null;
  last_used_at: Timestamp | null;
  expires_at: Timestamp | null;
  revoked_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface SendingDomainsTable {
  id: Generated<string>;
  customer_id: string;
  domain: string;
  dkim_selector: string;
  dkim_public_key: string;
  dkim_private_key: string;
  verified_at: Timestamp | null;
  verification_token: Generated<string>;
  spf_verified: Generated<boolean>;
  dkim_verified: Generated<boolean>;
  dmarc_verified: Generated<boolean>;
  dmarc_policy: 'none' | 'quarantine' | 'reject' | null;
  created_at: Generated<Timestamp>;
}

export interface MessagesTable {
  id: Generated<string>;
  message_id: string;
  customer_id: string;
  from_address: string;
  from_name: string | null;
  to_address: string;
  reply_to: string | null;
  subject: string;
  html_body: string | null;
  text_body: string | null;
  headers: Generated<Record<string, string>>;
  tags: Generated<string[]>;
  metadata: Generated<Record<string, unknown>>;
  tracking_opens: Generated<boolean>;
  tracking_clicks: Generated<boolean>;
  ip_pool: Generated<string>;
  status: Generated<
    | 'queued'
    | 'held'
    | 'sending'
    | 'accepted'
    | 'delivered'
    | 'soft_bounced'
    | 'hard_bounced'
    | 'failed'
    | 'suppressed'
  >;
  smtp_response: string | null;
  failure_reason: string | null;
  template_id: string | null;
  provider_message_id: string | null;
  risk_score: Generated<number>;
  body_storage: Generated<'inline' | 'fs' | 's3'>;
  body_object_key: string | null;
  body_size: number | null;
  body_hash: string | null;
  send_at: Timestamp | null;
  queued_at: Generated<Timestamp>;
  accepted_at: Timestamp | null;
  delivered_at: Timestamp | null;
  bounced_at: Timestamp | null;
  opened_at: Timestamp | null;
  first_clicked_at: Timestamp | null;
  human_opened_at: Timestamp | null;
  human_clicked_at: Timestamp | null;
  machine_opened_at: Timestamp | null;
  attempts: Generated<number>;
  unsubscribe_group_id: string | null;
  sending_at: Timestamp | null;
  updated_at: Generated<Timestamp>;
}

export interface EventsTable {
  id: Generated<number>;
  message_id: string;
  customer_id: string;
  event_type:
    | 'queued'
    | 'sent'
    | 'delivered'
    | 'soft_bounce'
    | 'hard_bounce'
    | 'complaint'
    | 'opened'
    | 'clicked'
    | 'unsubscribed'
    | 'failed';
  payload: Record<string, unknown>;
  ip: string | null;
  user_agent: string | null;
  bot_verdict: 'human' | 'bot' | 'suspicious' | null;
  bot_score: number | null;
  event_key: string | null;
  occurred_at: Generated<Timestamp>;
}

export interface SuppressionsTable {
  customer_id: string;
  email: string;
  reason: 'hard_bounce' | 'complaint' | 'unsubscribe' | 'manual' | 'invalid';
  notes: string | null;
  created_at: Generated<Timestamp>;
}

export interface ConsentEventsTable {
  id: Generated<string>;
  customer_id: string;
  email: string;
  action: 'suppress' | 'unsuppress';
  reason: string;
  source: Generated<string>;
  notes: string | null;
  message_id: string | null;
  created_at: Generated<Timestamp>;
}

export interface TrackedLinksTable {
  id: Generated<string>;
  message_id: string;
  original_url: string;
  label: string | null;
  created_at: Generated<Timestamp>;
}

export interface WebhooksTable {
  id: Generated<string>;
  customer_id: string;
  url: string;
  secret: Generated<string>;
  previous_secret: string | null;
  previous_secret_expires_at: Timestamp | null;
  events: string[];
  enabled: Generated<boolean>;
  created_at: Generated<Timestamp>;
}

export interface IpPoolsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  is_default: boolean;
  warmup_stage: number;
  created_at: Generated<Timestamp>;
}

// =====================================================
// Root DB schema (for Kysely)
// =====================================================
export interface Database {
  customers: CustomersTable;
  api_keys: ApiKeysTable;
  sending_domains: SendingDomainsTable;
  messages: MessagesTable;
  events: EventsTable;
  suppressions: SuppressionsTable;
  consent_events: ConsentEventsTable;
  tracked_links: TrackedLinksTable;
  webhooks: WebhooksTable;
  ip_pools: IpPoolsTable;
  templates: TemplatesTable;
  usage_daily: UsageDailyTable;
  audit_log: AuditLogTable;
  audit_log_hashes: AuditLogHashesTable;
  legal_holds: LegalHoldsTable;
  clickhouse_sync_state: ClickhouseSyncStateTable;
  review_queue: ReviewQueueTable;
  idempotency_keys: IdempotencyKeysTable;
  schema_migrations: SchemaMigrationsTable;
  sending_ips: SendingIpsTable;
  ip_reputation: IpReputationTable;
  blocklist_checks: BlocklistChecksTable;
  dkim_keys: DkimKeysTable;
  recipient_domain_intel: RecipientDomainIntelTable;
  soft_bounce_tracker: SoftBounceTrackerTable;
  deletion_requests: DeletionRequestsTable;
  subscriptions: SubscriptionsTable;
  invoices: InvoicesTable;
  billing_events: BillingEventsTable;
  quota_notifications: QuotaNotificationsTable;
  admin_users: AdminUsersTable;
  admin_sessions: AdminSessionsTable;
  volume_baselines: VolumeBaselinesTable;
  users: UsersTable;
  scim_tokens: ScimTokensTable;
  memberships: MembershipsTable;
  user_sessions: UserSessionsTable;
  mfa_factors: MfaFactorsTable;
  mfa_recovery_codes: MfaRecoveryCodesTable;
  user_tokens: UserTokensTable;
  user_invites: UserInvitesTable;
  send_outbox: SendOutboxTable;
  support_notes: SupportNotesTable;
  support_tickets: SupportTicketsTable;
  support_ticket_messages: SupportTicketMessagesTable;
  support_ticket_reads: SupportTicketReadsTable;
  support_canned_responses: SupportCannedResponsesTable;
  webhook_delivery_log: WebhookDeliveryLogTable;
  unsubscribe_groups: UnsubscribeGroupsTable;
  unsubscribe_group_members: UnsubscribeGroupMembersTable;
}

// =====================================================
// Migration 007 tables (human identity & sessions)
// =====================================================

export type MembershipRole = 'owner' | 'admin' | 'developer' | 'analyst' | 'billing';

export interface UsersTable {
  id: Generated<string>;
  email: string;
  name: string | null;
  password_hash: string | null;
  status: Generated<'active' | 'disabled'>;
  email_verified_at: Timestamp | null;
  mfa_enabled: Generated<boolean>;
  last_login_at: Timestamp | null;
  failed_login_attempts: Generated<number>;
  locked_until: Timestamp | null;
  scim_external_id: string | null;
  scim_managed: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
}

export interface ScimTokensTable {
  id: Generated<string>;
  customer_id: string;
  token_hash: string;
  token_prefix: string;
  label: string | null;
  created_at: Generated<Timestamp>;
  last_used_at: Timestamp | null;
  revoked_at: Timestamp | null;
}

export interface MembershipsTable {
  id: Generated<string>;
  user_id: string;
  customer_id: string;
  role: Generated<MembershipRole>;
  created_at: Generated<Timestamp>;
}

export interface UserSessionsTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  current_customer_id: string | null;
  ip: string | null;
  user_agent: string | null;
  mfa_satisfied: Generated<boolean>;
  expires_at: Timestamp;
  last_seen_at: Timestamp;
  revoked_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface MfaFactorsTable {
  id: Generated<string>;
  user_id: string;
  type: Generated<'totp'>;
  secret_encrypted: string;
  confirmed_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  last_used_step: number | null;
}

export interface MfaRecoveryCodesTable {
  id: Generated<string>;
  user_id: string;
  code_hash: string;
  used_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface UserTokensTable {
  id: Generated<string>;
  user_id: string;
  purpose: 'email_verify' | 'password_reset';
  token_hash: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface UserInvitesTable {
  id: Generated<string>;
  customer_id: string;
  email: string;
  role: Generated<MembershipRole>;
  token_hash: string;
  invited_by_user_id: string | null;
  expires_at: Timestamp;
  accepted_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

// =====================================================
// Migration 009 tables (durable send outbox)
// =====================================================

export interface SendOutboxTable {
  id: Generated<string>;
  message_id: string;
  customer_id: string;
  priority: Generated<number>;
  run_at: Timestamp;
  status: Generated<'pending' | 'enqueued' | 'failed'>;
  attempts: Generated<number>;
  last_error: string | null;
  enqueued_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
}

export interface SupportNotesTable {
  id: Generated<string>;
  customer_id: string;
  admin_user_id: string | null;
  body: string;
  visibility: Generated<'internal' | 'escalation'>;
  created_at: Generated<Timestamp>;
}

export type SupportTicketStatus = 'open' | 'pending' | 'resolved' | 'closed';
export type SupportTicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type SupportTicketCategory = 'general' | 'billing' | 'deliverability' | 'technical' | 'abuse' | 'account';

export interface SupportTicketsTable {
  id: Generated<string>;
  customer_id: string;
  subject: string;
  status: Generated<SupportTicketStatus>;
  priority: Generated<SupportTicketPriority>;
  category: Generated<SupportTicketCategory>;
  created_by_user_id: string | null;
  assigned_admin_user_id: string | null;
  last_message_at: Generated<Timestamp>;
  resolved_at: Timestamp | null;
  ai_summary: string | null;
  ai_suggested_priority: SupportTicketPriority | null;
  ai_suggested_category: SupportTicketCategory | null;
  ai_confidence: number | null;
  ai_labels: Generated<string[]>;
  ai_model: string | null;
  ai_triaged_at: Timestamp | null;
  first_response_due_at: Timestamp | null;
  resolution_due_at: Timestamp | null;
  first_responded_at: Timestamp | null;
  satisfaction_rating: number | null;
  satisfaction_comment: string | null;
  rated_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
}

export interface SupportCannedResponsesTable {
  id: Generated<string>;
  title: string;
  body: string;
  category: Generated<SupportTicketCategory>;
  created_by_admin_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface SupportTicketMessagesTable {
  id: Generated<string>;
  ticket_id: string;
  author_type: 'customer_user' | 'admin' | 'system';
  author_user_id: string | null;
  author_admin_user_id: string | null;
  body: string;
  internal: Generated<boolean>;
  created_at: Generated<Timestamp>;
}

export interface SupportTicketReadsTable {
  id: Generated<string>;
  ticket_id: string;
  viewer_type: 'customer_user' | 'admin';
  viewer_user_id: string | null;
  viewer_admin_user_id: string | null;
  last_read_at: Generated<Timestamp>;
  updated_at: Timestamp;
}

// =====================================================
// Migration 002 tables
// =====================================================

export interface TemplatesTable {
  id: Generated<string>;
  customer_id: string;
  name: string;
  subject: string;
  html_body: string | null;
  text_body: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface UsageDailyTable {
  customer_id: string;
  usage_date: ColumnType<Date, string, string>;
  sent: Generated<number>;
  delivered: Generated<number>;
  bounced: Generated<number>;
  complained: Generated<number>;
}

export interface AuditLogTable {
  id: Generated<number>;
  customer_id: string | null;
  api_key_id: string | null;
  action: string;
  resource: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  actor_type: 'user' | 'api_key' | 'admin' | 'system' | null;
  actor_id: string | null;
  actor_label: string | null;
  occurred_at: Generated<Timestamp>;
}

export interface AuditLogHashesTable {
  audit_id: number;
  chain_key: string;
  seq: number;
  previous_hash: string;
  row_hash: string;
  created_at: Generated<Timestamp>;
}

export interface LegalHoldsTable {
  id: Generated<string>;
  customer_id: string;
  scope: string;
  reason: string;
  created_by: string | null;
  created_at: Generated<Timestamp>;
  released_at: Timestamp | null;
  released_by: string | null;
}

export interface ClickhouseSyncStateTable {
  id: Generated<number>;
  last_synced_event_id: Generated<string>; // bigint returned as string by pg driver
  last_run_at: Timestamp | null;
  last_shipped_count: Generated<string>;
  updated_at: Generated<Timestamp>;
}

export interface ReviewQueueTable {
  id: Generated<string>;
  message_id: string;
  customer_id: string;
  risk_score: number;
  reasons: string[];
  status: Generated<'pending' | 'approved' | 'rejected'>;
  created_at: Generated<Timestamp>;
  reviewed_at: Timestamp | null;
}

export interface IdempotencyKeysTable {
  id: Generated<string>;
  customer_id: string;
  idempotency_key: string;
  request_hash: string;
  status_code: number | null;
  response_body: Record<string, unknown> | null;
  created_at: Generated<Timestamp>;
  completed_at: Timestamp | null;
}

// =====================================================
// Migration 004 tables (scale / deliverability / trust / billing)
// =====================================================

export interface SchemaMigrationsTable {
  version: string;
  applied_at: Generated<Timestamp>;
  checksum: string | null;
}

export interface SendingIpsTable {
  id: Generated<string>;
  ip: string;
  pool_id: string | null;
  ptr_record: string | null;
  warmup_stage: Generated<number>;
  warmup_started: ColumnType<Date, string, string> | null;
  status: Generated<'active' | 'paused' | 'retired'>;
  dedicated_customer_id: string | null;
  created_at: Generated<Timestamp>;
}

export interface IpReputationTable {
  ip: string;
  snapshot_date: ColumnType<Date, string, string>;
  sent: Generated<number>;
  delivered: Generated<number>;
  bounced: Generated<number>;
  complained: Generated<number>;
  bounce_rate: Generated<number>;
  complaint_rate: Generated<number>;
  google_reputation: string | null;
  google_spam_rate: number | null;
  snds_color: string | null;
}

export interface BlocklistChecksTable {
  id: Generated<number>;
  ip: string;
  provider: string;
  listed: boolean;
  return_code: string | null;
  checked_at: Generated<Timestamp>;
}

export interface DkimKeysTable {
  id: Generated<string>;
  domain_id: string;
  selector: string;
  public_key: string;
  private_key: string;
  state: Generated<'pending' | 'active' | 'retiring' | 'retired'>;
  activated_at: Timestamp | null;
  retiring_at: Timestamp | null;
  retired_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface RecipientDomainIntelTable {
  domain: string;
  category: 'spam_trap' | 'disposable' | 'role' | 'high_bounce' | 'clean';
  notes: string | null;
  updated_at: Generated<Timestamp>;
}

export interface SoftBounceTrackerTable {
  customer_id: string;
  email: string;
  count: Generated<number>;
  first_seen: Generated<Timestamp>;
  last_seen: Generated<Timestamp>;
}

export interface DeletionRequestsTable {
  id: Generated<string>;
  customer_id: string;
  recipient: string;
  requested_by: string | null;
  messages_deleted: Generated<number>;
  events_deleted: Generated<number>;
  status: Generated<'pending' | 'completed' | 'failed'>;
  created_at: Generated<Timestamp>;
}

export interface SubscriptionsTable {
  id: Generated<string>;
  customer_id: string;
  provider: Generated<string>;
  provider_subscription_id: string | null;
  price_id: string | null;
  plan: Generated<string>;
  status: Generated<'active' | 'past_due' | 'canceled' | 'trialing' | 'incomplete' | 'unpaid'>;
  current_period_start: Timestamp | null;
  current_period_end: Timestamp | null;
  cancel_at_period_end: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface InvoicesTable {
  id: Generated<string>;
  customer_id: string;
  provider_invoice_id: string | null;
  period_start: ColumnType<Date, string, string>;
  period_end: ColumnType<Date, string, string>;
  billed_quantity: Generated<number>;
  metered_quantity: Generated<number>;
  amount_cents: Generated<number>;
  currency: Generated<string>;
  status: Generated<'draft' | 'open' | 'paid' | 'void' | 'uncollectible'>;
  drift: Generated<number>;
  created_at: Generated<Timestamp>;
}

export interface BillingEventsTable {
  provider_event_id: string;
  type: string;
  processed_at: Generated<Timestamp>;
  // Added in 035_billing_event_payload.sql to support the admin replay tool.
  // Nullable for rows written before that migration.
  provider: string | null;
  payload: unknown | null;
  replayed_at: Timestamp | null;
  replay_count: Generated<number>;
}

export interface QuotaNotificationsTable {
  customer_id: string;
  period: string;
  threshold: number;
  notified_at: Generated<Timestamp>;
}

export interface AdminUsersTable {
  id: Generated<string>;
  email: string;
  name: string | null;
  role: Generated<'support' | 'operator' | 'admin' | 'superadmin'>;
  oidc_subject: string | null;
  password_hash: string | null;
  totp_secret: string | null;
  totp_enabled: Generated<boolean>;
  totp_last_used_step: number | null;
  disabled: Generated<boolean>;
  failed_login_attempts: Generated<number>;
  locked_until: Timestamp | null;
  created_at: Generated<Timestamp>;
  last_login_at: Timestamp | null;
}

export interface AdminSessionsTable {
  id: Generated<string>;
  admin_user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  created_at: Generated<Timestamp>;
}

export interface VolumeBaselinesTable {
  customer_id: string;
  hourly_baseline: Generated<number>;
  updated_at: Generated<Timestamp>;
}

export interface WebhookDeliveryLogTable {
  id: Generated<number>;
  webhook_id: string;
  event_id: number | null;
  event_type: string;
  attempt: number;
  status_code: number | null;
  outcome: 'success' | 'failure' | 'dropped' | 'blocked';
  duration_ms: number | null;
  error: string | null;
  delivered_at: Generated<Timestamp>;
}

// =====================================================
// Migration 025 tables (unsubscribe groups)
// =====================================================

export interface UnsubscribeGroupsTable {
  id: Generated<string>;
  customer_id: string;
  name: string;
  description: string | null;
  is_default: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface UnsubscribeGroupMembersTable {
  id: Generated<number>;
  group_id: string;
  customer_id: string;
  email: string;
  unsubscribed_at: Generated<Timestamp>;
}
