# Security & Compliance

How the platform protects your data and your recipients' data, and how it
maps to the regulatory frameworks our customers operate under.

## Platform security architecture

- **Tenant isolation, enforced twice.** Every query is scoped to your account
  in the application layer *and* by fail-closed PostgreSQL row-level security
  — the database refuses cross-tenant reads even if application code has a
  bug. The API refuses to boot in production if this posture cannot be
  verified.
- **Encryption.** TLS on every API connection; sensitive stored secrets
  (DKIM private keys, MFA seeds) are envelope-encrypted; opportunistic TLS on
  all outbound mail with a per-account **TLS-required mode** (below).
- **Tamper-evident audit.** Every administrative and account action lands in
  an append-only audit log whose entries are hash-chained and periodically
  checkpoint-signed — after-the-fact modification of history is detectable.
- **Access control.** Scoped API keys (least privilege per integration),
  team roles, SSO (SAML/OIDC) with optional enforcement, SCIM user
  provisioning, MFA including WebAuthn/passkeys, and just-in-time elevation
  with expiry on the operator plane.
- **Data lifecycle.** Per-plan retention windows for message bodies and
  events, per-recipient GDPR deletion and export APIs, legal-hold support,
  and a consent ledger recording every suppression/unsubscribe with source
  and timestamp.

## TLS-required mode (healthcare & finance)

Set `tls_required: true` on your account (`PATCH /v1/profile`). Every message
is then stamped with a require-TLS marker, and each delivery records whether
the connection to the receiving server was actually TLS-secured — visible as
`tls_secured` in the `delivered` event payload. That gives you per-message
transport-encryption evidence for audits, not just a policy statement.

## Framework mapping

### HIPAA (healthcare)
Email containing PHI requires a Business Associate Agreement with your email
provider plus transport safeguards. The platform provides: TLS-required mode
with per-delivery evidence, retention windows you control (down to
delete-after-delivery for bodies), per-recipient erasure, access-scoped API
keys, and the tamper-evident audit trail. **BAA:** available on enterprise
agreements — contact support. Self-hosted deployments keep PHI entirely on
your own infrastructure.

### PCI DSS (payments & finance)
The platform never stores cardholder data — payment flows are handled by the
billing provider (Stripe/PayPal/Cashfree). For transactional card alerts and
OTPs, use the **critical send lane** (`priority: "critical"`) for
head-of-queue dispatch and TLS-required mode for transport evidence. Scoped
keys let your PCI-zone systems hold a key that can only send.

### FERPA / NYS Ed Law 2-d (education)
Student data in transactional mail stays inside your tenant boundary (RLS),
is erasable per recipient, and ages out on your configured retention window.
The consent ledger documents every opt-out for parent-communication
compliance. Data is never sold or used for advertising; subprocessors are
listed below.

### SEC 17a-4 / FINRA (financial services)
The append-only, hash-chained audit log and the message event timeline
provide books-and-records evidence; retention windows are configurable per
plan, and legal holds prevent destruction during proceedings. WORM-style
audit archival with signed checkpoints is built in.

### GDPR (all regions)
Per-recipient erasure (`POST /v1/privacy/delete-recipient`) removes messages,
events, tracked links, stored bodies, attachments, and workflow journeys in
one transaction — gated by legal-hold checks. Data export APIs cover
Art. 15/20. Suppressions double as consent records with full history.

## Subprocessors

For the hosted service: cloud infrastructure (compute/storage), the payment
providers above (billing only — never message content), and optional
analytics storage (ClickHouse, self-managed). Self-hosted deployments have
no platform subprocessors — everything runs on your infrastructure.

## Shared-responsibility notes

- Verify your sending domains (SPF/DKIM/DMARC) — the platform blocks sending
  until you do, and the [domain scanner](../api-reference.md#tools) audits
  your posture any time.
- Attachment content is scanned for blocked executable types; you remain
  responsible for the lawful content of what you send.
- Keep API keys scoped and rotate them (`POST /v1/account/api-keys/:id/rotate`
  has a zero-downtime overlap window).
