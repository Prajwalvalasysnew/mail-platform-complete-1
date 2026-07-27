# Framework assessment evidence index

Attach artifacts by immutable URI and SHA-256 through
`POST /v1/compliance/workload-evidence`. A different administrator approves
each artifact. The following items must be real, current evidence:

## HIPAA

- applicability memorandum and data-flow inventory;
- executed customer BAA and downstream subprocessor BAAs;
- organization-specific risk analysis and risk-treatment approval;
- secure portal, encryption/KMS, access-control, incident and restore results;
- HIPAA Privacy/Security Rule assessment and remediation retest.

## FERPA

- school-official/direct-control legal terms and education data flow;
- access, amendment, hearing and disclosure-accounting test evidence;
- redisclosure controls and incident exercise;
- FERPA specialist assessment and remediation retest.

## SEC/FINRA

- communication record-class mapping and supervisory policy;
- archive-provider contract/certification, retention configuration and legal
  hold/export validation;
- capture-failure, duplicate, reconciliation and restore drills;
- SEC 17a-4/FINRA specialist assessment and remediation retest.

## Platform-wide

- production IAM export, MFA policy and quarterly access-review decisions;
- external penetration-test final report;
- production architecture, threat model and current subprocessors;
- database/Redis failover and PITR evidence with measured RPO/RTO;
- signed audit-chain verification and independent Object-Lock retention proof;
- vulnerability/SBOM/container scan results for the exact release SHA.

An empty row, checklist tick, internal assertion, test fixture, or this
document itself is not activation evidence.
