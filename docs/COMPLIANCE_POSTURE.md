# Compliance posture and evidence

Reviewed: 2026-07-22

This document separates controls implemented in this repository from legal or
operational claims that source code cannot prove. It is an engineering control
assessment, not legal advice, certification, attestation, or authorization to
process regulated data.

## Scope and status language

- **Implemented and tested** means the application behavior exists and has
  automated unit/integration or API/service E2E coverage.
- **Partial** means a useful control exists, but its scope is narrower than the
  regulatory requirement or it depends materially on production configuration.
- **External gap** means the repository cannot implement or prove the control;
  the deploying organization must supply contracts, policy, infrastructure, or
  operational evidence.

The review covers the application source, migrations, deployment manifests,
runbooks, and focused automated tests. It does not assess a live production
environment, cloud account, workforce, vendors, contracts, or legal posture.

## Privacy and lifecycle controls

| Control | Status | Implementation and automated evidence | Boundary or remaining work |
| --- | --- | --- | --- |
| Recipient access export | Implemented and tested | `GET /v1/privacy/export-recipient` returns tenant-owned messages, events, and suppression state; `privacy-export.e2e.test.ts` covers success, validation, authentication, and cross-tenant isolation | The controller must authenticate the data subject and determine the legally required scope |
| Downloadable exports | Implemented and tested | Asynchronous NDJSON event and message-metadata exports are created, materialized, downloaded, tenant-isolated, retention-clamped, and expired; `exports.e2e.test.ts` | These exports intentionally omit message bodies; the requester and scope still require controller review |
| Authoritative database erasure | Implemented and tested | `POST /v1/privacy/delete-recipient` removes recipient messages, events, tracked links, outbox state, soft-bounce state, suppression state, and workflow journeys in a tenant transaction | Legal obligations may require preserving specific records; an active hold returns `409 legal_hold_active` |
| Inline/offloaded bodies and attachments | Implemented and tested | Inline content disappears with the message row. Offloaded content, including serialized attachments, is deleted only after deduplication checks show no surviving reference; failures remain pending and retry | Object-store lifecycle/versioning and provider backups must also be configured so deleted versions do not persist beyond policy |
| Queue and worker erasure | Implemented and tested | BullMQ payload cleanup, durable message tombstones, and send/event/webhook worker gates prevent stale jobs from recreating or transmitting erased data; `privacy-queue-erasure.test.ts` and `privacy-worker-tombstone.e2e.test.ts` | Active jobs may complete only after the retry path can safely remove them; scheduler health must be monitored |
| Analytics erasure | Implemented in code and retry ledger | ClickHouse deletion items are recorded and retried when analytics is enabled | Production ClickHouse mutation completion and replica/backup propagation need monitoring and evidence |
| Erasure audit state | Implemented and tested | Deletion requests and per-object status retain pending/completed/failed state without retaining the erased message content | The operator must alert on exhausted retries and define evidence-retention policy |
| Legal holds | Implemented and tested | Tenant and recipient holds block direct erasure and preserve applicable bodies, events, links, message rows, and tenant DMARC evidence during retention; `legal-hold*.test.ts`, `retention-holds.e2e.test.ts`, and `dmarc.e2e.test.ts` | Matter authorization, custodian mapping, notices, approvals, and hold release are outside this application |
| Per-plan and tenant retention | Implemented and tested | Bounded sweeps cover bodies, events, message rows, links, webhook logs, outbox history, exports, review data, blocklist checks, and DMARC reports; explicit tenant/plan windows affect reads and physical cleanup | Environment ceilings can clamp plan promises. Production values and scheduler success must be monitored |
| Audit retention | Implemented and tested | Old audit rows are copied to `audit_log_archive` with chain fields before removal from the hot table | Archive durability, external immutability, access, and final disposal are deployment decisions |
| DMARC retention | Implemented and tested | Child records and reports purge in bounded batches; tenant-wide legal holds preserve them | DMARC reports are domain evidence, not proof of regulatory compliance |
| Consent ledger and suppression | Implemented and tested | Append-only suppress/unsuppress events record action, reason, source, note, message, and timestamp; sending and workflow paths enforce current suppression | The sender must establish lawful basis, capture any required affirmative consent, publish notices, and control re-subscription |
| Tenant-safe deletion | Implemented and tested | Application tenant scoping plus fail-closed PostgreSQL RLS and cross-tenant E2E tests constrain export, erasure, legal-hold, and export-artifact access | Production must use the non-bypass database role and pass the startup RLS posture check |
| Data residency | External gap | No application-level region assignment or region-pinned routing is implemented | Deploy region-scoped API/workers, PostgreSQL, Redis, object storage, ClickHouse, logs, and backups, then prevent cross-region failover |
| Backup erasure | Partial | Online authoritative stores are addressed. Backup images are still not selectively rewritten, but restore-time re-deletion is implemented: `replayPrivacyTombstones()` re-purges resurrected rows, re-pseudonymizes recovered identifiers, and re-queues object/analytics/queue deletions; `POST /admin/privacy/replay-tombstones`, `privacy-restore-replay.e2e.test.ts` | Define backup expiry and cryptographic erasure where applicable, and legal-hold interaction with the backup provider. A restored node must not serve traffic before replay runs — [restore re-deletion runbook](runbooks/RESTORE_RE_DELETION.md) |

## Security controls relevant to regulated deployments

| Area | Status | What exists | Boundary or remaining work |
| --- | --- | --- | --- |
| Tenant and user access | Implemented and tested | RLS, scoped API keys, team capabilities, admin role hierarchy, TOTP, WebAuthn/passkeys, SSO enforcement, SCIM, session revocation, and JIT/break-glass audit | Configure production IdP/MFA policy, periodic access reviews, joiner/mover/leaver processes, and separation of duties |
| Audit controls | Implemented and tested | Append-only audit events, tenant hash chains, integrity verification, archive preservation, signed checkpoints, WORM-style export, and admin mutation records | Store checkpoints/exports in independently controlled immutable storage and document review/escalation procedures |
| Secret encryption | Partial | AES-256-GCM protects selected application secrets such as DKIM private keys and MFA seeds; the master key can come from AWS KMS, GCP KMS, Vault, or development environment configuration | This is not blanket encryption of message bodies, database files, object-store versions, logs, ClickHouse, or backups |
| API and service transport | Partial/deployment-dependent | Kubernetes ingress TLS, SMTP STARTTLS configuration, and optional service-mesh mTLS manifests exist | Certificates, cipher policy, internal TLS, HSTS boundary, and endpoint validation require a real deployment |
| Outbound SMTP transport | Partial | Haraka emits per-delivery `tls_required`/`tls_secured` evidence, which is now recorded per recipient domain (`recipient_domain_tls`). For a tenant with `tls_required`, the send worker refuses delivery to a domain previously observed accepting mail without TLS (`tls_required_domain_unsafe`), and the domain recovers automatically once it delivers over TLS; `transport-security*.e2e.test.ts` | The FIRST delivery to an unseen domain still cannot be protected — the evidence only exists after the hop. Enforcement is hop-by-hop, not end-to-end, so this is not message-level encryption. PHI stays prohibited; see [transport policy](TRANSPORT_SECURITY.md) |
| Availability and contingency | Partial/deployment-dependent | HA/DR manifests and backup, restore, PITR, Redis failover, and operational drill scripts exist | Run them in the target environment, record RPO/RTO, validate all regulated stores, and establish emergency-mode procedures |
| Malware and abuse controls | Partial/deployment-dependent | Attachment signature checks, optional ClamAV, rate limiting, reputation guard, abuse queue, KYC, suspension, and suppression automation | ClamAV and production alerting must be deployed and monitored; these controls do not replace content governance or incident response |
| Logging privacy | Implemented in code; deployment-dependent | Sensitive log/trace redaction and bounded operational retention exist | Verify every production sink, support workflow, crash dump, APM vendor, and alert payload |

## HIPAA assessment

**Result: partial technical foundation; HIPAA compliance is not established.**

The following application controls can support a HIPAA Security Rule program:

- unique/scoped access, tenant isolation, MFA/SSO/SCIM, session controls, and
  audited privilege changes;
- audit records with tamper-evident integrity and export;
- retention, legal holds, data access, erasure orchestration, and retry state;
- encryption for selected secrets and deployment options for transport and
  infrastructure encryption;
- backup/restore and high-availability tooling that can generate contingency
  evidence when exercised in the production environment.

The following required or material items are not proven by this repository:

1. A documented HIPAA applicability determination and complete ePHI inventory
   and data-flow map.
2. An organization-wide risk analysis, risk-management plan, assigned security
   responsibility, periodic evaluation, and documented remediation evidence.
3. Administrative safeguards: approved policies, workforce authorization and
   supervision, training, sanctions, access reviews, and termination process.
4. Physical safeguards for facilities, workstations, media, and hosting
   providers.
5. A production control assessment covering every database, object store,
   analytics store, queue, log, backup, endpoint, key, and recovery path.
6. Incident response, breach risk assessment, notification procedures, contact
   ownership, tabletop exercises, and retained notification evidence.
7. A tested contingency plan with data backup, disaster recovery, emergency
   mode operation, and measured restoration of all ePHI stores.
8. Business Associate Agreements and required downstream/subcontractor terms.
   The repository does not include a BAA and does not claim one is available.
9. A documented minimum-necessary policy and a decision on whether ordinary
   email is appropriate for each ePHI use case. TLS to a recipient MX protects
   one transport hop; it is not message-level end-to-end encryption.

HHS states that the Security Rule requires administrative, physical, and
technical safeguards, and that risk analysis is foundational. HHS also states
that covered entities and business associates generally need written business
associate arrangements where applicable, and that email containing ePHI must
be assessed and adequately protected. See the official HHS resources:

- [The Security Rule](https://www.hhs.gov/hipaa/for-professionals/security/index.html)
- [Guidance on Risk Analysis](https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html)
- [Business Associate Contracts](https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html)
- [Sending ePHI by email](https://www.hhs.gov/hipaa/for-professionals/faq/2006/does-the-security-rule-allow-for-sending-electronic-phi-in-an-email/index.html)
- [Breach Notification Rule](https://www.hhs.gov/hipaa/for-professionals/breach-notification/index.html)

## Other framework boundaries

- **GDPR/CCPA:** Access, portability, erasure, consent-history, retention, and
  tenant-isolation tooling is implemented. That does not establish controller/
  processor roles, lawful basis, notices, identity verification, response
  deadlines, exceptions, DPAs, subprocessor terms, transfer mechanisms, or
  regional compliance.
- **CAN-SPAM and bulk-sender rules:** Physical-address enforcement,
  unsubscribe, and suppression controls are implemented. The sender remains
  responsible for classification, headers, content, honoring requests, and
  all jurisdiction-specific requirements.
- **PCI DSS:** Checkout is a provider-hosted redirect for every provider, so no
  component stores, processes, or transmits cardholder data; the flow, the
  evidence queries, and the responsibility split are documented in
  [Payment data flow and PCI DSS scope](PAYMENT_DATA_FLOW.md). Accidental card
  data is detected and contained at the send, SMTP, support, and billing-webhook
  ingresses (see [the card-data runbook](runbooks/CARD_DATA.md)). This repository
  still has no PCI DSS assessment or attestation, and cardholder data remains
  prohibited in email content, metadata, support tickets, and webhook fields.
- **SOC 2 / ISO 27001:** The repository contains useful security controls and
  evidence mechanisms, but there is no audit report, certified ISMS, control
  ownership matrix, or operating-effectiveness period here.
- **FERPA, SEC 17a-4, FINRA, and state rules:** Technical isolation, retention,
  holds, and audit exports may support a program. Counsel and the operator must
  define record scope, required retention/immutability, supervision, contracts,
  and deployment evidence before making a compliance claim.

## Production acceptance checklist

Before processing regulated data:

1. Classify the data and map every primary, replica, queue, log, object,
   analytics, export, and backup path.
2. Complete the applicable legal/risk assessment and sign required customer,
   vendor, subprocessor, and BAA/DPA terms.
3. Configure production encryption, KMS/HSM custody, tenant database role,
   IdP/MFA, retention, legal holds, alerts, and regional topology.
4. Exercise erasure with object storage and analytics enabled; verify pending
   items reach `completed` and that restore procedures reapply tombstones.
5. Run restore, failover, incident, access-review, and breach/tabletop drills;
   retain approvals, timestamps, RPO/RTO, and remediation evidence.
6. Obtain independent security and framework-specific review before advertising
   compliance or accepting regulated production workloads.
