// Stable API error-code registry (gap analysis Top-20 #20, §23.3.5 item 4).
//
// Every machine-readable `error` code the public API returns is registered here
// with a human description and its typical HTTP status. This is a STABILITY
// CONTRACT: codes in this registry are part of the public API surface and must
// not be renamed or removed without a deprecation cycle — client code branches
// on these strings. A guard test (error-registry.test.ts) enforces two things:
//   1. every code emitted by the route handlers is registered here (no
//      undocumented codes leaking into the public contract), and
//   2. the registry never silently loses a previously-shipped code
//      (a frozen baseline snapshot guards backward compatibility).
//
// Adding a code: add it here + to the routes. Removing one: deprecate first.

export interface ErrorCodeSpec {
  /** Human-readable description of when this error is returned. */
  description: string;
  /** Typical HTTP status this code is returned with. */
  httpStatus: number;
  /** Marks a code slated for removal; keep returning it until the sunset date. */
  deprecated?: { since: string; replacement?: string; sunset?: string };
}

export const ERROR_CODES = {
  // ── Generic / framework ────────────────────────────────────────────────────
  not_found: { description: 'The requested resource does not exist.', httpStatus: 404 },
  forbidden: { description: 'Authenticated but not permitted to perform this action.', httpStatus: 403 },
  validation_failed: { description: 'Request body or query failed schema validation.', httpStatus: 400 },
  invalid_json: { description: 'Request body was not valid JSON.', httpStatus: 400 },
  internal_error: { description: 'Unexpected server error.', httpStatus: 500 },
  request_error: { description: 'Malformed request.', httpStatus: 400 },
  rate_limited: { description: 'Too many requests; retry after the indicated delay.', httpStatus: 429 },
  no_fields: { description: 'No updatable fields were supplied.', httpStatus: 400 },
  no_fields_provided: { description: 'No updatable fields were supplied.', httpStatus: 400 },

  // ── Auth / identity / session ──────────────────────────────────────────────
  invalid_credentials: { description: 'Email or password is incorrect.', httpStatus: 401 },
  account_locked: { description: 'Account temporarily locked after failed attempts.', httpStatus: 423 },
  account_suspended: { description: 'Account has been suspended.', httpStatus: 403 },
  email_exists: { description: 'A user with this email already exists.', httpStatus: 409 },
  email_not_verified: { description: 'Email address has not been verified.', httpStatus: 403 },
  invalid_code: { description: 'Verification code is invalid.', httpStatus: 400 },
  invalid_token: { description: 'Token is invalid.', httpStatus: 400 },
  invalid_or_expired_token: { description: 'Token is invalid or has expired.', httpStatus: 400 },
  token_expired: { description: 'Token has expired.', httpStatus: 400 },
  password_login_disabled: { description: 'Password login is disabled for this account (SSO only).', httpStatus: 403 },
  mfa_required: { description: 'Multi-factor authentication is required to continue.', httpStatus: 401 },
  mfa_invalid: { description: 'Provided MFA code is invalid.', httpStatus: 401 },
  invalid_mfa_code: { description: 'Provided MFA code is invalid.', httpStatus: 401 },
  invalid_code_mfa: { description: 'Provided MFA code is invalid.', httpStatus: 401 },

  // ── Org / membership / team ────────────────────────────────────────────────
  no_active_org: { description: 'No active organization selected for this session.', httpStatus: 400 },
  org_exists: { description: 'An organization with this name already exists.', httpStatus: 409 },
  not_a_member: { description: 'User is not a member of this organization.', httpStatus: 403 },
  not_authorized: { description: 'Not authorized for this organization action.', httpStatus: 403 },
  insufficient_role: { description: 'Your role lacks the required capability.', httpStatus: 403 },
  cannot_self_demote: { description: 'You cannot remove your own elevated role.', httpStatus: 409 },
  only_owner_can_grant_owner: { description: 'Only an owner can grant the owner role.', httpStatus: 403 },
  only_owner_can_manage_owner: { description: 'Only an owner can manage another owner.', httpStatus: 403 },
  only_owner_can_remove_owner: { description: 'Only an owner can remove an owner.', httpStatus: 403 },
  invalid_assignee: { description: 'The specified assignee is invalid.', httpStatus: 400 },

  // ── Admin plane ────────────────────────────────────────────────────────────
  admin_auth_required: { description: 'Admin authentication is required.', httpStatus: 401 },
  invalid_admin_session: { description: 'Admin session is invalid or expired.', httpStatus: 401 },
  oidc_not_configured: { description: 'Admin OIDC login is not configured.', httpStatus: 400 },
  csrf_failed: { description: 'Missing or invalid CSRF token for a cookie-authenticated admin mutation.', httpStatus: 403 },
  origin_mismatch: { description: 'The request Origin is not an allowed admin console origin.', httpStatus: 403 },
  cross_site_blocked: { description: 'Cross-site requests are not permitted on the admin plane (Sec-Fetch-Site).', httpStatus: 403 },
  note_required: { description: 'A note explaining the decision is required (KYC request-info / reject).', httpStatus: 400 },

  // ── API-key / bearer auth (plugins) ────────────────────────────────────────
  missing_auth: { description: 'No Authorization header / API key was provided.', httpStatus: 401 },
  unauthenticated: { description: 'Authentication is required for this endpoint.', httpStatus: 401 },
  authentication_required: { description: 'Authentication is required for this endpoint.', httpStatus: 401 },
  invalid_key: { description: 'The provided API key is invalid.', httpStatus: 401 },
  expired_key: { description: 'The provided API key has expired.', httpStatus: 401 },
  insufficient_scope: { description: 'The API key lacks the scope required for this action.', httpStatus: 403 },

  // ── Send / delivery ────────────────────────────────────────────────────────
  missing_subject: { description: 'Message is missing a subject.', httpStatus: 400 },
  missing_content: { description: 'Message is missing html_body or text_body.', httpStatus: 400 },
  missing_template_variables: { description: 'Template references variables not supplied (require_all_variables).', httpStatus: 422 },
  template_not_found: { description: 'The referenced template does not exist.', httpStatus: 404 },
  invalid_template: { description: 'Template failed to compile.', httpStatus: 400 },
  content_rejected: { description: 'Message content was rejected by the abuse scanner.', httpStatus: 422 },
  domain_not_registered: { description: 'The From domain is not registered for this account.', httpStatus: 400 },
  domain_not_verified: { description: 'The From domain is not verified.', httpStatus: 400 },
  quota_exceeded: { description: 'Sending quota exceeded.', httpStatus: 429 },
  backpressure: { description: 'Send queue is saturated; retry shortly.', httpStatus: 503 },
  queue_backpressure: { description: 'Send queue is saturated; retry shortly.', httpStatus: 503 },
  pool_capacity_exceeded: { description: 'IP pool capacity exceeded.', httpStatus: 429 },
  pool_paused: { description: 'The IP pool is paused.', httpStatus: 503 },
  cancelled_by_user: { description: 'Message was cancelled by the user.', httpStatus: 409 },
  not_cancellable: { description: 'Message is not in a cancellable state.', httpStatus: 409 },
  not_ready: { description: 'The export has not completed yet; retry once its status is completed.', httpStatus: 409 },
  already_dispatched: { description: 'Message was already dispatched and cannot be cancelled.', httpStatus: 409 },

  // ── Domains ────────────────────────────────────────────────────────────────
  domain_exists: { description: 'This domain is already added.', httpStatus: 409 },

  // ── Suppressions / lists ───────────────────────────────────────────────────
  list_quality_too_low: { description: 'Recipient list quality score is below threshold.', httpStatus: 422 },
  unsubscribe_group_not_found: { description: 'The unsubscribe group does not exist.', httpStatus: 404 },

  // ── Templates ──────────────────────────────────────────────────────────────
  name_exists: { description: 'A template with this name already exists.', httpStatus: 409 },

  // ── Webhooks ───────────────────────────────────────────────────────────────
  webhook_disabled: { description: 'The webhook is disabled.', httpStatus: 422 },
  delivery_not_found: { description: 'The webhook delivery record was not found.', httpStatus: 404 },
  invalid_delivery_id: { description: 'The delivery id is malformed.', httpStatus: 400 },
  no_source_event: { description: 'The delivery has no linked source event to replay.', httpStatus: 422 },
  source_event_gone: { description: 'The source event no longer exists; cannot replay.', httpStatus: 422 },

  // ── Billing ────────────────────────────────────────────────────────────────
  billing_inactive: { description: 'Billing is not active for this account.', httpStatus: 402 },
  kyc_required: { description: 'KYC verification is required before this action.', httpStatus: 403 },
  unsupported_billing_provider: { description: 'The billing provider is not supported.', httpStatus: 400 },
  invalid_signature: { description: 'Webhook signature verification failed.', httpStatus: 400 },
  not_replayable: { description: 'This billing event predates payload storage and cannot be replayed.', httpStatus: 422 },
  unparseable_payload: { description: 'The stored payload did not parse into an event.', httpStatus: 422 },
  unsupported_source_queue: { description: 'The specified source queue is not supported.', httpStatus: 400 },
  unknown_price: { description: 'The requested plan/price is not available in the governed catalog.', httpStatus: 422 },
  not_cancelable: { description: 'The plan-change request is not in a cancelable state (already submitted or applied).', httpStatus: 409 },

  // ── Privacy / legal hold ───────────────────────────────────────────────────
  legal_hold_active: { description: 'Erasure is blocked because the recipient is under an active legal hold.', httpStatus: 409 },
  confirmation_required: { description: 'The request must include the explicit confirmation phrase to proceed.', httpStatus: 400 },
  invalid_transition: { description: 'The privacy case cannot move from its current status to the requested one.', httpStatus: 409 },
  case_not_found: { description: 'No such privacy case exists for this tenant.', httpStatus: 404 },
  verification_required: { description: 'The data subject\'s identity must be verified before the case can be fulfilled.', httpStatus: 422 },
  already_extended: { description: 'The privacy case has already used its statutory deadline extension.', httpStatus: 422 },
  denial_reason_required: { description: 'Denying a privacy case requires a documented reason.', httpStatus: 422 },
  classification_not_authorized: { description: 'Declaring a non-commercial message class requires the classify scope.', httpStatus: 403 },
  reserved_header: { description: 'The custom header overrides an identity, routing, or opt-out header the platform controls.', httpStatus: 422 },
  from_name_spoofing: { description: 'The display name embeds an address at a domain the account has not verified.', httpStatus: 422 },
  card_data_detected: { description: 'Content appears to contain a payment card number; this platform is not an approved cardholder-data channel.', httpStatus: 422 },
  rectify_noop: { description: 'The corrected address is identical to the current one.', httpStatus: 422 },
  sole_owner: { description: 'Account deletion is blocked: the caller is the sole owner of one or more organizations.', httpStatus: 409 },

  // ── Idempotency ────────────────────────────────────────────────────────────
  invalid_idempotency_key: { description: 'The idempotency key is malformed.', httpStatus: 400 },
  idempotency_key_reused: { description: 'The idempotency key was reused with a different request.', httpStatus: 409 },
  idempotency_in_progress: { description: 'A request with this idempotency key is still in progress.', httpStatus: 409 },

  // ── Workflows ──────────────────────────────────────────────────────────────
  invalid_definition: { description: 'The workflow definition failed validation (schema or graph integrity).', httpStatus: 400 },
  invalid_version: { description: 'The workflow version number is malformed.', httpStatus: 400 },
  not_published: { description: 'The workflow has no published version for this operation.', httpStatus: 409 },
  not_started: { description: 'The workflow run was not started (re-entry policy, already active, capacity, or workflow inactive).', httpStatus: 409 },
  archived: { description: 'The workflow is archived and cannot be modified or published.', httpStatus: 409 },
  invalid_state: { description: 'The workflow is not in a state that allows this lifecycle transition.', httpStatus: 409 },
  unknown_template: { description: 'A send_email step references a template that does not exist in this org.', httpStatus: 422 },
  invalid_webhook_url: { description: 'The webhook URL is not a resolvable public HTTP(S) endpoint.', httpStatus: 422 },

  // ── Tools ──────────────────────────────────────────────────────────────────
  invalid_domain: { description: 'The domain is not a scannable public fully-qualified domain name.', httpStatus: 400 },

  // ── Sub-accounts ───────────────────────────────────────────────────────────
  not_a_subaccount: { description: 'The id does not reference a sub-account of this org.', httpStatus: 404 },
  subaccount_limit_reached: { description: 'The org has reached its sub-account limit.', httpStatus: 409 },
  subaccounts_cannot_nest: { description: 'Sub-accounts cannot create their own sub-accounts.', httpStatus: 409 },
  parent_not_active: { description: 'The parent account is not active.', httpStatus: 403 },
  invalid_on_behalf_of: { description: 'X-On-Behalf-Of must reference a sub-account of the authenticated org.', httpStatus: 403 },
  subaccount_suspended: { description: 'The referenced sub-account is suspended.', httpStatus: 403 },

  // ── DMARC monitoring ─────────────────────────────────────────────────────────
  empty_report: { description: 'The DMARC report body was empty.', httpStatus: 400 },
  invalid_report: { description: 'The DMARC aggregate report could not be parsed.', httpStatus: 422 },
  unsafe_xml: { description: 'The DMARC report contained a disallowed DOCTYPE/ENTITY declaration.', httpStatus: 422 },
  report_too_large: { description: 'The DMARC report exceeds the size limit.', httpStatus: 422 },
  unsupported_zip: { description: 'The DMARC report zip used an unsupported compression method.', httpStatus: 422 },

  // ── Attachments ────────────────────────────────────────────────────────────
  attachment_rejected: { description: 'An attachment was refused (blocked executable type, invalid base64, or too many attachments).', httpStatus: 422 },
  attachment_too_large: { description: 'An attachment (or the attachment total) exceeds the size limit.', httpStatus: 422 },
  attachment_malware_detected: { description: 'An attachment was identified as malicious by the configured scanner.', httpStatus: 422 },
  attachment_scan_unavailable: { description: 'Attachment scanning is required but temporarily unavailable.', httpStatus: 503 },
} as const satisfies Record<string, ErrorCodeSpec | { description: string; httpStatus: number }>;

export type ErrorCode = keyof typeof ERROR_CODES;

/** All registered error codes, sorted — used by the guard test and for docs. */
export function listErrorCodes(): string[] {
  return Object.keys(ERROR_CODES).sort();
}

export function isRegisteredErrorCode(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}
