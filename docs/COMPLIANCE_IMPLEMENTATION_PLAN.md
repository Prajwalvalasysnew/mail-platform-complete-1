# Compliance implementation plan

Reviewed: 2026-07-22 · P0 status updated: 2026-07-25

## P0 delivery status

Repository-implementable P0 items only. "Done" means the control exists **and**
has automated coverage; it does not mean the control is deployed, operating
effectively, or sufficient for any framework — see §16 release gates.

| ID | Status | Where |
| --- | --- | --- |
| BASE-01 | Done (doc) | [Data inventory and flow map](DATA_INVENTORY.md) |
| BASE-02 / BASE-03 | Done | `privacy-export.e2e`, `privacy-pseudonymization.e2e`, migration 075 |
| BASE-04 | Done | `account-data-subject.e2e` |
| BASE-05 | Done | `privacy-cases.e2e`, migration 076 |
| BASE-06 | Done (doc) | [Retention and disposal policy](RETENTION_AND_DISPOSAL.md) |
| BASE-08 | Done (policy: prohibit + partial enforcement) | [Sensitive-message transport policy](TRANSPORT_SECURITY.md) — `tls_required` is now fail-closed per recipient domain; PHI stays prohibited because first-delivery and end-to-end gaps remain |
| BASE-15 | Partial | [Data-use restrictions](DATA_USE_RESTRICTIONS.md) — card data enforced; PHI/FERPA/SEC contractual only; terms and UI notices outstanding |
| GDPR-01, CCPA-01 | Done | Satisfied by BASE-02…05 |
| GDPR-02, CCPA-02 (P1) | Done | Art 18 restriction (enforced in both send paths), Art 16 / right-to-correct rectification, Art 21 objection; `privacy-rights.ts`, migration 081, `privacy-rights.e2e.test.ts` |
| CANSPAM-01 | Done | Migration 077, `canspam-classification.e2e` |
| CANSPAM-02/03/04 | Done | `canspam-sender-identity.e2e`, `canspam-footer.test` |
| CANSPAM-05 | Done | Migration 078, `canspam-unsubscribe-monitor.e2e` |
| CANSPAM-06 | Done | `canspam-optout-friction.e2e` |
| PCI-01 | Done (doc) | [Payment data flow and PCI DSS scope](PAYMENT_DATA_FLOW.md) |
| PCI-02 | Done | `card-data.ts`, `pci-card-data.e2e`, [card-data runbook](runbooks/CARD_DATA.md) |
| PCI-03 | Done | `billing-payload-allowlist.ts`, migration 079, retention sweep |
| Privacy regression test 6 | Done | `replayPrivacyTombstones()`, `privacy-restore-replay.e2e`, [restore runbook](runbooks/RESTORE_RE_DELETION.md) |

| BASE-11 | Procedure written; **exercise outstanding** | [Incident and breach runbook](runbooks/INCIDENT_AND_BREACH.md) — severity model, breach clock, platform playbooks. Contacts, templates, and the first tabletop are organizational |
| BASE-12 | Partial | `scripts/backup-restore-drill.sh` now also verifies erasures survived the restore (no resurrected messages, pseudonymization intact, suppressions preserved). Measured RPO/RTO against production-sized data remains outstanding |
| BASE-13 | Template only | [Vendor register](VENDOR_REGISTER.md) — structure and codebase integration points; the register itself is a deployment fact and is unfilled |

**Still open (P0):** BASE-07, BASE-09, BASE-10, BASE-14, plus the outstanding
halves of BASE-11, BASE-12, BASE-13 and BASE-15. These need production
configuration, organizational process, and operating evidence that source code
cannot supply — key-management validation, IAM operation, logging operations,
and secure-development evidence.

This document is the implementation roadmap for preparing the mail platform
for production use under HIPAA, GDPR, CCPA as amended by CPRA, CAN-SPAM, PCI
DSS, SOC 2, ISO/IEC 27001, FERPA, SEC Rule 17a-4, and FINRA requirements. It
translates the gaps in [Compliance posture and evidence](COMPLIANCE_POSTURE.md)
into engineering, security, legal, and operational work.

It is an engineering plan, not legal advice, certification, or an assertion
that every framework applies. Applicability, contractual language, regulatory
interpretation, and final production acceptance must be approved by qualified
legal, security, privacy, and audit professionals.

## 1. Outcome and scope decisions

The codebase has useful security and privacy controls, but no listed framework
is currently complete end to end. The production strategy should make an
explicit choice for every regulated workload instead of treating compliance as
one universal launch gate.

| Workload | Current decision | Condition to change the decision |
| --- | --- | --- |
| Ordinary transactional and commercial email | Conditional launch | Close the privacy P0 items, validate production security controls, and operationalize CAN-SPAM |
| EU/UK personal data | Do not claim GDPR readiness yet | Complete data-subject rights, contracts, transfer assessment, records of processing, and breach operations |
| California personal information | Do not claim CCPA/CPRA readiness yet | Complete consumer rights, GPC/sale-share controls where applicable, notices, contracts, and privacy P0 items |
| Protected health information | Prohibited | Complete the HIPAA workstream, sign applicable BAAs, and approve every ePHI data flow |
| Cardholder or sensitive authentication data | Prohibited | Keep the platform demonstrably out of the CDE or complete a PCI DSS assessment for the resulting scope |
| Student education records | Prohibited | Complete FERPA contracts, disclosure/access/amendment workflows, and education-data controls |
| Broker-dealer regulated communications | Prohibited as system of record | Implement or integrate a qualifying archive and complete SEC/FINRA supervision and evidence requirements |
| SOC 2 or ISO certification claims | Prohibited | Complete the management system, operate controls for the required period, and obtain the independent report/certificate |

## 2. Status, priority, and ownership model

### Status definitions

- **Not started:** no approved design or owner.
- **Designed:** scope, owner, acceptance criteria, and dependencies approved.
- **Implemented:** technical or procedural control exists.
- **Validated:** tests or operational exercise passed in the target environment.
- **Auditable:** dated evidence, reviewer approval, exceptions, and remediation
  are retained.

### Priority definitions

- **P0:** required before any public production launch.
- **P1:** required before accepting data governed by the named framework or
  making a readiness claim.
- **P2:** required before an audit, attestation, certification, or mature-scale
  operation.

### Accountable roles

Assign named people to these roles before execution:

| Role | Accountability |
| --- | --- |
| Executive sponsor | Risk acceptance, budget, launch and regulated-workload approval |
| Security owner | Security program, risk register, control design, incident response |
| Privacy owner or DPO | Data inventory, rights requests, privacy notices, DPIAs, privacy incidents |
| Compliance owner | Framework mapping, evidence register, audit coordination, exceptions |
| Engineering owner | Application controls, migrations, tests, remediation delivery |
| Platform/SRE owner | Cloud, network, encryption, backups, logging, monitoring, DR evidence |
| Legal owner | Applicability, contracts, notices, retention, holds, regulator obligations |
| People/HR owner | Screening, training, sanctions, joiner/mover/leaver controls |
| Vendor owner | Due diligence, agreements, assurance reports, annual monitoring |

No control is complete merely because code was merged. Each control needs an
owner, operating procedure, evidence source, review frequency, and exception
path.

### Current repository baseline

This is the verified starting point for the roadmap. “Exists” means a useful
control is present in the repository; it does not mean the control is deployed,
operating effectively, or sufficient for the named framework.

| Framework | Existing repository foundation | Current decisive gap |
| --- | --- | --- |
| HIPAA | Tenant isolation, RBAC, MFA/SSO/SCIM, audit integrity, retention, legal holds, selected-secret encryption, HA/DR tooling | No BAA program, ePHI inventory/risk analysis, complete ePHI access audit, guaranteed secure delivery, Privacy Rule operations, or production safeguard evidence |
| GDPR | Recipient message/event export and deletion, object/queue/analytics cleanup, retention, holds, suppression/consent history | Export and erasure omit recipient-linked records; no complete rights case management, RoPA, DPA/transfer/DPIA program, or operating breach evidence |
| CCPA/CPRA | Recipient export/deletion foundation, suppression, tenant isolation, retention | Same residual-PI defect plus missing correction, GPC/sale-share, sensitive-PI, ADMT, risk-assessment, cybersecurity-audit, notice and request-operation controls |
| CAN-SPAM | Address enforcement, unsubscribe footer/headers, one-click/group suppression and send-time enforcement | No authoritative message classification, content/header governance, 30-day synthetic availability evidence, or complete sender/partner oversight |
| PCI DSS | Provider-hosted payment integrations, signed/idempotent webhooks, no intended PAN/CVV model | No proven CDE scope, accidental-card-data prevention, provider responsibility/AOC register, or PCI validation |
| SOC 2 | Access, audit, CI/security scanning, monitoring, backup and recovery control mechanisms | No scoped control matrix, complete operating evidence period, management assertion, readiness review, or CPA report |
| ISO 27001 | Technical controls that can support an ISMS | No approved ISMS scope, risk treatment/SoA, internal audit, management review, corrective-action system, or certificate |
| FERPA | Tenant isolation, export, retention and legal-hold mechanisms | No education contract/direct-control model, disclosure ledger, complete access/amendment process, or state student-privacy program |
| SEC 17a-4 | Tamper-evident application audit chains and WORM-style audit export | Audit export is not a complete regulated-communication archive; retention, original recreation, retrieval, undertakings and validation are missing |
| FINRA | General audit/support/review foundations | No SEC-compliant archive, WSP-configured supervisory workflow, registered-principal review evidence, complaint supervision, or all-channel reconciliation |

## 3. Shared P0 production foundation

These controls reduce duplicated work across every framework and should be
completed before framework-specific implementation.

| ID | Control and implementation work | Acceptance criteria and evidence |
| --- | --- | --- |
| BASE-01 | Build an authoritative data inventory and flow map covering API, SMTP, PostgreSQL, Redis/BullMQ, ClickHouse, body/object storage, webhook payloads, exports, logs, APM, support tools, payment providers, backups, replicas, local files, and subprocessors | Every data class has owner, purpose, source, destination, region, retention, encryption, legal basis, deletion behavior, and recovery behavior; architecture and inventory are reviewed quarterly |
| BASE-02 | Fix recipient export completeness | Export includes messages, bodies where applicable, events, links, suppression state, consent history, unsubscribe-group membership, workflow data, support/other recipient-linked data, and retained erasure evidence; exclusions are documented and tested |
| BASE-03 | Fix recipient erasure completeness | Direct identifiers are removed from `consent_events`, `deletion_requests`, and `unsubscribe_group_members`, or replaced with a keyed, documented, retention-bounded proof value; no erasure operation creates new unnecessary identifying data |
| BASE-04 | Add customer/account data-subject workflows | Authenticated users can access, correct, export, restrict, and delete account/profile data independently of recipient-email erasure; billing, fraud, tax, legal-hold, and security exceptions are explicit |
| BASE-05 | Add a privacy case-management state machine | Intake source, identity verification, jurisdiction, request types, deadline, extension, exception, approval, fulfillment artifacts, communications, and closure evidence are tracked without placing unnecessary PI in logs |
| BASE-06 | Define retention and disposal policy | Every store and record type has approved minimum/maximum retention, legal-hold override, deletion job, monitoring, backup treatment, and restore-time re-deletion procedure |
| BASE-07 | Validate encryption and key management in production | TLS is validated externally and internally; database, object, analytics, queue, log, export, and backup encryption are evidenced; keys have owners, separation, rotation, revocation, recovery, and access logs |
| BASE-08 | Decide sensitive-message transport policy | For PHI or equivalent data, either enforce secure downstream transport with fail/defer behavior and documented recipient exceptions, add message-level encryption/secure portal delivery, or prohibit the content class |
| BASE-09 | Operationalize identity and access management | SSO/MFA policy, least privilege, privileged access, service accounts, quarterly access reviews, emergency access, and joiner/mover/leaver evidence are implemented in production |
| BASE-10 | Operationalize audit and logging | Security and privacy events are complete, clocks synchronized, access protected, logs redacted, alerting tested, reviews documented, and signed checkpoints copied to independently controlled immutable storage |
| BASE-11 | Establish incident and breach management | Severity model, 24/7 contacts, containment, forensics, legal/privacy assessment, notification decision, regulator/customer templates, evidence preservation, tabletop schedule, and post-incident review are approved and exercised |
| BASE-12 | Validate resilience | Backups, PITR, restore, Redis recovery, ClickHouse recovery, object recovery, regional failure, key loss, and emergency-mode exercises meet approved RPO/RTO; restored erasures and suppressions remain enforced |
| BASE-13 | Establish vendor governance | Inventory vendors/subprocessors, classify risk, collect assurance reports, review contracts and breach terms, track subprocessors and regions, review annually, and document termination/data-return procedures |
| BASE-14 | Establish secure development evidence | Threat modeling, review approvals, dependency/container/IaC/secret scanning, penetration testing, remediation SLAs, change segregation, release approvals, and emergency-change review are retained |
| BASE-15 | Publish data-use restrictions and enforce them | Terms and UI prohibit PHI, card data, education records, and broker-dealer records until approved; add content detection/quarantine and support escalation for accidental receipt |

### Mandatory privacy regression tests

The privacy fixes are accepted only when automated tests prove all of the
following for Free, paid, and Enterprise tenants:

1. Export returns every recipient-linked record class and nothing belonging to
   another tenant.
2. Erasure clears direct identifiers from all authoritative stores and group
   memberships.
3. Retained opt-out evidence is pseudonymous, purpose-limited, and expires
   according to policy.
4. Legal holds block only the applicable scope and produce an auditable reason.
5. Object storage, ClickHouse, queued jobs, active/retried jobs, webhooks, and
   workflow state cannot recreate erased data.
6. A backup restore followed by tombstone replay does not resurrect usable
   erased data.
7. Partial failures remain pending, alert, retry, and eventually complete or
   enter a documented manual-remediation queue.
8. Exports expire and become inaccessible after their retention window.

## 4. HIPAA roadmap

### Target scope

Treat the platform as a potential business associate only after Legal confirms
the role and the organization is prepared to sign and operate under BAAs. Until
then, PHI must remain prohibited by contract and technical controls.

### Existing foundation

- Tenant isolation, scoped credentials, RBAC, MFA, SSO/SCIM, session controls.
- Tamper-evident audit records and export mechanisms.
- Retention, legal holds, erasure orchestration, and retry records.
- Selected-secret encryption and deployment options for TLS/KMS.
- Backup, recovery, and HA tooling that can generate evidence when exercised.

### Required work

| ID | Priority | Work item | Completion evidence |
| --- | --- | --- | --- |
| HIPAA-01 | P1 | Determine covered-entity/business-associate role and approved ePHI use cases | Signed applicability memorandum and approved service/data-flow scope |
| HIPAA-02 | P1 | Create a complete ePHI inventory and identify creation, receipt, storage, transmission, support, logging, backup, and deletion paths | Reviewed ePHI flow diagram linked to BASE-01 |
| HIPAA-03 | P1 | Perform an organization-wide Security Rule risk analysis and remediation plan | Dated risk analysis, methodology, risk owners, treatment dates, residual-risk approvals |
| HIPAA-04 | P1 | Assign security responsibility and approve administrative safeguard policies | Named security official; access, workforce, sanctions, incident, contingency, evaluation, and vendor policies |
| HIPAA-05 | P1 | Implement workforce training, authorization, supervision, termination, and sanctions | Training completion, acknowledgements, access review, termination samples, sanction process evidence |
| HIPAA-06 | P1 | Assess physical safeguards inherited from offices and hosting providers | Facility/workstation/media controls and relevant cloud assurance reports |
| HIPAA-07 | P1 | Enforce unique identity, emergency access, automatic session controls, minimum necessary access, and complete ePHI read/write auditing | Role matrix, access tests, emergency exercise, immutable access-log samples and review evidence |
| HIPAA-08 | P1 | Protect ePHI at rest and in transit across every store and delivery path | Encryption configuration, key records, transport tests, insecure-delivery rejection or approved secure-message alternative |
| HIPAA-09 | P1 | Establish integrity controls for ePHI and critical configurations | Hash/integrity design, unauthorized-change alerts, restoration verification |
| HIPAA-10 | P1 | Execute BAAs with customers and applicable subcontractors | Approved BAA template, signed agreements, subprocessor flow-down register |
| HIPAA-11 | P1 | Implement HIPAA incident and breach risk-assessment workflow | Procedure, notification matrix, tabletop evidence, retained breach decision records |
| HIPAA-12 | P1 | Test contingency operations for all ePHI stores | Backup, disaster recovery and emergency-mode test with measured RPO/RTO |
| HIPAA-13 | P2 | Conduct periodic technical/nontechnical evaluation and independent review | Annual review report, remediation evidence, executive acceptance |
| HIPAA-14 | P1 | Implement applicable Privacy Rule operations: permitted uses/disclosures, minimum necessary, access, amendment, restrictions, confidential communications and accounting of disclosures | Approved role matrix, rights procedures, request samples, disclosure records and contract allocation |
| HIPAA-15 | P1 | Track HHS rulemaking and assess every final-rule change before its compliance date | Regulatory-change register, gap assessment, approved remediation plan |

### HIPAA exit criteria

- No open critical/high risks affecting ePHI without documented acceptance.
- BAAs and subcontractor assurances are signed before any PHI is processed.
- Every ePHI store and transmission path has validated confidentiality,
  integrity, availability, audit, retention, and recovery controls.
- Access and contingency reviews have operating evidence, not only policies.
- Applicable Privacy Rule rights and disclosure-accounting duties are allocated
  between the customer and platform and can be completed from retained records.
- Legal, Security, Privacy, SRE, and the executive sponsor sign the PHI launch
  decision.

As of this review, HHS states that the existing Security Rule remains in effect
and the 2025 cybersecurity update remains a proposed rule. The design should
anticipate stronger requirements, but the control matrix must distinguish
current law from proposed changes.

## 5. GDPR roadmap

### Target scope

Map whether the platform is controller, processor, or both for each data set.
Customers normally control recipient/campaign data, while the platform may be
controller for account, security, billing, fraud, and marketing data.

### Required work

| ID | Priority | Work item | Completion evidence |
| --- | --- | --- | --- |
| GDPR-01 | P0 | Complete recipient and account access/export and erasure using BASE-02 through BASE-05 | Cross-store tests, sample completed cases, documented exceptions |
| GDPR-02 | P1 | Implement rectification, restriction, objection, and portability workflows | API/admin workflows, status tracking, downstream propagation tests |
| GDPR-03 | P1 | Document controller/processor roles, purposes, lawful bases, categories, recipients, regions, and retention | Article 30-style record of processing reviewed by Privacy/Legal |
| GDPR-04 | P1 | Publish layered privacy notices and cookie/tracking disclosures | Approved notices mapped to actual telemetry and email tracking behavior |
| GDPR-05 | P1 | Establish consent standards where consent is used | Affirmative capture, provenance, policy version, withdrawal, proof export, no dark patterns |
| GDPR-06 | P1 | Implement privacy by design/default and DPIA workflow | Design checklist; DPIAs for high-risk tracking, profiling, sensitive data, or large-scale processing |
| GDPR-07 | P1 | Execute Article 28-compatible DPAs and maintain subprocessor governance | DPA, security schedule, deletion/return terms, subprocessor list/change process |
| GDPR-08 | P1 | Approve international transfer mechanism and assessment | SCC/adequacy basis, transfer-impact assessment, supplementary controls |
| GDPR-09 | P1 | Operationalize personal-data breach assessment and 72-hour decision path | Tabletop, regulator/customer contact matrix, decision log template |
| GDPR-10 | P1 | Decide DPO and representative requirements | Documented applicability decisions and appointments where required |
| GDPR-11 | P1 | Implement data-residency architecture where contractually required | Region assignment, pinned storage/processing/logging/backups, failover tests |
| GDPR-12 | P2 | Establish annual privacy-control testing and metrics | Request timeliness, deletion failure, consent, breach, vendor and training reports |
| GDPR-13 | P1 | Validate Article 32 security of processing and processor assistance for rights, security, breach, DPIA and regulator inquiries | Technical/organizational measure schedule, customer-assistance procedure, exercise evidence |
| GDPR-14 | P1 | Assess children’s data, special-category data, profiling and solely automated decisions and prohibit or add required safeguards | Applicability decisions, age/consent or Article 9 basis controls, human-review workflow where applicable |

### GDPR exit criteria

- Data-subject requests are authenticated, completed across all stores, and
  evidenced without undue delay and normally within one month, subject to
  documented lawful extension or exception.
- Every processing purpose has an approved lawful basis and retention rule.
- DPAs, subprocessors, transfers, notices, DPIAs, and breach operations match
  the actual production deployment.
- Privacy owner and Legal approve EU/EEA production processing.

## 6. CCPA/CPRA roadmap

### Target scope

First document whether statutory thresholds and exemptions apply. Regardless of
formal applicability, use the consumer-rights controls as the California
privacy baseline.

The CPPA’s cybersecurity-audit, risk-assessment, and automated-decisionmaking
regulations took effect on January 1, 2026. Applicability and phased deadlines
must therefore be assessed during initial scoping, not deferred until a later
audit project.

### Required work

| ID | Priority | Work item | Completion evidence |
| --- | --- | --- | --- |
| CCPA-01 | P0 | Complete access, deletion, and account/recipient identity coverage | BASE-02 through BASE-05 tests and case samples |
| CCPA-02 | P1 | Implement right-to-correct workflow | Verified request, propagation, exception and closure evidence |
| CCPA-03 | P1 | Inventory sale, sharing, cross-context behavioral advertising, and sensitive PI uses | Approved applicability/data-flow matrix |
| CCPA-04 | P1 | Implement opt-out of sale/sharing and honor Global Privacy Control where applicable | Browser/API tests, downstream propagation, preference evidence |
| CCPA-05 | P1 | Implement limit-use/disclosure handling for sensitive PI where applicable | Preference controls and service/provider enforcement |
| CCPA-06 | P1 | Publish notice at collection and privacy policy disclosures | Category/source/purpose/retention/rights disclosures reviewed against inventory |
| CCPA-07 | P1 | Implement request channels, verification, authorized-agent handling, deadlines, and appeals/complaint escalation | Procedure, metrics, sampled cases and staff training |
| CCPA-08 | P1 | Enforce non-discrimination in plans, service, pricing, and support | Product review and approved financial-incentive terms if used |
| CCPA-09 | P1 | Execute service-provider/contractor terms and downstream restrictions | Contract register and annual monitoring |
| CCPA-10 | P1 | Identify processing presenting significant privacy risk, perform required risk assessments before processing, reassess on material change, and prepare required CPPA submissions | Assessment register, executive attestation, January 1, 2026 coverage and submission calendar, including the April 1, 2028 initial submission deadline for 2026-2027 assessments where applicable |
| CCPA-11 | P1 | Determine annual cybersecurity-audit applicability and phased first-audit deadline; appoint a qualified independent auditor and operate the required audit/certification process | Applicability calculation, audit plan/report, gap remediation and CPPA certification calendar |
| CCPA-12 | P1 | Implement applicable consumer notice, access and opt-out rights for significant ADMT decisions | ADMT inventory, pre-use notice, access explanation, opt-out/human-review path and E2E evidence |
| CCPA-13 | P1 | Assess children/minor opt-in requirements and implement age-appropriate controls where applicable | Applicability decision, consent/authorization evidence and downstream enforcement |
| CCPA-14 | P1 | Determine data-broker status and DROP obligations; register and integrate deletion/opt-out processing if applicable | Legal decision, registration record and DROP request evidence |

### CCPA/CPRA exit criteria

- California requests and preference signals work across all relevant data and
  downstream recipients.
- Applicable risk assessments, cybersecurity audits, ADMT rights, submissions
  and certifications meet the effective 2026 regulations and phased deadlines.
- Notices and contract classifications match actual sale/share/service-provider
  behavior.
- No unresolved privacy P0 issue remains.

## 7. CAN-SPAM roadmap

### Existing foundation

- Live sends require a configured physical postal address.
- HTML/text footers and `List-Unsubscribe` headers are generated.
- One-click and group-specific opt-outs feed enforced suppressions.
- Sending and workflow paths check suppressions before delivery.

### Required work

| ID | Priority | Work item | Completion evidence |
| --- | --- | --- | --- |
| CANSPAM-01 | P0 | Classify transactional, relationship, and commercial messages and restrict who can set the classification | API/schema policy, authorization tests, audit trail |
| CANSPAM-02 | P0 | Validate sender identity, routing information, reply paths, and subject governance | Anti-spoofing tests, verified-domain enforcement, abuse-review procedure |
| CANSPAM-03 | P0 | Require advertisement identification when legally required | Template/campaign checklist and policy tests |
| CANSPAM-04 | P0 | Keep physical-address and unsubscribe content tamper-resistant | Rendering tests across HTML/text/templates and localization |
| CANSPAM-05 | P0 | Prove unsubscribe works for at least the required post-send period and is honored within the legal deadline | Synthetic daily checks, immediate suppression timestamps, SLA alerts and monthly report |
| CANSPAM-06 | P0 | Prevent fees, login requirements, or unnecessary data collection during opt-out | Browser/API E2E tests |
| CANSPAM-07 | P1 | Govern agencies, affiliates, resellers, and customers sending on the platform | Contract obligations, monitoring, complaint escalation, suspension evidence |
| CANSPAM-08 | P1 | Monitor complaint, bounce, unsubscribe, abuse and deceptive-content indicators | Thresholds, dashboards, automated holds, reviewer evidence |
| CANSPAM-09 | P1 | Prevent sale or transfer of opted-out addresses except to a provider used to comply with the law | Data-export restrictions, contract terms and authorization tests |

### CAN-SPAM exit criteria

- All commercial paths include accurate sender information, address, and a
  functioning opt-out.
- Synthetic monitoring proves continuing availability and suppression SLA.
- Customer contracts and abuse operations cover senders acting on behalf of
  other parties.

## 8. PCI DSS roadmap

### Preferred scope decision

Keep payment-page collection at PCI-compliant providers and keep the mail
platform outside the cardholder data environment. Never treat email, support,
logs, metadata, templates, or generic webhook fields as approved card-data
channels.

### Required work

| ID | Priority | Work item | Completion evidence |
| --- | --- | --- | --- |
| PCI-01 | P0 | Document payment data flow and prove PAN/CVV does not enter platform systems | Data-flow diagram, provider integration review, storage/log queries |
| PCI-02 | P0 | Add card-data detection, redaction/quarantine, alerting, and deletion procedure for unintended channels | API/SMTP/support/webhook tests using safe synthetic values; incident runbook |
| PCI-03 | P0 | Ensure billing webhook retention excludes unnecessary provider payload fields | Field allowlist, migration/cleanup, tests and retention policy |
| PCI-04 | P1 | Define CDE scope, segmentation, connected systems, and responsibility matrix with each provider | Approved scope and responsibility documents |
| PCI-05 | P1 | Collect provider Attestations of Compliance and monitor status annually | Vendor records and review evidence |
| PCI-06 | P1 | Complete the applicable SAQ/ROC path and required scans/tests | Signed SAQ/AOC or assessor report; ASV/penetration results where applicable |
| PCI-07 | P1 | Operate PCI access, vulnerability, logging, incident, change and training controls for in-scope systems | Periodic evidence and remediation tracking |
| PCI-08 | P2 | Validate scope after every material billing or infrastructure change | Change-triggered scope review records |
| PCI-09 | P1 | For any embedded payment page, inventory, authorize and integrity-monitor payment-page scripts and detect unauthorized page changes under PCI DSS 4.0.1 | Script inventory, authorization records, change/tamper alerts and assessor-approved evidence; document non-applicability for a true hosted redirect |

### PCI DSS exit criteria

- QSA/qualified advisor confirms scope and validation method.
- Accidental card data is blocked or rapidly contained and deleted under an
  approved procedure.
- Required SAQ/ROC, AOC, scans, penetration tests and provider evidence are
  current.
- The assessment uses PCI DSS 4.0.1, the only active PCI DSS 4.x revision at
  this review, and includes requirements that became effective March 31, 2025.

## 9. SOC 2 roadmap

### Target scope

Start with Security and Availability. Add Confidentiality, Processing
Integrity, or Privacy only when customer commitments and control maturity
justify the expanded scope.

### Required work

| ID | Priority | Work item | Completion evidence |
| --- | --- | --- | --- |
| SOC2-01 | P1 | Define services, locations, infrastructure, people, data, vendors, boundaries, subservice organizations, and Trust Services Criteria scope | Approved scope and system boundary |
| SOC2-02 | P1 | Write the system description and principal service commitments | Auditor-reviewed draft consistent with contracts/architecture |
| SOC2-03 | P1 | Build a control matrix with owner, frequency, evidence, population, reviewer, exception process, and criterion mapping | Complete governance/risk/access/change/operations/vendor/incident/BCP matrix |
| SOC2-04 | P1 | Approve and communicate policies | Versioned approvals and workforce acknowledgements |
| SOC2-05 | P1 | Operate recurring controls | Access reviews, vulnerability remediation, changes, incidents, backups/restores, vendor reviews, risk reviews and training evidence |
| SOC2-06 | P1 | Implement evidence automation without exposing secrets or PI | Read-only collection, completeness checks, retention and reviewer approval |
| SOC2-07 | P1 | Perform readiness assessment and remediate exceptions | Readiness report and closed remediation plan |
| SOC2-08 | P2 | Complete Type I, then operate controls for Type II period | Independent CPA reports and management assertion |
| SOC2-09 | P1 | Document complementary user-entity controls, subservice-organization treatment, customer commitments and exception communications | System-description sections, contract mapping and customer control guide |

### SOC 2 exit criteria

- No public claim is made before the independent report exists.
- Control evidence covers the auditor-selected period with complete
  populations, review proof, and explained exceptions.
- The public statement distinguishes Type I from Type II and names the actual
  scope without implying product certification.

## 10. ISO/IEC 27001 roadmap

### Required work

| ID | Priority | Work item | Completion evidence |
| --- | --- | --- | --- |
| ISO-01 | P1 | Define ISMS scope, context, interested parties and interfaces/dependencies, including whether climate change is a relevant issue under Amendment 1:2024 | Approved scope and context register |
| ISO-02 | P1 | Establish leadership, information-security policy, roles, objectives and resources | Signed policy, role assignments and measurable objectives |
| ISO-03 | P1 | Define repeatable risk methodology and maintain asset/risk registers | Approved methodology, asset owners, risk assessments |
| ISO-04 | P1 | Create risk treatment plan and Statement of Applicability against Annex A | Approved SoA with inclusion/exclusion rationale and implementation state |
| ISO-05 | P1 | Operate competence, awareness, communication and document-control processes | Training, communications, controlled-document and record evidence |
| ISO-06 | P1 | Integrate supplier, incident, continuity, access, cryptography, change, secure-development and privacy controls into the ISMS | Control procedures and operating evidence |
| ISO-07 | P1 | Measure control effectiveness and security objectives | Metrics, evaluations and corrective actions |
| ISO-08 | P2 | Conduct internal audit and management review | Independent internal-audit report and management-review minutes |
| ISO-09 | P2 | Close nonconformities and complete certification stages 1 and 2 | Corrective-action evidence and accredited certificate |

### ISO 27001 exit criteria

- The ISMS has operated long enough to produce meaningful records.
- Internal audit and management review are complete before certification.
- Certification scope matches the advertised platform/service boundary.

## 11. FERPA roadmap

### Target scope

Do not accept education records until an education-specific service model and
contract are approved. FERPA obligations primarily attach to educational
agencies/institutions; the platform must support their obligations and operate
under the applicable disclosure exception and direct control.

### Required work

| ID | Priority | Work item | Completion evidence |
| --- | --- | --- | --- |
| FERPA-01 | P1 | Define education-record scope and school/platform roles | Legal applicability memo and data-flow inventory |
| FERPA-02 | P1 | Execute school-official/direct-control terms with use, redisclosure, security and destruction restrictions | Approved education DPA/addendum and customer agreements |
| FERPA-03 | P1 | Restrict processing to legitimate educational purposes and authorized school personnel | Purpose/role matrix, scoped access, audit tests |
| FERPA-04 | P1 | Maintain the required record of disclosures linked to each student where applicable | Disclosure ledger, export and retention tests |
| FERPA-05 | P1 | Support parent/eligible-student inspection and access within the required timeframe | Complete education-record export and sampled case evidence |
| FERPA-06 | P1 | Support amendment, decision and hearing workflow through the institution | Case workflow, disputed-record statement, audit evidence |
| FERPA-07 | P1 | Prevent destruction while an eligible access request is outstanding | Request/retention interlock and E2E tests |
| FERPA-08 | P1 | Control redisclosure, vendor access and post-contract return/destruction | Subprocessor terms, access logs, deletion certificate process |
| FERPA-09 | P1 | Map applicable state student-privacy laws and contractual requirements | State matrix and product/configuration decisions |
| FERPA-10 | P2 | Train support/operations and test education-record incidents | Training and tabletop records |
| FERPA-11 | P1 | Support annual-rights notice, directory-information/opt-out, consent and exception documentation as allocated to the institution | Contract allocation, configurable records and sample institution evidence |

### FERPA exit criteria

- School contracts, direct-control obligations and subprocessor restrictions
  are signed.
- Access, disclosure-record, amendment and no-destruction-during-request flows
  pass end-to-end tests.
- Legal approves each state/education market offered.

## 12. SEC Rule 17a-4 roadmap

### Target scope

The existing tamper-evident application audit log is not a qualifying archive
for all regulated communications. Decide whether to build a dedicated records
system or integrate a specialist archive. Integration is usually the lower-risk
route unless regulated recordkeeping is a core product capability.

### Required work

| ID | Priority | Work item | Completion evidence |
| --- | --- | --- | --- |
| SEC-01 | P1 | Obtain counsel determination of applicable broker-dealer record classes and retention periods | Record-classification and schedule memorandum |
| SEC-02 | P1 | Capture every in-scope inbound/outbound communication, attachment, envelope, timestamp, identity, disposition and modification event | Capture completeness and reconciliation tests across every channel |
| SEC-03 | P1 | Select and validate compliant WORM or audit-trail-alternative storage | Architecture and counsel/assessor review demonstrating original recreation |
| SEC-04 | P1 | Prevent ordinary plan retention/erasure from deleting regulated records | Compliance-copy separation, retention lock, legal-hold and erasure exception tests |
| SEC-05 | P1 | Implement indexing, search, serialization, human-readable export and prompt production | Regulator-production drill with completeness/timing evidence |
| SEC-06 | P1 | Implement verification, duplicate/cross-check controls, clock synchronization and corruption detection | Scheduled verification records and remediation alerts |
| SEC-07 | P1 | Establish required undertakings and access arrangements | Executed designated-third-party or executive-officer documents as applicable |
| SEC-08 | P1 | Document supervision, access, migration, vendor exit and regulator-request procedures | Approved procedures and tabletop evidence |
| SEC-09 | P2 | Obtain independent specialist validation before use as system of record | Written assessment and closed findings |

### SEC 17a-4 exit criteria

- Counsel and an experienced recordkeeping assessor approve architecture,
  retention, retrieval and undertaking arrangements.
- Reconciliation proves that every in-scope communication reaches the archive.
- A production drill recreates originals and produces records promptly without
  altering retention locks.

## 13. FINRA roadmap

### Target scope

FINRA readiness depends on SEC-compliant recordkeeping plus a member firm's
supervisory program. Platform features can support supervision but cannot
replace the firm's written supervisory procedures and principal decisions.

### Required work

| ID | Priority | Work item | Completion evidence |
| --- | --- | --- | --- |
| FINRA-01 | P1 | Complete SEC-01 through SEC-09 and map FINRA record periods, including at least six years where Rule 4511 specifies the default because no other period applies | Approved retention matrix and immutable-storage configuration |
| FINRA-02 | P1 | Support written supervisory procedures, assigned reviewers and review queues | Role/workflow design mapped to customer WSP |
| FINRA-03 | P1 | Support risk-based pre-use/post-use review of correspondence and internal communications | Sampling rules, principal approval, escalation and audit evidence |
| FINRA-04 | P1 | Identify, preserve, route and report customer complaints | Complaint classifier/queue, human review, status and export tests |
| FINRA-05 | P1 | Capture all approved communication channels and detect prohibited/off-channel use where feasible | Channel inventory, reconciliation, exception reports |
| FINRA-06 | P1 | Provide supervision, legal-hold, discovery and examination exports without cross-tenant leakage | Role-based E2E and regulator-production drill |
| FINRA-07 | P1 | Support annual supervisory review and control-change evidence | Reports, reviewer attestations and remediation tracking |
| FINRA-08 | P2 | Obtain broker-dealer counsel and specialist review | Written approval and customer shared-responsibility schedule |

### FINRA exit criteria

- SEC recordkeeping exit criteria are satisfied.
- A member firm can configure its WSP, reviewer roles, complaint handling and
  evidence without relying on undocumented manual workarounds.
- The product contract clearly allocates platform and member-firm duties.

## 14. Delivery sequence and dependencies

### Phase 0: claims and containment (week 0-2)

- Assign owners and approve the workload prohibition matrix.
- Remove unsupported compliance claims from sales/product material.
- Add terms, UI notices and support procedures prohibiting regulated data.
- Open tracked P0 issues for BASE-01 through BASE-15.

### Phase 1: privacy and production baseline (week 1-8)

- Complete data inventory and privacy erasure/export remediation.
- Add privacy case management and complete cross-store E2E coverage.
- Validate production encryption, IAM, logging, incident response and backups.
- Complete CAN-SPAM production monitoring and card-data containment.

Gate: ordinary email production launch review.

### Phase 2: governance and evidence (month 2-5)

- Implement policy, risk, vendor, training, access-review and change programs.
- Automate evidence collection and complete readiness assessments.
- Prepare GDPR/CCPA contracts, notices and transfer records.
- Build the ISO ISMS and SOC 2 control matrix from one shared control library.

Gate: privacy readiness and SOC 2 Type I/ISO stage 1 readiness.

### Phase 3: selected regulated workloads (month 4-9+)

- Complete HIPAA or FERPA only where a validated business need exists.
- Integrate a qualified records archive before pursuing SEC/FINRA customers.
- Complete PCI validation only for the final confirmed payment scope.

Gate: framework-specific executive, Legal, Security, Privacy and external-review
approval.

### Phase 4: operating effectiveness and independent assessment

- Run recurring controls for the required evidence period.
- Complete penetration, resilience, incident and production exercises.
- Resolve readiness findings.
- Undergo SOC 2 Type II, ISO certification, PCI validation, or specialist
  regulated-workload assessment as applicable.

## 15. Evidence register requirements

For every roadmap item, retain:

- control ID, requirement source, implementation owner and reviewer;
- design description and links to code/configuration/procedure;
- production population and evidence period;
- timestamped execution evidence and review approval;
- exceptions, severity, owner, due date and closure proof;
- dependencies and inherited controls from vendors;
- next review date and change triggers.

Do not store production secrets, message bodies, full recipient lists, health
information, student records, or card data in audit evidence systems. Redact or
tokenize evidence and grant auditors time-bounded least-privilege access.

## 16. Release gates

### Ordinary production gate

- BASE-01 through BASE-15 are implemented or formally reviewed. BASE-02,
  BASE-03, CAN-SPAM opt-out enforcement, critical tenant isolation,
  authentication/authorization, production secret protection, and tested
  incident/restore capability are hard blockers and cannot be accepted away for
  a public launch that processes the affected data.
- Any other exception has a documented scope, compensating control, owner,
  expiry date, remediation date, and approval from the executive sponsor,
  Legal, Security and Privacy.
- CAN-SPAM tests and synthetic unsubscribe monitoring pass.
- Privacy cross-store and restore tests pass.
- Production security, incident, backup and access-review evidence exists.

### Regulated-data gate

- The relevant framework exit criteria are satisfied.
- Contracts and subprocessors are approved.
- Independent review is complete where required or prudent.
- Monitoring, evidence collection and annual/periodic review are scheduled.
- The customer shared-responsibility model is incorporated into contracts and
  onboarding.

### Audit/certification claim gate

- Use only the exact scope, period, report type, certificate, and legal entity
  covered by the independent assessment.
- Never describe source code, a passing test suite, a vendor report, SOC 2
  readiness, or ISO stage 1 as certification of the platform or organization.

## 17. Official reference starting points

References and regulatory status were rechecked on 2026-07-22. Recheck them at
design approval and before every regulated-workload launch.

- HIPAA: [HHS Security Rule](https://www.hhs.gov/hipaa/for-professionals/security/index.html), [Risk Analysis Guidance](https://www.hhs.gov/hipaa/for-professionals/security/guidance/guidance-risk-analysis/index.html), and [Business Associate Contracts](https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html)
- GDPR: [European Commission data-subject requests](https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/dealing-individuals-requests_en) and [processor contracts](https://commission.europa.eu/law/law-topic/data-protection/rules-business-and-organisations/obligations/controllerprocessor/can-someone-else-process-data-my-organisations-behalf_en)
- CCPA/CPRA: [California Attorney General CCPA overview](https://oag.ca.gov/privacy/ccpa), [California Privacy Protection Agency FAQ](https://cppa.ca.gov/faq), and [effective 2026 cybersecurity-audit, risk-assessment, and ADMT regulations](https://cppa.ca.gov/regulations/ccpa_updates.html)
- CAN-SPAM: [FTC compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)
- PCI DSS: [PCI SSC v4.0.1 document library](https://www.pcisecuritystandards.org/document_library/) and [outsourced processing FAQ](https://www.pcisecuritystandards.org/faqs/does-pci-dss-apply-to-merchants-who-outsource-all-payment-processing-operations-and-never-store-process-or-transmit-cardholder-data/)
- SOC 2: [AICPA SOC resources](https://www.aicpa-cima.com/soc)
- ISO/IEC 27001: [ISO/IEC 27001:2022](https://www.iso.org/standard/27001?lang=2)
- FERPA: [U.S. Department of Education legal basics](https://studentprivacy.ed.gov/legal-basics) and [amending a record](https://studentprivacy.ed.gov/resources/amending-record)
- SEC Rule 17a-4: [SEC electronic recordkeeping amendments](https://www.sec.gov/rules-regulations/2022/10/electronic-recordkeeping-requirements-broker-dealers-security-based-swap-dealers-major-security) and [SEC recordkeeping FAQ updated January 6, 2026](https://www.sec.gov/rules-regulations/staff-guidance/trading-markets-frequently-asked-questions/rule-amendments-broker)
- FINRA: [Rule 4511](https://www.finra.org/rules-guidance/rulebooks/finra-rules/4511) and [supervision guidance](https://www.finra.org/rules-guidance/key-topics/supervision)
