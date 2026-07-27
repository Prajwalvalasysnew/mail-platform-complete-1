# Security and compliance

The platform includes technical controls that can support a regulated
deployment. Those controls do not by themselves make an organization or a
deployment compliant, certified, or attested against any legal or industry
framework.

For the evidence matrix, known gaps, and production acceptance checklist, see
[Compliance posture and evidence](../COMPLIANCE_POSTURE.md).

## Platform security architecture

- **Tenant isolation:** application-layer tenant scoping plus fail-closed
  PostgreSQL row-level security. Production startup verifies that the
  application role is neither superuser nor `BYPASSRLS`.
- **Access control:** scoped API keys, team capabilities, customer sessions,
  TOTP and WebAuthn/passkeys, SSO enforcement, SCIM provisioning, admin roles,
  and audited just-in-time/break-glass elevation.
- **Selected-secret encryption:** DKIM private keys, MFA seeds, and other
  selected secrets use AES-256-GCM. Production can obtain the master data key
  from AWS KMS or Vault. Production API/worker startup preloads and validates
  remote-key access before accepting work. This is not blanket encryption of message
  data, storage volumes, logs, analytics, or backups.
- **Audit integrity:** administrative and account actions enter audit logs with
  tenant hash chains, verification, archive-before-purge, signed checkpoints,
  and WORM-style export support.
- **Data lifecycle:** tenant-safe recipient export and erasure, external-object
  deletion retries, queue tombstones, legal holds, per-plan/tenant retention,
  downloadable exports, DMARC retention, and append-only consent history.
- **Deployment controls:** TLS, service-mesh mTLS, high availability, backups,
  and restore tooling are provided as manifests/runbooks and must be configured
  and validated in the real production environment.

## Outbound TLS setting

`PATCH /v1/profile` accepts `tls_required: true`. The send pipeline marks those
messages, and the Haraka event plugin records `tls_required` and whether the
delivery hop was `tls_secured`. It also emits a violation log if a marked
message is reported delivered without TLS.

This is currently **policy and evidence**, not strict delivery enforcement: the
code does not defer or fail every non-TLS downstream SMTP delivery. SMTP TLS
protects a transport hop and is not the same as message-level end-to-end
encryption. Do not rely on this setting alone for PHI or other sensitive data.

## Framework mapping

### HIPAA

Status: **partial technical foundation; compliance is not established**.

Relevant controls include tenant/access boundaries, MFA/SSO, audit integrity,
retention and legal holds, erasure orchestration, selected-secret encryption,
transport evidence, and contingency tooling. The repository does not include
or prove a BAA, organization-wide risk analysis, security policies, workforce
training, physical safeguards, production control configuration, breach
notification program, or tested contingency plan. It makes no claim that a
BAA is commercially available.

HHS requires administrative, physical, and technical safeguards and treats
risk analysis as foundational. Where the platform is a business associate,
written contractual assurances are generally required. Assess every ePHI email
use case and document how transmission is adequately protected.

- [HHS Security Rule](https://www.hhs.gov/hipaa/for-professionals/security/index.html)
- [HHS Risk Analysis Guidance](https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html)
- [HHS Business Associate Contracts](https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html)
- [HHS guidance for sending ePHI by email](https://www.hhs.gov/hipaa/for-professionals/faq/2006/does-the-security-rule-allow-for-sending-electronic-phi-in-an-email/index.html)

### GDPR and CCPA

Status: **supporting application controls; legal compliance is not
established**.

The platform supports recipient access/export, erasure across authoritative
online stores, consent history, suppression, retention, legal holds, and tenant
isolation. The customer/operator must determine roles and lawful basis, verify
requesters, handle deadlines and exceptions, publish notices, execute DPAs and
transfer terms, govern subprocessors, and define backup and regional policy.

See [Privacy and GDPR](privacy-gdpr.md).

### PCI DSS

Status: **not assessed or attested**.

Billing integrations are designed to delegate payment collection to configured
providers. That does not prove cardholder data can never enter logs, webhook
payloads, support tickets, or email content. Keep cardholder data and sensitive
authentication data out of the mail platform and have a qualified assessor
determine scope.

### SOC 2 and ISO 27001

Status: **not attested or certified**.

Audit, access, tenant-isolation, change/testing, vulnerability, backup, and
monitoring controls can produce useful evidence. A real program still needs
control ownership, policies, risk management, vendor management, evidence over
an operating period, and an independent audit/certification.

### FERPA, SEC 17a-4, FINRA, and other sector rules

Isolation, retention, legal holds, and audit exports may support these
programs. The repository does not establish required record scope, retention
period, immutable-storage qualification, supervision, contracts, regional
rules, or legal interpretation. Obtain framework-specific review before making
a claim.

## Shared responsibility

- Classify data and minimize sensitive content before sending it by email.
- Verify sending domains and operate SPF, DKIM, and DMARC correctly.
- Select and monitor production database, object storage, analytics, queue,
  logging, and backup encryption and retention.
- Use least-privilege keys, enforce MFA/SSO as appropriate, review access, and
  remove access promptly.
- Configure alerting for erasure retries, retention jobs, audit verification,
  backup age, failed restores, malware scanning, and TLS-policy violations.
- Document incident response, breach assessment/notification, legal hold,
  access review, change management, and contingency procedures.
- List actual production subprocessors and execute all required contracts; a
  self-hosted application can still depend on cloud, identity, analytics,
  payment, support, monitoring, and delivery providers.

This documentation is an engineering description, not legal advice.
