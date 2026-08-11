# Complete Platform Feature Inventory

> Repository snapshot: 2026-07-29
> Platform version: `0.7.23`
> Scope: application code, database migrations, workers, SMTP components,
> tracking service, SDK, admin console, tests, deployment manifests, monitoring,
> security controls, compliance workflows, and operational tooling.

## How to read this document

This is the engineering inventory of the platform, including small supporting
features that are normally omitted from a marketing feature list.

- **Implemented** means the capability exists in the current repository.
- **Configurable** means it is implemented but must be enabled or supplied with
  infrastructure, credentials, certificates, or a provider.
- **Gated** means the capability is deliberately unavailable until its
  authorization or evidence prerequisites pass.
- **Deployment-dependent** means the repository supplies integration or
  automation, but the result must be established and tested in the target
  environment.
- **External** means contracts, legal decisions, certifications, independent
  assessments, or third-party services that source code cannot provide.

This inventory is not a claim that an organization or deployment is certified
under any compliance framework. It records product capabilities and technical
controls.

## 1. Platform at a glance

The repository is a self-hosted, multi-tenant transactional email platform
built as a TypeScript monorepo. It provides:

- native REST email submission;
- batch email submission;
- authenticated SMTP submission;
- a SendGrid-compatible v3 send endpoint;
- background queue-based delivery;
- Haraka and Amazon SES delivery transport options;
- a local Mailpit delivery transport;
- delivery, bounce, complaint, open, click, and unsubscribe events;
- domains, DKIM, SPF, DMARC, suppressions, reputation, and warmup controls;
- customer accounts, organizations, teams, roles, SSO, SCIM, MFA, and passkeys;
- Free, Pro, and Enterprise plan behavior;
- multi-provider billing;
- webhooks, templates, analytics, exports, and workflows;
- privacy rights, retention, legal hold, and consent operations;
- regulated-workload activation controls for HIPAA, FERPA, and SEC/FINRA use
  cases;
- a React internal administration console;
- Prometheus, Grafana, Alertmanager, ClickHouse, Jaeger, and OpenTelemetry
  integrations;
- Docker Compose, Kubernetes, Helm, and Hetzner deployment assets;
- backup, restore, PITR, Redis failover, load-test, and readiness tooling.

### Primary runtime components

| Component | Responsibility | Default local surface |
| --- | --- | --- |
| Core API | Customer, account, admin, billing, privacy, sending, and automation APIs | `http://localhost:3000` |
| Admin console | Internal operator UI | `http://localhost:5174` |
| Worker | Send, event, webhook, export, workflow, and scheduled maintenance jobs | metrics on `http://localhost:9100` |
| SMTP gateway | Authenticated customer SMTP submission | SMTP `localhost:587`, metrics `http://localhost:9102` |
| Tracker | Open, click, and unsubscribe handling | `http://localhost:4000` |
| Haraka outbound | DKIM-aware outbound SMTP transport and delivery event emission | `localhost:2525` |
| Haraka inbound | DSN/bounce and complaint ingestion | `localhost:2526` |
| PostgreSQL | Authoritative transactional and tenant data | `localhost:5432` |
| Redis/BullMQ | Queues, scheduling, rate state, locks, and short-lived operational state | `localhost:6379` |
| Mailpit | Safe development SMTP sink and message UI | SMTP `localhost:1025`, UI `http://localhost:8025` |
| Prometheus | Metrics collection | `http://localhost:9090` |
| Grafana | Provisioned operational dashboards | `http://localhost:3002` |
| Alertmanager | Alert routing | `http://localhost:9093` |
| Jaeger | Distributed trace UI and OTLP receiver | UI `http://localhost:16686`, OTLP HTTP `localhost:4318` |
| ClickHouse | Optional high-volume analytics store | HTTP `localhost:8123`, native `localhost:9000` |

## 2. Account, identity, and organization features

### Registration and verification

- Public customer signup.
- User-and-organization registration.
- Free-plan defaults for newly registered organizations.
- Email verification tokens.
- Resend-verification flow.
- Verification-token expiry and validation.
- Prevention of production sending before account email verification.
- Separate API-first signup and human-session registration surfaces.
- Registration atomicity so partial user/customer records are not retained
  after a failed registration.
- Customer physical-address storage for sender-identity and CAN-SPAM controls.
- Initial KYC level and new-account risk window.

### Login and passwords

- Email/password login.
- Password hashing and secure password verification.
- Login request validation.
- Login rate limiting.
- User lockout state.
- Password-reset request flow.
- Password-reset token validation and expiry.
- Password-reset completion.
- Session invalidation behavior around credential changes.
- Logout of the current session.

### Session and device management

- HttpOnly session tokens for customer sessions.
- Active-session listing.
- Session metadata suitable for device/session views.
- Revoke one session.
- Revoke every other session.
- Current-user and current-organization bootstrap.
- Self-service current-user data export.
- Self-service account deletion with organization/ownership safety checks.
- Organization switching for users with more than one membership.
- Authentication states that distinguish partial MFA sessions from fully
  authenticated sessions.
- Session isolation between customer and admin audiences.

### Multi-factor authentication and passkeys

- TOTP enrollment.
- TOTP enrollment confirmation.
- TOTP challenge during login.
- TOTP disable flow.
- Replay prevention for previously accepted TOTP codes.
- WebAuthn/passkey registration options.
- WebAuthn credential registration.
- WebAuthn credential listing.
- WebAuthn credential removal.
- MFA safety checks for invitations and privileged paths.

### Organizations, teams, and RBAC

- Multiple organization memberships per user.
- Team-member listing.
- Team invitation creation.
- Pending-invitation listing.
- Invitation acceptance.
- Invitation cancellation.
- Member role changes.
- Member removal.
- Capability-based customer authorization.
- API-enforced capability checks, not only UI hiding.
- Role/capability support for member, analyst, developer, billing, admin, and
  owner-style responsibilities as defined by the role map.
- Cross-tenant denial tests.
- Organization-scoped audit attribution for user operations.

### Enterprise identity

- Tenant SSO policy read and update.
- SSO enforcement at authentication time.
- OIDC policy validation.
- SCIM token creation, listing, and revocation.
- SCIM 2.0 service-provider configuration.
- SCIM user listing and retrieval.
- SCIM user creation.
- SCIM PATCH and PUT updates.
- SCIM user deprovisioning.
- SCIM tenant state and provisioning audit behavior.
- Admin OIDC login backend.
- Admin just-in-time elevation.
- Time-bounded admin elevation.
- Break-glass elevation and review records.
- Production OIDC policy checks for asserted MFA/authentication context.

## 3. API credentials and authorization features

- Secret API keys.
- Publishable-key type.
- Test-mode API keys.
- Live-versus-test key behavior.
- Configurable key names.
- Explicit API-key expiry.
- Plaintext key shown only once at creation.
- Hashed/peppered key storage.
- Key metadata listing without exposing secret material.
- Key rotation with a controlled overlap window.
- Key revocation.
- Idempotent revocation behavior.
- Expired-key rejection.
- Suspended-customer rejection.
- Scope enforcement for:
  - `send`;
  - `messages`;
  - `domains`;
  - `templates`;
  - `webhooks`;
  - `suppressions`;
  - `smtp`;
  - `workflows`;
  - `subaccounts`.
- Customer-session capabilities for:
  - API-key management;
  - domain management;
  - webhook/settings management;
  - billing management;
  - member management;
  - log/audit access.
- On-behalf-of authorization for parent/child account operations.
- API-key operations recorded in the customer audit trail.
- Stable authentication and scope error responses.

## 4. Message submission features

### Native REST send

- Single-message submission at `/v1/send`.
- Batch submission at `/v1/send/batch`.
- Up to 100 distinct messages in one batch request.
- Per-recipient fan-out for a single-send recipient list.
- Individual batch entry content, recipient, template, subject, and schedule.
- From address.
- To recipient.
- Subject.
- Plain-text body.
- HTML body.
- Reply-to.
- Custom headers.
- Tags.
- Template reference.
- Template variables.
- Scheduled `send_at`.
- Unsubscribe-group association.
- Normal and requested critical priority.
- Response metadata describing the priority actually applied.
- Priority downgrade reason when the critical lane cannot be used.
- Endpoint-specific rate limits.
- Queue-depth backpressure with `503` and `Retry-After`.
- Production-send email-verification enforcement.
- Customer-status and sender-hold enforcement.
- Billing-state enforcement.
- New-account/KYC quota cap.
- Verified sending-domain enforcement.
- Suppression checks before acceptance.
- Regulated-content classification before acceptance.
- Quota reservation before queueing.
- Quota refund when cancellation or terminal pre-send failure makes delivery
  impossible.

### Idempotency and duplicate protection

- Optional `Idempotency-Key` on single send.
- Request-body hashing.
- Replay of the original stored response.
- `Idempotent-Replayed` response header.
- Conflict rejection when the same key is reused with a different body.
- In-progress duplicate detection.
- `Retry-After` guidance for in-progress requests.
- Expiring idempotency records.
- Scheduled idempotency cleanup.
- Idempotent delivery-event processing.
- Event status precedence so late or duplicate events do not regress final
  message state.

### Attachments and body storage

- Up to ten attachments on a single send.
- Base64 attachment input.
- Filename validation.
- Content-type metadata.
- Attachment size validation.
- Aggregate message/attachment limits.
- Executable file-type rejection.
- PE binary signature detection even when renamed.
- ELF binary signature detection even when renamed.
- Optional ClamAV streaming scan.
- Configurable malware-scanner failure policy.
- Attachment metadata returned without returning raw content.
- Inline body storage.
- Filesystem/object-style offloaded body storage.
- Offload deduplication awareness during erasure.
- Retryable deletion records for offloaded bodies and attachments.

### Templates

- Template creation.
- Template listing.
- Template retrieval.
- Template replacement/update.
- Template deletion.
- Subject template.
- HTML template.
- Text template.
- Variable substitution.
- Validation of missing template variables.
- Template rendering in the send path.
- Template use through the SDK.
- Parent-to-subaccount bulk template push.

### Scheduling and cancellation

- Future send time.
- Delayed BullMQ execution.
- Scheduled-message listing.
- Stable cursor pagination ordered by send time.
- Cancellation before outbox dispatch.
- Race-safe refusal after worker pickup.
- Message status update on successful cancellation.
- Reserved-quota release on successful cancellation.
- Stale scheduled/export work recovery.

### Alternative submission channels

- Authenticated SMTP submission.
- SMTP API-key authentication.
- Required SMTP and send scopes.
- SMTP recipient processing through the same tenant send pipeline.
- SMTP rate limiting.
- SMTP health endpoint.
- SMTP Prometheus metrics.
- STARTTLS certificate/key configuration for production.
- SendGrid v3-compatible `/v3/mail/send`.
- SendGrid request translation into the native pipeline.
- SendGrid-compatible webhook/event naming where supported.
- Channel-parity tests across REST, SMTP, SendGrid compatibility, and SDK.

## 5. Delivery-pipeline features

### Transactional delivery architecture

- PostgreSQL as the authoritative message state.
- Transactional send outbox.
- Atomic message and outbox creation.
- Best-effort immediate outbox drain.
- Periodic outbox drain.
- Atomic outbox claiming.
- Stale `enqueued` outbox reclamation after crash windows.
- Stale `sending` message recovery.
- BullMQ send queue.
- Configurable worker concurrency.
- Queue priority lanes.
- Delayed jobs.
- Retry with bounded attempts.
- Dead-letter routing.
- Crash-consistency protection between database and Redis.
- Failure reason persistence.
- Stable failure taxonomy.
- Queue backpressure protection.

### Delivery transports

- Mailpit transport for safe development delivery.
- Haraka outbound transport.
- Amazon SES SMTP transport.
- Transport selection by configuration.
- Haraka customer-domain DKIM signing.
- Haraka header cleanup.
- Haraka delivery event emission.
- Outbound queue persistence volume.
- SMTP connection and authentication configuration.
- Delivery-attempt accounting.
- Accepted, delivered, deferred, bounced, and failed state handling.

### Return-path, bounce, and complaint handling

- VERP return-path construction.
- Signed VERP tokens.
- VERP verification.
- Inbound Haraka bounce receiver.
- DSN parsing.
- ARF/complaint parsing.
- Bounce-to-message attribution.
- Hard-bounce events.
- Soft-bounce events.
- Complaint events.
- Automatic suppression after hard bounce.
- Automatic suppression after complaint.
- Soft-bounce counters and thresholds.
- Failure classification and retryability.
- Event delivery into the shared event worker.

### Transport security

- SMTP STARTTLS deployment configuration.
- Per-delivery `tls_required` and `tls_secured` evidence.
- Recipient-domain TLS history.
- Last-outcome storage for domain TLS state.
- Detection of a domain that previously delivered without TLS.
- Blocking subsequent sends for `tls_required` tenants while the domain is
  known unsafe.
- Automatic recovery after a later TLS-secured delivery.
- Deterministic last-observed outcome handling.
- Explicitly documented first-delivery limitation for previously unseen
  recipient domains.
- Clear distinction between hop-by-hop SMTP TLS and end-to-end
  message-level encryption.

## 6. Sending domains, authentication, and deliverability

### Domain lifecycle

- Create sending domain.
- List sending domains.
- Retrieve one domain through the account surface.
- Verify a domain.
- Delete a domain.
- Customer-session domain management.
- API-key domain management.
- Tenant ownership checks.
- Domain verification state.
- SPF status.
- DKIM status.
- DMARC status.
- Required DNS record guidance.
- Domain-scanner integration.
- Development and production DNS documentation.

### DKIM

- Per-domain DKIM selectors.
- Encrypted DKIM private-key storage.
- Pluggable KMS-backed encryption.
- DKIM key generation script.
- DKIM rotation.
- Retiring-key grace period.
- Scheduled retirement of old selectors.
- Haraka lookup of customer signing material.
- Optional fail-closed DKIM requirement.
- DKIM failure runbook.

### DMARC

- Tenant-specific DMARC reporting address.
- DMARC aggregate-report ingestion.
- DMARC summary endpoint.
- DMARC source breakdown.
- Domain-policy association.
- DMARC report and child-record retention.
- Legal-hold-aware DMARC preservation.
- DMARC monitoring guide.

### Reputation and sender health

- Recipient-list quality scoring.
- Malformed-address detection during list scoring.
- Role-account detection.
- Disposable-domain detection.
- Known spam-trap-domain detection.
- `accept`, `review`, or `reject` list-quality recommendation.
- Bounded bad-address samples in scoring results.
- Chunked domain-intelligence lookup for very large imports.
- Single and batched trap/disposable checks in sending paths.
- Pool-level bounce-rate calculation.
- Pool-level complaint-rate calculation.
- Pool pause decisions.
- Pool recovery detection.
- Recovery event emission.
- Sender-level bounce and complaint monitoring.
- Warning/watch threshold.
- Automated sender hold.
- Human-review requirement before resuming held senders.
- DNS blocklist monitoring.
- Blocklist provider counts.
- Manual admin blocklist scan.
- Google Postmaster ingestion hook.
- Microsoft SNDS ingestion hook.
- Volume baseline calculation.
- Volume anomaly support.
- Reputation guard runbook.
- Blocklist incident runbook.

### IP pools and warmup

- Sending IP pool records.
- Pool health view.
- Pool pause state.
- IP warmup records.
- Warmup stages.
- Scheduled warmup advancement.
- Configurable warmup settings.
- Admin pool and deliverability screens.
- IP warmup runbook.
- Pool-pause runbook.

## 7. Tracking, engagement, and unsubscribe features

### Open tracking

- Encoded open-pixel URL.
- Signed/encoded tracking token.
- Message and tenant attribution.
- Open event creation.
- First-open timestamp.
- Human-open timestamp.
- Duplicate/idempotent event behavior.
- Transparent pixel response.

### Click tracking

- Encoded click URL.
- Per-link identifier.
- Original target recovery.
- Click event creation.
- First-click timestamp.
- Human-click timestamp.
- Safe redirect response.
- Link records associated with the source message.

### Automated-traffic classification

- Bot user-agent detection.
- Prefetch detection.
- Apple Mail Privacy Protection classification.
- Configurable bot verdict and score.
- Raw open/click event preservation.
- Separate human open/click timestamps.
- Analytics capable of distinguishing classified engagement.

### Unsubscribe

- Signed one-click unsubscribe URL.
- RFC 8058-style POST unsubscribe.
- GET unsubscribe landing behavior.
- Global suppression on unsubscribe.
- Unsubscribe-group-specific membership.
- Group enforcement during send.
- Group member listing.
- Add and remove group member.
- Group creation, listing, update, and deletion.
- Consent history attached to suppressed recipients.
- Synthetic unsubscribe monitoring.
- Unsubscribe SLA/consistency violations surfaced to operators.
- Tracker token-length hardening to avoid Fastify maximum-parameter-length
  failures on legitimate unsubscribe tokens.
- Global Privacy Control signal support in the privacy opt-out path.
- Tamper-resistant compliance footer appended after template rendering and
  tracking transformation.
- HTML escaping of the configured physical address.
- Physical address and unsubscribe link in both HTML and text bodies.

## 8. Suppression and consent features

- Global suppression listing.
- Add suppression.
- Remove suppression.
- Suppression reason and source.
- Email normalization.
- Suppression import.
- Suppression export.
- Current suppression enforcement during native sends.
- Suppression enforcement during workflow sends.
- Hard-bounce suppression attribution.
- Complaint suppression attribution.
- Unsubscribe attribution.
- Append-only consent event ledger.
- Suppress and unsuppress events.
- Consent action, reason, source, note, message, and timestamp.
- Consent-record creation.
- Double/confirmed consent flow.
- Consent proof retrieval.
- Consent withdrawal.
- Consent/suppression separation so the historical proof is not lost when
  current sending eligibility changes.

## 9. Messages, events, usage, and analytics

### Message retrieval

- Cursor-paginated message list.
- Limit clamping.
- Filter by status.
- Filter by tag.
- Filter by recipient.
- Filter by sender.
- Subject substring search.
- Since/until time filters.
- Stable `(queued_at, message_id)` ordering.
- Plan/tenant retention-window visibility.
- Message detail.
- Complete ordered event timeline.
- Safe attachment metadata.
- Held-message reason without exposing internal risk score.
- Searchable message-activity feed.
- Activity cursor pagination.
- Activity lookback clamped to tenant retention.

### Event model

- Queued event.
- Accepted event.
- Delivered event.
- Deferred event.
- Failed event.
- Hard-bounce event.
- Soft-bounce event.
- Complaint event.
- Opened event.
- Clicked event.
- Unsubscribed event.
- Event IP and user-agent metadata.
- Bot verdict and score.
- Event idempotency.
- Status-precedence rules.
- Webhook fan-out from normalized events.

### Usage and quota

- Daily quota.
- Monthly quota.
- Current usage/quota endpoint.
- Historical usage endpoint.
- Event-count statistics.
- Atomic quota reservation.
- Quota protection under concurrent requests.
- Quota refund when appropriate.
- Per-plan default quotas.
- Per-tenant quota overrides.
- Parent/subaccount usage rollup.
- Metering reconciliation.
- Metering-drift metric.
- Audit record and optional alert webhook on billing drift.

### Analytics

- Summary for 24 hours, 7 days, or 30 days.
- Sent, delivered, bounced, complained, opened, clicked, and unsubscribed
  counts.
- Delivery, open, and click rates.
- Hourly/daily time series.
- Breakdown by tag.
- Breakdown by sender domain.
- Breakdown by template.
- Top-100 breakdown behavior.
- PostgreSQL analytics fallback.
- Optional ClickHouse event firehose.
- ClickHouse daily rollup.
- ClickHouse reconciliation from PostgreSQL.
- Durable reconciliation watermark.
- Confirm-before-watermark-advance behavior.
- Retention-window enforcement in analytics.

## 10. Customer webhook features

- Webhook endpoint creation.
- Webhook listing.
- Webhook update through the account/settings surface.
- Webhook deletion.
- Event subscription configuration.
- HMAC-signed payloads.
- Webhook signing helper in the SDK.
- Secret returned/handled as sensitive material.
- Secret rotation.
- Previous-secret grace window.
- Scheduled cleanup of expired previous secrets.
- Delivery-attempt log.
- Delivery history endpoint.
- Background webhook worker.
- Exponential/bounded retry behavior.
- Replay of one delivery.
- Replay of selected event ranges.
- SendGrid-compatible webhook parity.
- SSRF URL validation.
- Public HTTP/HTTPS URL enforcement.
- DNS/IP pinning protections against rebinding.
- Redirect safety.
- Webhook replay runbook/documentation.

## 11. Workflow and automation features

- Workflow definition validation without saving.
- Workflow creation.
- Workflow listing.
- Workflow retrieval.
- Workflow update.
- Workflow deletion.
- Draft state.
- Publish action.
- Pause/resume-style lifecycle actions defined by the workflow route.
- Immutable published versions.
- Version listing.
- Version retrieval.
- Restore an earlier version.
- Workflow signing secret.
- Single trigger.
- Bulk trigger.
- Signed/external trigger verification.
- Manual simulation without production delivery.
- Event-triggered workflow entry.
- Wait/delay step.
- Send-email step.
- Conditional branch.
- A/B split.
- Goal/completion behavior.
- Journey/run state.
- Run retrieval.
- Run listing.
- Run cancellation.
- Workflow statistics.
- Per-recipient workflow progression.
- Suppression enforcement before workflow sends.
- Durable scheduled continuations.
- Bounded definition cache.
- Overdue-run sweep.
- Stuck-run recovery.
- Finished-run retention cleanup.
- Privacy-erasure cleanup of workflow journeys.

## 12. Data export and privacy-rights features

### Data exports

- Asynchronous export request.
- Export listing.
- Export status/detail.
- Download endpoint.
- NDJSON event export.
- Message-metadata export.
- Tenant-scoped export artifacts.
- Export retention/expiry.
- Plan-window clamping.
- Background export worker.
- Re-enqueue of stranded pending exports.
- Deliberate omission of message bodies from standard downloadable exports.

### Recipient access, correction, restriction, and objection

- Recipient data export.
- Tenant-owned messages in recipient export.
- Tenant-owned events in recipient export.
- Suppression state in recipient export.
- Recipient rectification.
- Processing restriction creation.
- Processing restriction release.
- Processing-restriction listing.
- General processing record.
- Article 30(2)-style processing record support.
- Article 32 technical-measures schedule derived from live configuration.
- Processor-assistance mappings.
- Objection request.
- Sale/share opt-out.
- Global Privacy Control handling.
- Sale/share opt-out listing.
- Sensitive-personal-information limit.
- Release of sensitive-PI limit.
- Sensitive-PI limit listing.
- Forced disablement of open/click tracking for recipients with an active
  sensitive-PI limit.
- Tracker-side retrospective enforcement for messages already in flight.
- Delivery, bounce, complaint, abuse scanning, and legal footer behavior remain
  active while engagement tracking is limited.

### Privacy case management

- Create privacy case.
- List privacy cases.
- Retrieve privacy case.
- Requester-verification step.
- Controlled case-state transitions.
- Deadline extension.
- Case artifacts.
- Case communications.
- Appeal creation.
- Appeal listing.
- Appeal decision.
- Persisted deadlines and outcome information.
- Pseudonymized identifiers in privacy operations where appropriate.
- Tenant isolation throughout case handling.

### Recipient erasure

- Recipient deletion request.
- Deletion-request status listing.
- Tenant-scoped database deletion.
- Message deletion.
- Event deletion.
- Tracked-link deletion.
- Outbox-state deletion.
- Soft-bounce-state deletion.
- Suppression-state deletion where policy allows.
- Workflow-journey deletion.
- Inline-body removal.
- Offloaded-body deletion.
- Attachment-object deletion.
- Reference checks before deleting shared/deduplicated objects.
- ClickHouse deletion item.
- Queue-payload cleanup.
- Durable message tombstones.
- Worker checks that stop stale jobs from transmitting erased data.
- Per-object pending/completed/failed state.
- Retry counter and error state.
- Scheduled retry of failed erasure work.
- Restore-time tombstone replay.
- Re-pseudonymization after restore.
- Re-queueing of object, analytics, and queue deletions after restore.
- Legal-hold interlock returning a conflict instead of deleting held data.

## 13. Retention, legal hold, and records-management features

- Tenant-wide legal hold.
- Recipient-specific legal hold.
- Legal-hold listing.
- Legal-hold release.
- Erasure blocking while a relevant hold is active.
- Retention preservation for held message bodies.
- Retention preservation for held messages and events.
- Retention preservation for tracked links.
- DMARC evidence preservation under tenant-wide hold.
- Regulatory retention lock creation.
- Regulatory retention lock listing.
- Regulatory retention lock release.
- Per-plan retention windows.
- Per-tenant retention overrides.
- Visibility-window enforcement before physical deletion.
- Bounded retention sweeps.
- Body retention.
- Event retention.
- Message-metadata retention.
- Link retention.
- Webhook-delivery-log retention.
- Send-outbox history retention.
- Export retention.
- Review/support operational-data retention.
- Blocklist-check retention.
- DMARC retention.
- Audit hot-table archival before purge.
- Persisted retention-run evidence, including failures.
- Count of rows skipped due to hold.
- Monthly event partitions.
- Monthly message partitions.
- Future partition pre-creation.
- Hold-aware expired-partition handling.
- Default-partition row monitoring.
- O(1) expired-partition drops where safe.
- Restore re-deletion runbook.

## 14. Billing and commercial features

### Plans and entitlements

- Free plan.
- Pro plan.
- Enterprise plan.
- Database-backed plan catalogue.
- Daily and monthly plan quotas.
- Standard queue-priority entitlement.
- Paid/Enterprise critical-lane eligibility.
- Billing-access evaluation.
- Grace-period behavior.
- Suspended/restricted billing behavior.
- Subscription item and provider price resolution.
- Per-provider plan-price mapping.

### Customer billing

- Billing overview.
- Hosted checkout-session creation.
- Hosted billing-portal creation.
- Invoice listing.
- Invoice detail.
- Credit-note listing.
- Plan-change preview.
- Confirm plan change.
- Cancel pending plan-change request.
- Immediate upgrade handling.
- Scheduled period-end downgrade.
- Plan-change expiry.
- Provider-confirmed plan-change reconciliation.
- Operator SLA metric for stuck plan changes.

### Providers and payment-data boundaries

- Stripe webhook endpoint.
- PayPal provider webhook support.
- Cashfree provider webhook support.
- Stripe signature verification.
- PayPal webhook verification.
- Cashfree signature and timestamp verification.
- Provider event idempotency.
- Safe billing event payload allowlist.
- Rejection/containment of card data in webhook fields.
- Provider-hosted payment model so the platform does not intentionally collect
  cardholder data.
- Admin payment-gateway enable/mode configuration.
- Credential-presence reporting without revealing credential values.

### Invoice, tax, refund, and dunning operations

- Invoice lifecycle state.
- Invoice line/subscription linkage.
- Tax fields.
- Credit notes.
- Refund/credit-note records.
- Dunning state.
- Dunning notifications.
- Scheduled dunning sweep.
- Billing restriction after configured dunning conditions.
- Billing event storage.
- Billing event inspection.
- Controlled billing-event replay.
- Metering reconciliation.
- Admin-triggered reconciliation.
- Billing event replay documentation.

## 15. Subaccount and multi-tenant features

- PostgreSQL row-level security.
- Fail-closed RLS posture.
- Dedicated non-bypass application role support.
- Startup RLS posture checks.
- Tenant context attached to application transactions.
- Guard tests for tenant routes.
- Cross-tenant access denial.
- Parent/child tenant isolation.
- Subaccount creation.
- Subaccount listing.
- Subaccount retrieval.
- Subaccount update.
- Subaccount usage summary.
- Child API-key creation.
- Child API-key metadata listing.
- Child API-key revocation.
- Parent-authorized on-behalf-of sending.
- Parent-to-child template distribution.
- Parent usage rollup.
- Suspended-subaccount behavior.

## 16. Customer support and trust features

### Customer support

- Customer ticket creation.
- Customer ticket listing.
- Ticket retrieval.
- Customer message/reply.
- Read/unread state.
- Unread-count endpoint.
- Ticket rating/CSAT.
- Ticket status and conversation history.
- Tenant isolation of support tickets.
- Card-data detection in support content.

### Internal support desk

- Admin support-ticket list.
- Three-pane support-console workflow.
- Ticket detail.
- Mark read.
- Admin reply.
- Ticket status/assignment update.
- Triage helper.
- Suggested-reply hook.
- Canned responses.
- SLA breach view.
- Customer support notes.
- Customer profile/detail view.
- Unread support counter.
- Access auditing for sensitive customer reads.
- Local heuristic triage by category and priority.
- Triage summary, labels, confidence, and provider/model attribution.
- Pluggable inference-provider interface.
- Suggested-reply draft generation.
- Suggested replies are never automatically sent.

### Abuse, review, and KYC

- Abuse/review queue.
- Review queue statistics.
- Individual approve action.
- Individual reject action.
- Bulk review action.
- Action-specific admin roles.
- Review action rate limiting.
- Review timeout handling.
- Customer suspension.
- Customer reinstatement.
- KYC queue.
- KYC approve.
- KYC request-more-information.
- KYC reject.
- Reviewer, note, status, and timestamp persistence.
- KYC level update on approval.
- Audit records for trust decisions.

### Dead-letter operations

- DLQ listing.
- DLQ detail.
- Replay one DLQ item.
- Delete one DLQ item.
- Purge DLQ.
- Rate limits on replay and purge.
- Typed confirmation in the admin console for destructive purge.
- DLQ operational runbook.

## 17. Admin API and console features

### Admin authentication and security

- Separate admin identity store.
- Admin login.
- TOTP MFA login step.
- Admin lockout and rate limiting.
- Admin logout.
- Bearer-token support for operations tooling.
- Same-origin admin cookie session.
- `__Host-`-prefixed, HttpOnly, SameSite=Strict cookie in secure deployments.
- Local non-TLS cookie option.
- In-memory CSRF secret.
- CSRF header on mutations.
- Origin validation.
- Fetch Metadata validation.
- Admin bootstrap from session cookie.
- CSRF rotation during bootstrap.
- Server-derived capability map.
- Query-cache identity boundary in the SPA.
- Cache purge and in-flight cancellation on logout or `401`.
- Closed typed operation registry to reduce client-side request forgery.
- Role hierarchy: support, operator, admin, superadmin.

### Fleet overview

- Platform overview cards.
- Seven-day volume time series.
- Zero-filled daily buckets.
- Top tenants/senders by recent volume.
- Review-queue statistics.
- Pool-health summary.
- Support SLA-breach summary.
- DLQ widget for authorized operators.

### Tenant management

- Tenant list.
- Tenant detail drawer.
- Customer state update.
- Customer support notes.
- Suspend tenant.
- Reinstate tenant.
- Typed confirmation for suspension.
- Role-aware actions.

### Deliverability and pools

- Pool-health view.
- Reputation-pool view.
- Blocklist scan trigger.
- Pool inventory.
- Role-gated operator actions.

### Support, abuse, KYC, audit, billing, and settings screens

- Support inbox.
- Abuse review queue.
- KYC decision queue.
- Cursor-paginated audit-log screen.
- Audit action filter.
- Client-side CSV export of loaded audit data.
- Billing-event list.
- Billing-event detail.
- Billing-event replay.
- Billing reconciliation.
- Payment-gateway screen.
- Payment-gateway enable/mode editor.
- Platform settings grouped into quotas, bounce thresholds, warmup, and
  security.
- Manual retention run.
- DLQ management.

### Admin team and privileged access

- Admin listing.
- Admin creation.
- Admin update.
- Admin role management.
- Elevation listing.
- Elevation creation.
- Elevation deletion.
- Break-glass elevation.
- Elevation expiry.
- Immutable break-glass review.
- Staff-access review queue.
- Default-on audit of admin-plane reads.

### Deliberate admin-console boundaries

The repository does not currently claim:

- browser Playwright coverage for the SPA;
- server-sent live updates;
- WebAuthn step-up in the admin SPA;
- OIDC login UI, although the backend route exists;
- virtualized million-row lists;
- a static-host CSP/Trusted Types deployment manifest.

## 18. Audit, immutable evidence, and access-review features

- Customer/tenant audit feed.
- Admin audit feed.
- Actor type, identifier, label, IP, action, resource, and metadata.
- Append-oriented audit behavior.
- Per-tenant hash chain.
- Previous-hash linkage.
- Audit-chain verification endpoint.
- Automated hash-chain tests.
- Archive of old audit rows before hot-table removal.
- Ed25519 chain checkpoints.
- Scheduled checkpoint generation.
- WORM export integration.
- Full audit segment export.
- Checksum-addressed evidence.
- KMS encryption for independent audit export.
- S3 Object Lock COMPLIANCE retention integration.
- Independent audit-export records.
- Default-on audit of admin reads.
- Admin access-review queue.
- Immutable review decision.
- Break-glass review.
- Retention-safe audit handling.
- Audit checkpoint and export operational alerts/hooks.
- Audit hash-chain documentation.

## 19. Compliance-supporting technical features

### SOC 2 support

- Hash-chained audit records.
- Signed audit checkpoints.
- Independent immutable audit export.
- Admin access-review workflow.
- Break-glass review.
- Retention-run evidence.
- Monthly control-evidence collection.
- Explicit `complete`, `partial`, or `missing` result.
- Finding creation when expected evidence is absent.
- Evidence recollection invalidates an earlier review sign-off.
- Reviewer sign-off.
- Evidence-input controls that reject email addresses and
  credential-shaped fields.
- Eight currently evaluated controls:
  - `CANSPAM-05`;
  - `CANSPAM-08`;
  - `BASE-03`;
  - `BASE-05`;
  - `BASE-06`;
  - `BASE-10`;
  - `PCI-02`;
  - technical evidence used by `HIPAA-07`.
- Daily scheduler that collects the previous closed calendar month at most once
  unless deliberately recollected.

Boundary: a CPA firm must assess the deployed organization and production
operating evidence before any SOC 2 report can be claimed.

### ISO/IEC 27001 support

- Identity and access controls.
- Cryptographic secret protection.
- Audit logging and tamper evidence.
- Change-protection checks in CI.
- Dependency and image vulnerability checks.
- Incident and breach runbooks.
- Backup, restore, and resilience tooling.
- Vendor-register template.
- Control-evidence mechanisms.

Boundary: an organization-owned ISMS, risk assessment/treatment, policies,
internal audit, management review, and accredited certification audit are
external.

### GDPR support

- Access/export.
- Rectification.
- Restriction.
- Objection.
- Erasure.
- Consent evidence and withdrawal.
- Processing records.
- Processor-assistance mapping.
- Retention controls.
- Legal holds.
- Pseudonymization.
- Restore-time re-deletion.
- Tenant-safe privacy case management.

Boundary: controller/processor roles, lawful basis, notices, transfer
mechanisms, DPIAs, DPAs, requester verification, and production procedures are
organizational/legal responsibilities.

### CCPA/CPRA support

- Access.
- Deletion.
- Correction.
- Sale/share opt-out.
- Global Privacy Control handling.
- Sensitive-PI limitation.
- Appeal workflow.
- Consent/suppression separation.
- Retention controls.

Boundary: applicability, notices, authorized-agent verification, business
determinations, contracts, and request operations require legal/operational
approval.

### CAN-SPAM support

- Commercial-message classification.
- Sender identity checks.
- Required physical-address/footer handling.
- One-click unsubscribe.
- Unsubscribe groups.
- Suppression enforcement.
- Synthetic unsubscribe monitoring.
- Sender bounce/complaint health enforcement.
- Opt-out-friction tests.
- Sender-identity tests.

Boundary: senders remain responsible for lawful content, truthful headers,
campaign classification, configured physical address, and operating the legal
opt-out process.

### PCI DSS scope-reduction support

- PAN pattern classification.
- Card-data checks in message submission.
- Card-data checks in SMTP submission.
- Card-data checks in support tickets.
- Billing-webhook field allowlist.
- Provider-hosted checkout.
- Payment-data flow documentation.
- Card-data incident runbook.
- Fail-closed blocking/containment.

Boundary: cardholder data is prohibited in messages, metadata, tickets, and
webhook fields. The repository does not provide a PCI assessment, SAQ, ROC, or
attestation.

## 20. Regulated-workload features and activation gates

### Shared regulated-workload controls

- Disabled-by-default regulated modes.
- Separate activation for HIPAA, FERPA, and SEC/FINRA.
- Enterprise-tier requirement.
- Activation request endpoint.
- Workload-posture endpoint.
- Prerequisite-evidence listing and submission.
- Framework-specific prerequisite catalogue.
- Evidence approval requirement.
- Evidence expiry.
- Evidence checksum.
- Independent reviewer requirement.
- Prevention of self-approval.
- Missing, expired, or rejected evidence blocks activation.
- Activation and denial audit records.
- One regulated mode never automatically activates another.
- PAN remains prohibited in every mode.
- Value-free content-classification findings so sensitive source values are not
  copied into review metadata.
- Regulated case artifacts.
- Regulatory retention interlocks.
- External penetration-test scope document.
- Framework-assessment evidence index.
- Activation runbook.

### Content classification

- PAN classification.
- PHI classification.
- Education-record classification.
- Broker-dealer/regulated-financial-record classification.
- General commercial-message classification.
- Sensitive-personal-information classification.
- Structured finding type and reason.
- Send-path enforcement.
- SMTP-path enforcement.
- Support-path card-data enforcement.
- Review/hold routing where policy permits.
- Fail-closed rejection where the workload is prohibited or not activated.

### Secure-message portal

- Secure-message creation for authorized HIPAA/FERPA modes.
- Encrypted stored content.
- Expiring secure message.
- Recipient-bound access.
- Two-credential access model.
- Portal access endpoint.
- Secure-message revocation.
- Access audit record.
- No ordinary open/click tracking for protected portal content.
- Message notification separate from protected content.
- KMS/Vault-backed key access in production configuration.

### HIPAA workflow support

- Independently gated HIPAA mode.
- PHI detection.
- Secure-message portal requirement.
- Access-rights case.
- Amendment-style case support where configured.
- Disclosure accounting.
- HIPAA breach-assessment artifact.
- Retention interlock.
- Immutable access evidence.
- OIDC/MFA context requirements.
- Contingency/backup evidence prerequisite.
- BAA and risk-analysis evidence gates.

Boundary: a genuine BAA, applicability determination, risk analysis, safeguard
evidence, target-environment contingency tests, workforce procedures, and
independent HIPAA assessment are external prerequisites.

### FERPA workflow support

- Independently gated FERPA mode.
- Education-record detection.
- Secure-message portal requirement.
- Access case.
- Amendment case.
- Amendment outcome.
- Hearing/outcome workflow support.
- Disclosure accounting.
- Redisclosure-restriction metadata.
- Retention interlock.
- Case artifacts and communications.

Boundary: school-official/direct-control terms, institutional process
allocation, state-law review, training, and independent assessment are
external.

### SEC/FINRA workflow support

- Independently gated SEC/FINRA mode.
- Broker-record/regulated-communication classification.
- Archive-before-accept rule.
- Specialist archive integration seam.
- Fail-closed send when archive is unavailable.
- Immutable provider receipt.
- Archive-record listing.
- Reconciliation support.
- Regulatory retention lock.
- Zero-acceptance behavior when archival proof is missing.

Boundary: the operator must contract and configure a qualifying specialist
archive, retention/supervision policy, provider certification, legal
applicability review, and specialist assessment.

## 21. Encryption, secrets, and application-security features

### Encryption and key management

- AES-256-GCM application encryption.
- Authenticated encryption metadata.
- Encrypted DKIM private keys.
- Encrypted MFA seeds and selected application secrets.
- Pluggable KMS interface.
- AWS KMS provider support.
- Vault provider support.
- Key-access preload during API/worker startup.
- Startup proof that remote keys are usable before accepting work.
- Production refusal of environment-only key storage unless an explicit
  single-host exception is configured.
- Key-compromise runbook.

Boundary: application-level secret encryption is not blanket encryption of
database files, message bodies, object versions, logs, ClickHouse, or backups;
those require target-infrastructure encryption.

### HTTP and API security

- CORS allowlist.
- Global rate limiting.
- Route-specific rate limiting.
- Standardized error envelope.
- Stable error-code registry.
- Security headers.
- Request validation with Zod.
- SQL construction that avoids unvalidated raw fragments.
- SSRF protection.
- Webhook DNS/IP pinning.
- Sensitive log redaction.
- Sensitive trace redaction.
- Credential-shaped evidence-field rejection.
- Configuration guardrails.
- Production secret-length/placeholder checks.
- OIDC policy guardrails.
- RLS posture guardrails.
- Metrics bearer-token protection.

### Attachment and content safety

- Executable signature detection.
- Optional malware scanning.
- Regulated-content classification.
- Card-data containment.
- Sensitive-PI handling.
- Send-review queue.
- Abuse/KYC controls.
- Account suspension and sender holds.

## 22. Observability and operational telemetry

### Health and readiness

- API `/live`.
- API `/health`.
- API `/ready`.
- Tracker `/live`.
- Tracker `/health`.
- Tracker `/ready`.
- SMTP gateway health.
- Dependency-aware readiness checks.
- Kubernetes probes.
- Status-page heartbeat manifest.

### Metrics

- API Prometheus metrics.
- Worker Prometheus metrics.
- Tracker Prometheus metrics.
- SMTP gateway Prometheus metrics.
- `mp_` metric namespace.
- Queue and delivery measurements.
- Bounce-rate gauge.
- Complaint-rate gauge.
- Pool-pause gauge.
- Blocklist-listing gauge.
- Metering-drift gauge.
- Stuck billing-plan-change gauge.
- Partition-default-row gauges.
- Retention held-row measurement.
- Backpressure rejection count.
- Protected metrics endpoints.

### Dashboards, alerts, traces, and logs

- Prometheus scrape configuration.
- SMTP gateway scrape configuration.
- Grafana Prometheus datasource.
- General mail-platform dashboard.
- Send-pipeline dashboard.
- Deliverability dashboard.
- Prometheus alert rules.
- Alertmanager routing configuration.
- Jaeger trace UI.
- OTLP HTTP receiver.
- OpenTelemetry API, worker, and tracker integration.
- Trace context and spans.
- Sensitive-data redaction from logs and traces.
- Structured Pino logging.
- Runbooks linked to operational failure modes.

## 23. Scheduled operational jobs

The worker includes a distributed-lock-aware in-process scheduler. Jobs are
written so they can later run as separate cron workloads.

- Send outbox drain.
- Stale outbox claim recovery.
- Pending export recovery.
- Webhook previous-secret cleanup.
- Reputation guard.
- Blocklist monitor.
- IP warmup advancement.
- DKIM selector retirement.
- ClickHouse reconciliation.
- Privacy-erasure retry.
- Synthetic CAN-SPAM unsubscribe monitor.
- Idempotency-record sweep.
- Billing-meter reconciliation.
- Sender-health sweep.
- Billing dunning sweep.
- Plan-change preview expiry.
- Submitted plan-change reconciliation.
- Scheduled downgrade application.
- Plan-change SLA monitoring.
- Admin elevation expiry.
- Audit-chain checkpoint and immutable export.
- Event/message partition maintenance.
- Daily retention with persisted evidence.
- Monthly control-evidence collection.
- Google Postmaster/SNDS ingestion.
- Volume-baseline update.
- Stale-send recovery.
- Overdue/stuck workflow-run recovery.
- Finished workflow-run retention.
- Review-queue timeout handling.

## 24. Deployment and infrastructure features

### Local development

- Docker Compose core stack.
- Optional `monitoring` profile.
- Optional `analytics` profile.
- PostgreSQL persistent volume.
- Redis append-only persistence.
- Haraka outbound queue volume.
- Mailpit.
- One-shot migration container.
- Dependency health checks.
- Hot local API/worker/tracker/admin development scripts.
- Seed script.
- Admin creation script.
- Admin demo seed.
- Isolated test infrastructure documentation.

### Kubernetes and Helm

- Helm chart.
- Namespace template.
- API Deployment and Service.
- Worker Deployment.
- Tracker Deployment and Service.
- Haraka workloads.
- Migration Job.
- Ingress.
- ConfigMaps.
- API and worker HPAs.
- Pod disruption budget.
- Network policies.
- cert-manager manifest.
- Istio mTLS manifest.
- CloudNativePG PostgreSQL manifest.
- Secret example.
- Status-page heartbeat.
- Helm render-check script.

### Hetzner foundation

- Terraform provider/version configuration.
- Three-node foundation.
- Network and firewall definitions.
- Server provisioning.
- Cloud-init template.
- Variables and outputs.
- Example variable file.
- Hetzner deployment guide.

The Terraform foundation does not by itself make a production deployment HA,
compliant, or ready for regulated workloads. Database, Redis, object storage,
secrets, immutable audit storage, backups, monitoring, DNS, certificates, and
drills must be configured and evidenced.

### Availability, backup, and disaster recovery

- HA/DR architecture documentation.
- PostgreSQL backup/restore drill.
- Point-in-time recovery drill.
- Redis failover drill.
- Restore-time privacy tombstone replay.
- Kubernetes disruption controls.
- Horizontal scaling manifests.
- Database scale benchmark.
- Operational drill documentation.
- RPO/RTO recording guidance.
- Queue-backpressure runbook.
- Incident and breach runbook.

### Production readiness and supply-chain checks

- Production readiness checker.
- Production configuration guard.
- Single migration path.
- Migration-topology tests.
- Dependency audit.
- SBOM generation in CI.
- Trivy production-image scanning.
- SARIF/security-report upload.
- OpenAPI breaking-change check.
- OpenAPI route-parity check.
- Build and type checks.
- k6 send load scenario.
- k6 tracker load scenario.
- Deployment checklist.

## 25. Developer experience and integration features

- npm workspace monorepo.
- TypeScript across application services.
- Fastify APIs.
- Shared package for domain logic.
- Typed SDK.
- Configurable SDK base URL.
- Configurable request timeout.
- Automatic bounded retry.
- Structured SDK error with HTTP status, error code, and body.
- SDK resources for:
  - messages;
  - suppressions;
  - domains;
  - templates;
  - webhooks;
  - usage;
  - analytics.
- SDK webhook-signature verification.
- OpenAPI 3.1 document.
- `/openapi.json`.
- OpenAPI export CLI.
- Checked OpenAPI baseline.
- Breaking-change test.
- Route/spec parity test.
- API version-lifecycle documentation.
- Error catalogue.
- Testkit helpers.
- Docusaurus documentation site.
- REST, SMTP, tracking, domains, templates, suppression, webhooks, analytics,
  privacy, workflows, and migration guides.
- SendGrid migration guide.

## 26. Plan and persona behavior

Most capabilities are controlled by API-key scope or human membership
capability. Plan tier currently governs quota, billing state, normal priority,
critical-lane eligibility, retention defaults, and regulated-mode eligibility.

| Behavior | Free | Pro | Enterprise |
| --- | ---: | ---: | ---: |
| Persona-test daily quota | 100 | 50,000 | 1,000,000 |
| Persona-test monthly quota | 3,000 | 1,000,000 | 50,000,000 |
| Normal send priority | 10 | 5 | 1 |
| Requested critical lane | Downgraded | Eligible | Eligible |
| Billing plan | `free` | `pro` | `enterprise` |
| HIPAA/FERPA/SEC-FINRA activation eligibility | No | No | Evidence-gated |

### Free, Pro, and Enterprise feature availability

The following is the user-facing plan summary. **Available** still requires the
relevant API-key scope or human role, an active account/billing state, verified
email and sender identity where applicable, and any required infrastructure.

| Feature family | Free | Pro | Enterprise |
| --- | --- | --- | --- |
| Registration, login, sessions, password reset | Available | Available | Available |
| TOTP MFA and WebAuthn/passkeys | Available | Available | Available |
| Scoped API keys and key rotation | Available | Available | Available |
| REST single and batch sending | Available | Available | Available |
| Authenticated SMTP | Available | Available | Available |
| SendGrid-compatible API and typed SDK | Available | Available | Available |
| Templates, variables, attachments, tags, scheduling | Available | Available | Available |
| Normal queue priority | 10 | 5 | 1 |
| Critical queue lane | Downgraded to normal | Available, rate-capped | Available, rate-capped |
| Daily quota | 100 | 50,000 | 1,000,000 |
| Monthly quota | 3,000 | 1,000,000 | 50,000,000 |
| Sending domains, SPF/DKIM/DMARC, scanner | Available | Available | Available |
| Tracking, bot classification, unsubscribe | Available | Available | Available |
| Suppressions, groups, consent records | Available | Available | Available |
| Messages, activity, usage, and analytics | Available | Available | Available |
| Default event/activity retention | 7 days | 90 days | 365 days |
| Default body retention | 7 days | 90 days | 90 days |
| Customer webhooks, rotation, retry, replay | Available | Available | Available |
| Workflows, versions, triggers, simulation | Available | Available | Available |
| Privacy exports, erasure, cases, appeals | Available | Available | Available |
| Legal holds and regulatory locks | Available | Available | Available |
| Support tickets and CSAT | Available | Available | Available |
| Team roles and invitations | Available; no tier gate | Available; no tier gate | Available |
| SSO and SCIM | Available; no tier gate | Available; no tier gate | Available |
| Subaccounts, child keys, on-behalf-of send | Available; no tier gate | Available; no tier gate | Available |
| Audit feed and integrity verification | Available | Available | Available |
| Billing overview, checkout, invoices, plan changes | Available | Available | Available |
| HIPAA mode | Not eligible | Not eligible | Evidence-gated |
| FERPA mode | Not eligible | Not eligible | Evidence-gated |
| SEC/FINRA mode | Not eligible | Not eligible | Evidence-gated |
| PAN/cardholder data in content or tickets | Prohibited | Prohibited | Prohibited |

The plan catalogue contains metadata for seats, dedicated pools, SSO, SCIM,
webhooks, and analytics days. The current customer routes do not use that
metadata as a general plan paywall. It must not be presented as enforced until
route-level deny behavior and plan-specific tests are added.

The detailed authorization-by-feature sheet is maintained in the
[Persona E2E feature matrix](testing/PERSONA_FEATURE_MATRIX.md). That matrix
also contains the authoritative test-coverage audit, including specialized
coverage, missing automated cases, and staging/provider tests that must be
completed before production.

The codebase contains end-to-end persona journeys for:

- Free developer onboarding and first delivery;
- Paid SaaS subscription and production sending;
- Enterprise organization/team/subaccount operations;
- common account lifecycle;
- credentials and domains;
- content and delivery;
- REST/SMTP/SendGrid/SDK channel parity;
- consent and integrations;
- automation, privacy, and support;
- governance and resilience;
- separately gated HIPAA, FERPA, SEC/FINRA, and SOC2-06 evidence flows in the
  live development validation scripts.

## 27. Testing and verification assets

The current tree contains:

- 171 automated test files;
- 96 PostgreSQL migration files, through migration `097`;
- unit tests for shared security and domain logic;
- database integration tests;
- API/service end-to-end tests;
- real PostgreSQL and Redis E2E harness;
- real worker/queue execution in E2E;
- Mailpit delivery assertions;
- free, paid, and Enterprise persona suites;
- SMTP gateway tests;
- tracking and bot-detection E2E tests;
- billing-provider and lifecycle tests;
- tenant RLS tests;
- privacy erasure/tombstone/restore tests;
- regulated-workload, secure-portal, rights, retention, and archive tests;
- audit chain, checkpoint, WORM, access-review, and control-evidence tests;
- OpenAPI, migration, hardening, logging, tracing, SSRF, and configuration
  guard tests;
- local live-development replay scripts:
  - general platform E2E;
  - compliance E2E;
  - regulated-workload E2E;
  - persona seeding/replay/verification.

The latest documented clean aggregate run is 171/171 files and 1,195/1,195
tests on 2026-07-27. Migration `097` and the deterministic recipient-domain TLS
last-outcome fix were added after the README snapshot; focused transport
security suites passed after that fix. A fresh aggregate run is required before
representing the current checkout as a new full-suite result.

## 28. Important boundaries and items not supplied by source code

The following are not complete product claims merely because related code or
templates exist:

- a live production deployment;
- production DNS, TLS certificates, and sender reputation;
- dedicated production IP warmup evidence;
- guaranteed inbox placement;
- blanket end-to-end message encryption;
- blanket encryption of every datastore, log, replica, and backup;
- data-residency guarantees;
- independently controlled production KMS/Vault custody;
- independently controlled immutable audit bucket custody;
- measured HA, restore, PITR, and failover results on the chosen infrastructure;
- production load and capacity results;
- active ClamAV deployment and monitoring;
- signed BAAs, DPAs, archive-provider agreements, or customer contracts;
- SOC 2 report;
- ISO 27001 certification;
- HIPAA, FERPA, SEC/FINRA, PCI DSS, GDPR, or CCPA legal determination;
- an external penetration test;
- an independent framework-specific assessment;
- production workforce policies, training, access reviews, incident exercises,
  and evidence retention;
- a customer-facing dashboard SPA; the customer product is currently API-first,
  while the included React UI is the internal admin console;
- browser-level automated testing of the admin console.

## 29. Source map

The main implementation areas used to compile this inventory are:

| Area | Repository location |
| --- | --- |
| Customer/admin API routes | `packages/api/src/routes/` |
| API security and auth plugins | `packages/api/src/plugins/` |
| Delivery/domain/privacy/billing logic | `packages/shared/src/` |
| Send/event/webhook/export/workflow workers | `packages/worker/src/` |
| SMTP submission | `packages/smtp-gateway/src/` |
| Outbound/inbound SMTP | `packages/haraka-outbound/`, `packages/haraka-inbound/` |
| Tracking and unsubscribe | `packages/tracker/src/` |
| Typed SDK | `packages/sdk/src/` |
| Admin console | `packages/admin-console/src/` |
| Database schema evolution | `infra/migrations/` |
| Monitoring | `infra/prometheus/`, `infra/grafana/`, `infra/alertmanager/` |
| Kubernetes/Helm/Hetzner | `infra/k8s/`, `infra/helm/`, `infra/hetzner/` |
| Tests | `packages/tests/` |
| Operations scripts | `scripts/` |
| Compliance and runbooks | `docs/` |

For framework-specific limitations and activation requirements, also read:

- [Compliance posture](COMPLIANCE_POSTURE.md)
- [Regulated-workload policy](REGULATED_WORKLOAD_POLICY.md)
- [Production checklist](PRODUCTION_CHECKLIST.md)
- [End-to-end validation report](END_TO_END_VALIDATION_REPORT_2026-07-27.md)
- [Persona feature matrix](testing/PERSONA_FEATURE_MATRIX.md)
- [End-to-end production test plan](testing/END_TO_END_PRODUCTION_TEST_PLAN.md)
