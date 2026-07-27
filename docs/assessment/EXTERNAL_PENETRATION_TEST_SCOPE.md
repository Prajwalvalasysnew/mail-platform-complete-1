# External penetration-test scope

This document is the engagement scope to give an independent CREST, CHECK,
OSCP/OSWE-equivalent, or otherwise contractually accepted testing firm. An
internal automated scan is not a substitute for this assessment.

## In scope

- Public API, tracker, SMTP submission gateway, secure-message portal, admin
  console, authentication and recovery endpoints.
- Tenant isolation, forced PostgreSQL RLS, object identifiers, API key scopes,
  admin roles/elevation, OIDC MFA enforcement, session/CSRF handling.
- Template rendering, attachment parsing/malware boundary, regulated-content
  classifier bypasses, secure-message encryption/token handling.
- SSRF, request smuggling, injection, XSS, deserialization, file handling,
  rate-limit bypass, race conditions, queue/outbox replay and webhook signing.
- Specialist archive fail-closed behavior, audit checkpoint integrity and
  Object Lock retention, KMS/Vault failure behavior.
- Hetzner network/firewall/load-balancer configuration and Kubernetes
  namespace/network policy; database, Redis, object store, Vault and CI/CD
  control planes.

## Required authenticated roles

Free, Paid, Enterprise, Enterprise with each regulated mode pending/active/
suspended; customer owner/admin/member; support/operator/admin/superadmin;
expired and revoked sessions; test and live API keys.

## Rules and deliverables

Use a dedicated staging environment containing synthetic data only. No
denial-of-service, social engineering, persistence outside the test window, or
third-party provider testing without written authorization. Require:

- executive and technical reports;
- reproducible evidence, CVSS/CWE, affected build SHA and timestamps;
- confirmation that no customer data was retained;
- retest evidence for every critical/high finding;
- explicit conclusions for HIPAA Security Rule, FERPA safeguards, and
  SEC/FINRA archive boundary controls.

Activation evidence must reference the final retest report checksum, not the
initial report or an internal scan.
