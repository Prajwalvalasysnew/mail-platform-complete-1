/**
 * Shared types used across services.
 */

export interface SendRequest {
  from: string;
  to: string | string[];
  reply_to?: string;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  tags?: string[];
  metadata?: Record<string, unknown>;
  tracking?: {
    opens?: boolean;
    clicks?: boolean;
  };
  ip_pool?: 'transactional' | 'marketing' | 'quarantine';
}

export interface SendResponse {
  accepted: number;
  rejected: number;
  message_ids: string[];
  suppressed: string[];
  scheduled_for?: string;
  /** Which queue lane was applied when `priority` was requested. */
  priority_applied?: 'critical' | 'standard';
  priority_downgraded_reason?: 'tier_not_eligible' | 'rate_capped';
}

export interface ApiError {
  error: string;
  message: string;
  code?: string;
}

export interface AuthContext {
  customer_id: string;
  api_key_id: string;
  tier: string;
  scopes: string[];
  test_mode?: boolean;
  // True only after the customer has verified ownership of their email address.
  // Set at auth time from customers.email_verified_at to avoid a per-request
  // extra DB round-trip on the send hot path.
  email_verified: boolean;
  // Set when a parent key acts as a sub-account via X-On-Behalf-Of:
  // customer_id is the CHILD; this records the authenticated parent.
  on_behalf_of_parent?: string;
}
