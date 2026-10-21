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
  kyc_status: Generated<'none' | 'pending' | 'more_info' | 'approved' | 'rejected'>;
  kyc_note: string | null;
  kyc_submitted_at: Timestamp | null;
  kyc_reviewed_at: Timestamp | null;
  kyc_reviewed_by: string | null;
  new_account_until: Timestamp | null;
  email_verified_at: Timestamp | null;
  email_verify_token_hash: string | null;
  email_verify_token_expires_at: Timestamp | null;
  physical_address: string | null;
  sso_enforced: Generated<boolean>;
  tls_required: Generated<boolean>;
  parent_customer_id: string | null;
  dmarc_report_token: string | null;
  events_retention_days: number | null;
  body_retention_days: number | null;
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
  message_class: Generated<'transactional' | 'relationship' | 'commercial'>;
  body_storage: Generated<'inline' | 'fs' | 's3'>;
  body_object_key: string | null;
  body_size: number | null;
  body_hash: string | null;
  attachments: Array<{ filename: string; content_type: string; size: number; content_b64?: string }> | null;
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

// Self-serve data exports (Phase 2.2): async NDJSON exports of a tenant's
// events/message metadata for a date range.
export interface DataExportsTable {
  id: Generated<string>;
  customer_id: string;
  kind: 'events' | 'messages';
  range_from: Timestamp;
  range_to: Timestamp;
  status: Generated<'pending' | 'running' | 'completed' | 'failed'>;
  row_count: number | null;
  size_bytes: number | null;
  truncated: Generated<boolean>;
  object_key: string | null;
  payload: string | null;
  error: string | null;
  created_at: Generated<Timestamp>;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
}

// Dedup claims for keyed events. Unpartitioned side table because the
// partitioned events table cannot carry a global UNIQUE(event_key) index;
// the event worker claims a key here (ON CONFLICT DO NOTHING) in the same
// transaction as the event insert. Rows age out with the event retention
// window.
export interface EventKeysTable {
  event_key: string;
  event_id: number | null;
  created_at: Generated<Timestamp>;
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
  pseudonymized_at: Timestamp | null;
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
  ai_runs: AiRunsTable;
  ai_run_steps: AiRunStepsTable;
  ai_chats: AiChatsTable;
  ai_chat_messages: AiChatMessagesTable;
  ai_chat_checkpoints: AiChatCheckpointsTable;
  audience_collections:AudienceCollectionsTable;
  customer_campaigns:CustomerCampaignsTable;
  audience_collection_members:{customer_id:string;collection_id:string;contact_id:string};
  audience_contacts: AudienceContactsTable;
  customers: CustomersTable;
  api_keys: ApiKeysTable;
  sending_domains: SendingDomainsTable;
  messages: MessagesTable;
  events: EventsTable;
  event_keys: EventKeysTable;
  data_exports: DataExportsTable;
  suppressions: SuppressionsTable;
  consent_events: ConsentEventsTable;
  tracked_links: TrackedLinksTable;
  webhooks: WebhooksTable;
  ip_pools: IpPoolsTable;
  templates: TemplatesTable;
  template_versions: TemplateVersionsTable;
  usage_daily: UsageDailyTable;
  audit_log: AuditLogTable;
  audit_log_hashes: AuditLogHashesTable;
  audit_log_archive: AuditLogArchiveTable;
  audit_checkpoints: AuditCheckpointsTable;
  audit_worm_exports: AuditWormExportsTable;
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
  recipient_domain_tls: RecipientDomainTlsTable;
  processing_restrictions: ProcessingRestrictionsTable;
  sale_share_optouts: SaleShareOptOutsTable;
  sender_health_runs: SenderHealthRunsTable;
  regulatory_retention_locks: RegulatoryRetentionLocksTable;
  consent_records: ConsentRecordsTable;
  privacy_case_appeals: PrivacyCaseAppealsTable;
  sensitive_pi_limits: SensitivePiLimitsTable;
  admin_access_reviews: AdminAccessReviewsTable;
  retention_runs: RetentionRunsTable;
  control_evidence_runs: ControlEvidenceRunsTable;
  regulated_workload_posture: RegulatedWorkloadPostureTable;
  regulated_prerequisite_evidence: RegulatedPrerequisiteEvidenceTable;
  secure_messages: SecureMessagesTable;
  regulated_rights_cases: RegulatedRightsCasesTable;
  regulated_rights_case_events: RegulatedRightsCaseEventsTable;
  regulated_disclosures: RegulatedDisclosuresTable;
  regulated_archive_records: RegulatedArchiveRecordsTable;
  hipaa_breach_assessments: HipaaBreachAssessmentsTable;
  ferpa_amendment_outcomes: FerpaAmendmentOutcomesTable;
  soft_bounce_tracker: SoftBounceTrackerTable;
  deletion_requests: DeletionRequestsTable;
  deletion_object_items: DeletionObjectItemsTable;
  privacy_message_tombstones: PrivacyMessageTombstonesTable;
  subscriptions: SubscriptionsTable;
  billing_plans: BillingPlansTable;
  billing_plan_prices: BillingPlanPricesTable;
  billing_dunning_state: BillingDunningStateTable;
  billing_dunning_notifications: BillingDunningNotificationsTable;
  billing_plan_change_requests: BillingPlanChangeRequestsTable;
  invoices: InvoicesTable;
  credit_notes: CreditNotesTable;
  invoice_line_items: InvoiceLineItemsTable;
  billing_events: BillingEventsTable;
  quota_notifications: QuotaNotificationsTable;
  admin_users: AdminUsersTable;
  admin_sessions: AdminSessionsTable;
  platform_settings: PlatformSettingsTable;
  admin_elevations: AdminElevationsTable;
  webauthn_credentials: WebauthnCredentialsTable;
  webauthn_challenges: WebauthnChallengesTable;
  volume_baselines: VolumeBaselinesTable;
  users: UsersTable;
  scim_tokens: ScimTokensTable;
  memberships: MembershipsTable;
  user_sessions: UserSessionsTable;
  workspace_handoffs:{code_hash:string;session_id:string;destination:'workspace'|'onboarding';expires_at:Timestamp;created_at:Generated<Timestamp>};
  landing_sales_requests:{id:string;request_hash:string;first_name:string;last_name:string;email:string;company:string;monthly_volume:string;message:string;consent_confirmed_at:Generated<Timestamp>;created_at:Generated<Timestamp>};
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
  privacy_cases: PrivacyCasesTable;
  unsubscribe_monitor_runs: UnsubscribeMonitorRunsTable;
  privacy_case_events: PrivacyCaseEventsTable;
  workflows: WorkflowsTable;
  workflow_versions: WorkflowVersionsTable;
  workflow_runs: WorkflowRunsTable;
  workflow_run_steps: WorkflowRunStepsTable;
  workflow_step_stats: WorkflowStepStatsTable;
  dmarc_reports: DmarcReportsTable;
  dmarc_report_records: DmarcReportRecordsTable;
}

export interface AiRunsTable {
 chat_id?: string | null; chat_seq?: number | null;
 id:string;customer_id:string;user_id:string;session_id:string|null;request_id:string;request_hash:string;
 input:unknown;result:unknown;warnings:Generated<unknown>;
 status:Generated<'queued'|'running'|'completed'|'failed'|'cancelled'|'timed_out'>;
 attempt:Generated<number>;lease_until:Date|null;deadline:Date;expires_at:Date;model:string;error:string|null;
 prompt_tokens:number|null;output_tokens:number|null;
 created_at:ColumnType<Date,Date|undefined,never>;updated_at:ColumnType<Date,Date|undefined,Date>;
}

export interface AudienceCollectionsTable {
 id:Generated<string>;customer_id:string;kind:'list'|'segment';name:string;rules:unknown[];
 created_at:ColumnType<Date,Date|string|undefined,never>;
 updated_at:ColumnType<Date,Date|string|undefined,Date|string>;
}
export interface CustomerCampaignsTable {
  campaign_type:Generated<'regular'|'ab_subject'>;subject_b:Generated<string>;
 id:Generated<string>;customer_id:string;name:string;audience_id:string|null;template_id:string|null;
 from_email:Generated<string>;from_name:Generated<string>;reply_to:Generated<string>;subject:Generated<string>;
 revision:Generated<number>;status:Generated<'draft'|'dispatching'|'queued'|'failed'|'cancelled'>;
 snapshot:unknown;result:unknown;
 send_at:Timestamp|null;
 created_at:ColumnType<Date,Date|string|undefined,never>;
 updated_at:ColumnType<Date,Date|string|undefined,Date|string>;
}
export interface AudienceContactsTable {
  id:Generated<string>;
  customer_id:string;
  email:string;
  name:string;
  company:Generated<string>;
  location:Generated<string>;
  status:Generated<'Pending'|'Subscribed'|'Unsubscribed'>;
  consent_confirmed_at:Timestamp|null;
  source:Generated<string>;
  revision:Generated<number>;
  created_at:ColumnType<Date,Date|string|undefined,never>;
  updated_at:ColumnType<Date,Date|string|undefined,Date|string>;
  tags:Generated<string[]>;
  attributes:Generated<Record<string,unknown>>;
  timezone:string|null;
}

// =====================================================
// Migration 072 tables (DMARC aggregate-report monitoring)
// =====================================================

export interface DmarcReportsTable {
  id: Generated<string>;
  customer_id: string;
  domain: string;
  org_name: string;
  report_id: string;
  date_range_begin: Timestamp;
  date_range_end: Timestamp;
  policy_p: string | null;
  policy_sp: string | null;
  policy_pct: number | null;
  policy_adkim: string | null;
  policy_aspf: string | null;
  total_messages: Generated<number>;
  aligned_messages: Generated<number>;
  created_at: Generated<Timestamp>;
}

export interface DmarcReportRecordsTable {
  id: Generated<string>;
  report_id: string;
  customer_id: string;
  domain: string;
  source_ip: string;
  message_count: Generated<number>;
  disposition: string | null;
  dkim_result: string | null;
  spf_result: string | null;
  header_from: string | null;
  spf_domain: string | null;
  dkim_domain: string | null;
  dmarc_pass: Generated<boolean>;
  created_at: Generated<Timestamp>;
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
  scim_managed: Generated<boolean>;
  scim_external_id: string | null;
  scim_display_name: string | null;
  scim_active: Generated<boolean>;
  scim_updated_at: Timestamp | null;
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
  editor_document: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null | undefined, Record<string, unknown> | null>;
  revision: Generated<number>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface TemplateVersionsTable {
  id: Generated<string>;
  customer_id: string;
  template_id: string;
  revision: number;
  name: string;
  subject: string;
  html_body: string | null;
  text_body: string | null;
  editor_document: Record<string, unknown> | null;
  created_at: Generated<Timestamp>;
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

export interface AuditLogArchiveTable {
  audit_id: number;
  customer_id: string | null;
  api_key_id: string | null;
  action: string;
  resource: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  actor_type: 'user' | 'api_key' | 'admin' | 'system' | null;
  actor_id: string | null;
  actor_label: string | null;
  occurred_at: Timestamp;
  chain_key: string | null;
  seq: number | null;
  previous_hash: string | null;
  row_hash: string | null;
  archived_at: Generated<Timestamp>;
}

export interface AuditCheckpointsTable {
  id: Generated<string>;
  chain_key: string;
  seq: number;
  row_hash: string;
  key_id: string;
  signature: string;
  checkpoint_at: Generated<Timestamp>;
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
  completed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
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

/** CCPA-05: limit use/disclosure of sensitive PI (§1798.121). */
export interface SensitivePiLimitsTable {
  id: Generated<string>;
  customer_id: string;
  email: string;
  source: Generated<'api' | 'web_form' | 'authorized_agent' | 'support' | 'privacy_case'>;
  requested_at: Generated<Timestamp>;
  released_at: Timestamp | null;
  released_reason: string | null;
  pseudonymized_at: Timestamp | null;
}

/** CCPA-07: appeals against denied data-subject requests. */
export interface PrivacyCaseAppealsTable {
  id: Generated<string>;
  case_id: string;
  customer_id: string;
  submitted_at: Generated<Timestamp>;
  reason: string;
  due_at: Timestamp;
  status: Generated<'received' | 'upheld' | 'overturned'>;
  decided_at: Timestamp | null;
  decided_by: string | null;
  decision_reason: string | null;
  escalation_notice: string | null;
}

/** GDPR-05: affirmative consent grants with provenance (Art 7(1) proof). */
export interface ConsentRecordsTable {
  id: Generated<string>;
  customer_id: string;
  email: string;
  purpose: Generated<string>;
  method: 'web_form' | 'double_opt_in' | 'api' | 'offline' | 'import_with_evidence';
  affirmative: Generated<boolean>;
  evidence_text: string;
  policy_version: string | null;
  source_url: string | null;
  ip: string | null;
  user_agent: string | null;
  granted_at: Generated<Timestamp>;
  confirmation_token: string | null;
  confirmed_at: Timestamp | null;
  withdrawn_at: Timestamp | null;
  withdrawal_source: string | null;
  pseudonymized_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

/** SEC-04: time-bound regulatory retention obligations. */
export interface RegulatoryRetentionLocksTable {
  id: Generated<string>;
  customer_id: string;
  scope: string;
  basis: 'sec_17a4' | 'finra_4511' | 'other_statutory';
  authority: string;
  retain_until: Timestamp;
  created_by: string | null;
  created_at: Generated<Timestamp>;
  released_at: Timestamp | null;
  released_by: string | null;
  released_reason: string | null;
}

/** CANSPAM-08: per-sender health verdicts and reviewer decisions. */
export interface SenderHealthRunsTable {
  id: Generated<string>;
  customer_id: string;
  window_start: Timestamp;
  window_end: Timestamp;
  sent: Generated<number>;
  bounced: Generated<number>;
  complained: Generated<number>;
  unsubscribed: Generated<number>;
  bounce_rate: Generated<string>;
  complaint_rate: Generated<string>;
  unsubscribe_rate: Generated<string>;
  verdict: 'ok' | 'watch' | 'hold';
  triggered_by: Generated<string[]>;
  action_taken: Generated<'none' | 'alerted' | 'held'>;
  reviewed_at: Timestamp | null;
  reviewed_by: string | null;
  review_decision: 'released' | 'upheld' | 'escalated' | null;
  review_notes: string | null;
  created_at: Generated<Timestamp>;
}

/** CCPA-04: opt-out of sale/sharing, including Global Privacy Control. */
export interface SaleShareOptOutsTable {
  id: Generated<string>;
  customer_id: string;
  email: string;
  source: 'gpc' | 'api' | 'web_form' | 'authorized_agent' | 'support';
  context: string | null;
  recorded_at: Generated<Timestamp>;
  released_at: Timestamp | null;
  released_reason: string | null;
}

/** GDPR-02: Article 18 processing restrictions (distinct from suppression). */
export interface ProcessingRestrictionsTable {
  id: Generated<string>;
  customer_id: string;
  email: string;
  basis: 'accuracy_contested' | 'unlawful_processing' | 'legal_claims' | 'objection_pending';
  reason: string | null;
  requested_by: string | null;
  privacy_case_id: string | null;
  restricted_at: Generated<Timestamp>;
  released_at: Timestamp | null;
  released_reason: string | null;
  released_by: string | null;
}

/** BASE-08: observed downstream TLS behaviour per recipient domain. */
export interface RecipientDomainTlsTable {
  domain: string;
  deliveries_secured: Generated<number>;
  deliveries_plaintext: Generated<number>;
  last_secured_at: Timestamp | null;
  last_plaintext_at: Timestamp | null;
  last_outcome_secured: boolean | null;
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
  pseudonymized_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface DeletionObjectItemsTable {
  id: Generated<string>;
  deletion_request_id: string;
  object_key: string;
  storage_kind: string;
  status: Generated<'pending' | 'completed' | 'failed'>;
  attempts: Generated<number>;
  last_error: string | null;
  completed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Generated<Timestamp>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface PrivacyMessageTombstonesTable {
  customer_id: string;
  message_id: string;
  deletion_request_id: string;
  created_at: Generated<Timestamp>;
}

export interface SubscriptionsTable {
  id: Generated<string>;
  customer_id: string;
  provider: Generated<string>;
  provider_subscription_id: string | null;
  provider_plan_item_id: string | null;
  price_id: string | null;
  plan: Generated<string>;
  status: Generated<'active' | 'past_due' | 'canceled' | 'trialing' | 'incomplete' | 'unpaid'>;
  current_period_start: Timestamp | null;
  current_period_end: Timestamp | null;
  cancel_at_period_end: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface BillingPlansTable {
  plan_key: string;
  display_name: string;
  tier: 'free' | 'paid' | 'enterprise';
  daily_quota: number;
  monthly_quota: number;
  features: Generated<Record<string, unknown>>;
  active: Generated<boolean>;
  events_retention_days: number | null;
  body_retention_days: number | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface BillingPlanPricesTable {
  id: Generated<string>;
  plan_key: string;
  provider: 'stripe' | 'paypal' | 'cashfree' | 'mock';
  environment: Generated<'test' | 'live'>;
  provider_price_id: string;
  currency: string | null;
  active: Generated<boolean>;
  created_at: Generated<Timestamp>;
}

export interface BillingDunningStateTable {
  customer_id: string;
  state: Generated<'healthy' | 'grace' | 'restricted' | 'recovered' | 'canceled'>;
  failure_count: Generated<number>;
  grace_ends_at: Timestamp | null;
  last_failure_at: Timestamp | null;
  recovered_at: Timestamp | null;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface BillingDunningNotificationsTable {
  id: Generated<string>;
  customer_id: string;
  stage: 'payment_failed' | 'grace_ending' | 'restricted' | 'recovered';
  cycle_key: string;
  status: Generated<'pending' | 'sent' | 'failed'>;
  attempts: Generated<number>;
  last_error: string | null;
  sent_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface BillingPlanChangeRequestsTable {
  id: Generated<string>;
  customer_id: string;
  current_plan: string;
  target_plan: string;
  provider: string;
  provider_price_id: string;
  direction: 'upgrade' | 'downgrade' | 'lateral';
  status: Generated<'previewed' | 'checkout_started' | 'scheduled' | 'applied' | 'canceled' | 'expired'>;
  quota_delta: Generated<Record<string, unknown>>;
  feature_delta: Generated<Record<string, unknown>>;
  warnings: Generated<unknown[]>;
  proration_date: number | null;
  proration_amount_cents: number | null;
  preview_amount_due_cents: number | null;
  preview_currency: string | null;
  applied_at: Timestamp | null;
  canceled_at: Timestamp | null;
  scheduled_effective_at: Timestamp | null;
  expires_at: Generated<Timestamp>;
  created_at: Generated<Timestamp>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
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
  tax_cents: Generated<number>;
  currency: Generated<string>;
  status: Generated<'draft' | 'open' | 'paid' | 'void' | 'uncollectible'>;
  drift: Generated<number>;
  hosted_invoice_url: string | null;
  invoice_pdf_url: string | null;
  due_at: Timestamp | null;
  paid_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface InvoiceLineItemsTable {
  id: Generated<string>;
  invoice_id: string;
  provider_line_item_id: string;
  description: string | null;
  quantity: Generated<number>;
  amount_cents: Generated<number>;
  currency: Generated<string>;
  period_start: Timestamp | null;
  period_end: Timestamp | null;
  metadata: Generated<Record<string, unknown>>;
}

export interface CreditNotesTable {
  id: Generated<string>;
  customer_id: string;
  invoice_id: string | null;
  provider: string;
  provider_credit_note_id: string;
  provider_invoice_id: string | null;
  number: string | null;
  amount_cents: Generated<number>;
  currency: Generated<string>;
  reason: string | null;
  memo: string | null;
  status: Generated<'issued' | 'void'>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
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

export interface WebauthnCredentialsTable {
  id: Generated<string>;
  user_id: string;
  credential_id: string;
  public_key: string;
  alg: number;
  sign_count: Generated<number>;
  aaguid: string | null;
  transports: string | null;
  name: string | null;
  created_at: Generated<Timestamp>;
  last_used_at: Timestamp | null;
}

export interface WebauthnChallengesTable {
  id: Generated<string>;
  user_id: string | null;
  purpose: 'register' | 'authenticate';
  challenge: string;
  expires_at: Timestamp;
  created_at: Generated<Timestamp>;
}

export interface AdminElevationsTable {
  id: Generated<string>;
  admin_user_id: string;
  role: 'support' | 'operator' | 'admin' | 'superadmin';
  reason: string;
  granted_by: string | null;
  break_glass: Generated<boolean>;
  status: Generated<'active' | 'expired' | 'revoked'>;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  revoked_by: string | null;
  created_at: Generated<Timestamp>;
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
  /** HMAC of the per-session CSRF secret (cookie-session flows only). */
  csrf_hash: string | null;
  /** Session audience binding — admin console sessions are tagged 'admin'. */
  audience: Generated<string>;
  expires_at: Timestamp;
  created_at: Generated<Timestamp>;
}

export interface PlatformSettingsTable {
  key: string;
  value: unknown;
  updated_by: string | null;
  updated_at: Generated<Timestamp>;
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

// =====================================================
// Migration 076 tables (privacy case management, BASE-05)
// =====================================================

export type PrivacyCaseStatus =
  | 'received'
  | 'verifying'
  | 'in_progress'
  | 'waiting_on_subject'
  | 'fulfilled'
  | 'denied'
  | 'closed';
export type PrivacyCaseJurisdiction = 'gdpr' | 'ccpa' | 'other' | 'unknown';
export type PrivacyCaseIntakeSource = 'api' | 'email' | 'web_form' | 'support' | 'authorized_agent' | 'postal';
export type PrivacyCaseRequestType =
  | 'access'
  | 'erasure'
  | 'rectification'
  | 'restriction'
  | 'objection'
  | 'portability'
  | 'opt_out'
  | 'limit_sensitive_pi';

export interface PrivacyCasesTable {
  id: Generated<string>;
  customer_id: string;
  subject_kind: Generated<'recipient' | 'account_user'>;
  subject_identifier: string;
  subject_pseudonymized_at: Timestamp | null;
  intake_source: PrivacyCaseIntakeSource;
  request_types: PrivacyCaseRequestType[];
  jurisdiction: Generated<PrivacyCaseJurisdiction>;
  status: Generated<PrivacyCaseStatus>;
  received_at: ColumnType<Date, Date | string | undefined, Date | string>;
  due_at: Timestamp;
  extended_until: Timestamp | null;
  extension_reason: string | null;
  identity_verified_at: Timestamp | null;
  verification_method: string | null;
  denial_reason: string | null;
  approved_by: string | null;
  closed_at: Timestamp | null;
  artifacts: Generated<Array<Record<string, unknown>>>;
  created_by: string | null;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

/**
 * HIPAA-07: a reviewer's judgement about one staff access to tenant data.
 *
 * Separate from the access record itself, which lives in the hash-chained
 * audit_log — the evidence must stay append-only, the judgement about it
 * arrives later.
 */
export interface AdminAccessReviewsTable {
  audit_id: number;
  reviewed_at: Generated<Timestamp>;
  reviewed_by: string;
  decision: 'appropriate' | 'inappropriate';
  note: string | null;
}

/**
 * SOC2-06: one row per retention sweep.
 *
 * The sweep returned its counts to the caller and persisted nothing, so a
 * sweep that stopped running looked exactly like a sweep with nothing to do.
 * This table makes that absence detectable.
 */
export interface RetentionRunsTable {
  id: Generated<string>;
  started_at: Timestamp;
  finished_at: Generated<Timestamp>;
  duration_ms: number;
  result: Record<string, unknown>;
  error: string | null;
}

/** SOC2-06: periodic per-control evidence with a completeness verdict. */
export interface ControlEvidenceRunsTable {
  id: Generated<string>;
  control_id: string;
  period_start: Timestamp;
  period_end: Timestamp;
  collected_at: Generated<Timestamp>;
  // Counts and timestamps only — never identifiers, content, or secrets.
  metrics: Generated<Record<string, unknown>>;
  completeness: 'complete' | 'partial' | 'missing';
  notes: string | null;
  reviewed_at: Timestamp | null;
  reviewed_by: string | null;
  review_note: string | null;
}

export interface AuditWormExportsTable {
  id: Generated<string>;
  chain_key: string;
  start_seq: number;
  end_seq: number;
  record_count: number;
  bundle_sha256: string;
  object_key: string;
  exported_at: Generated<Timestamp>;
}

export interface RegulatedWorkloadPostureTable {
  customer_id: string;
  mode: 'hipaa' | 'ferpa' | 'sec_finra';
  status: 'disabled' | 'pending' | 'active' | 'rejected' | 'suspended';
  prerequisites: Generated<Record<string, boolean>>;
  requested_at: Timestamp | null;
  requested_by: string | null;
  reviewed_at: Timestamp | null;
  reviewed_by: string | null;
  review_note: string | null;
  activated_at: Timestamp | null;
  suspended_at: Timestamp | null;
  updated_at: Timestamp;
}

export interface RegulatedPrerequisiteEvidenceTable {
  id: Generated<string>;
  customer_id: string;
  mode: 'hipaa' | 'ferpa' | 'sec_finra';
  prerequisite: string;
  artifact_uri: string;
  artifact_sha256: string;
  status: Generated<'submitted' | 'approved' | 'rejected'>;
  submitted_by: string;
  submitted_at: Generated<Timestamp>;
  reviewed_by: string | null;
  reviewed_at: Timestamp | null;
  review_note: string | null;
  expires_at: Timestamp | null;
  updated_at: Timestamp;
}

export interface SecureMessagesTable {
  id: Generated<string>;
  customer_id: string;
  recipient_email: string;
  encrypted_payload: string;
  portal_token_hash: string;
  access_code_hash: string;
  mode: 'hipaa' | 'ferpa';
  expires_at: Timestamp;
  accessed_at: Timestamp | null;
  revoked_at: Timestamp | null;
  created_by_api_key: string | null;
  created_at: Generated<Timestamp>;
}

export interface RegulatedRightsCasesTable {
  id: Generated<string>;
  customer_id: string;
  mode: 'hipaa' | 'ferpa';
  kind: 'access' | 'amendment' | 'restriction' | 'confidential_communication' | 'disclosure_accounting' | 'breach_assessment' | 'hearing';
  subject_pseudonym: string;
  status: Generated<'open' | 'identity_verified' | 'in_review' | 'approved' | 'denied' | 'fulfilled' | 'hearing_requested' | 'closed'>;
  deadline_at: Timestamp;
  decision_reason: string | null;
  created_by: string;
  assigned_to: string | null;
  closed_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Timestamp;
}

export interface RegulatedRightsCaseEventsTable {
  id: Generated<number>;
  case_id: string;
  event: string;
  actor: string;
  detail: Generated<Record<string, unknown>>;
  created_at: Generated<Timestamp>;
}

export interface RegulatedDisclosuresTable {
  id: Generated<string>;
  customer_id: string;
  mode: 'hipaa' | 'ferpa';
  subject_pseudonym: string;
  recipient: string;
  purpose: string;
  authority: string;
  redisclosure_restricted: Generated<boolean>;
  disclosed_at: Generated<Timestamp>;
  recorded_by: string;
}

export interface RegulatedArchiveRecordsTable {
  id: Generated<string>;
  customer_id: string;
  message_id: string;
  direction: 'outbound' | 'inbound';
  provider: string;
  external_id: string;
  content_sha256: string;
  archived_at: Timestamp;
  immutable_until: Timestamp;
  reconciliation_status: 'verified' | 'missing' | 'mismatch';
  reconciled_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface HipaaBreachAssessmentsTable {
  case_id: string;
  customer_id: string;
  nature_extent_risk: 'low' | 'medium' | 'high';
  unauthorized_person_risk: 'low' | 'medium' | 'high';
  acquired_or_viewed: boolean;
  mitigation_completed: boolean;
  breach_presumed: boolean;
  encrypted_analysis: string;
  assessed_by: string;
  assessed_at: Generated<Timestamp>;
}

export interface FerpaAmendmentOutcomesTable {
  case_id: string;
  customer_id: string;
  hearing_offered: boolean;
  hearing_at: Timestamp | null;
  outcome: 'amended' | 'denied' | 'pending_hearing';
  encrypted_statement: string | null;
  recorded_by: string;
  recorded_at: Generated<Timestamp>;
}

// Migration 078 (CANSPAM-05): synthetic unsubscribe monitoring evidence.
export interface UnsubscribeMonitorRunsTable {
  id: Generated<string>;
  run_at: Generated<Timestamp>;
  kind: 'chain_validation' | 'one_click_synthetic' | 'sla_scan';
  ok: boolean;
  target_message_id: string | null;
  message_age_days: number | null;
  latency_ms: number | null;
  detail: Generated<Record<string, unknown>>;
  error: string | null;
}

export interface PrivacyCaseEventsTable {
  id: Generated<string>;
  case_id: string;
  customer_id: string;
  event: 'created' | 'verified' | 'status_changed' | 'extended' | 'communication' | 'artifact_attached' | 'denied' | 'closed'
    // CCPA-07: a denial can be appealed, and an overturned appeal reopens the
    // case — a reopen must be as auditable as the denial that preceded it.
    | 'appeal_submitted' | 'appeal_decided' | 'reopened';
  detail: Generated<Record<string, unknown>>;
  actor: string | null;
  created_at: Generated<Timestamp>;
}

// =====================================================
// Migration 068 tables (workflow automation engine)
// =====================================================

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';
export type WorkflowRunStatus =
  | 'running'
  | 'waiting_delay'
  | 'waiting_event'
  | 'completed'
  | 'goal_met'
  | 'exited'
  | 'failed'
  | 'canceled';
export type WorkflowTriggerSource = 'event' | 'api' | 'manual' | 'test' | 'audience' | 'schedule';

export interface WorkflowsTable {
  builder_document:Record<string,unknown>|null;
  builder_revision:Generated<number>;
  id: Generated<string>;
  customer_id: string;
  name: string;
  description: string | null;
  status: Generated<WorkflowStatus>;
  draft_definition: Generated<Record<string, unknown>>;
  published_version_id: string | null;
  published_version: number | null;
  trigger_type: string | null;
  trigger_event_type: string | null;
  date_trigger_swept_on: ColumnType<string | null, string | null | undefined, string | null>;
  allow_reentry: Generated<boolean>;
  reentry_cooldown_seconds: Generated<number>;
  created_by_user_id: string | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface WorkflowVersionsTable {
  id: Generated<string>;
  workflow_id: string;
  customer_id: string;
  version: number;
  definition: Record<string, unknown>;
  notes: string | null;
  published_by_user_id: string | null;
  created_at: Generated<Timestamp>;
}

export interface WorkflowRunsTable {
  id: Generated<string>;
  customer_id: string;
  workflow_id: string;
  version_id: string;
  version: number;
  subject_email: string;
  status: Generated<WorkflowRunStatus>;
  current_step_id: string | null;
  trigger_source: Generated<WorkflowTriggerSource>;
  context: Generated<Record<string, unknown>>;
  wake_at: Timestamp | null;
  waiting_event_types: string[] | null;
  steps_executed: Generated<number>;
  goal_met_at: Timestamp | null;
  goal_step_id: string | null;
  error: string | null;
  started_at: Generated<Timestamp>;
  finished_at: Timestamp | null;
  updated_at: Generated<Timestamp>;
}

export interface WorkflowRunStepsTable {
  id: Generated<string>;
  run_id: string;
  customer_id: string;
  step_id: string;
  step_type: string;
  seq: number;
  status: Generated<'completed' | 'failed' | 'skipped' | 'waiting'>;
  result: Generated<Record<string, unknown>>;
  error: string | null;
  executed_at: Generated<Timestamp>;
}

export interface WorkflowStepStatsTable {
  workflow_id: string;
  customer_id: string;
  version: number;
  step_id: string;
  entered: Generated<number>;
  completed: Generated<number>;
  failed: Generated<number>;
  updated_at: Generated<Timestamp>;
}

export interface AiChatsTable {
 id:string;customer_id:string;user_id:string;title:string;next_seq:Generated<number>;settings:unknown;
 created_at:ColumnType<Date,Date|string|undefined,never>;updated_at:ColumnType<Date,Date|string|undefined,Date|string>;expires_at:ColumnType<Date,Date|string,Date|string>;
}
export interface AiChatMessagesTable {
 id:string;customer_id:string;chat_id:string;run_id:string|null;seq:number;role:'user'|'assistant';text:Generated<string>;status:Generated<string>;
 result:unknown;error:string|null;template_id:string|null;workflow_id:Generated<string|null>;decision:'applied'|'skipped'|null;created_at:ColumnType<Date,Date|string|undefined,never>;
}
export interface AiChatCheckpointsTable {
 id:string;customer_id:string;chat_id:string;through_seq:number;summary:string;run_id:string|null;attempt:number;created_at:ColumnType<Date,Date|string|undefined,never>;
}

export interface AiRunStepsTable {
 id:string;customer_id:string;run_id:string;attempt:number;seq:number;name:string;status:string;arguments:unknown;observation:unknown;
 created_at:ColumnType<Date,Date|string|undefined,never>;
}
