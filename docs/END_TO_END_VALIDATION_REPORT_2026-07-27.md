# End-to-end validation report — 27 July 2026

## Outcome

All repository-controlled regulated-workload work is implemented and the final
clean aggregate passed. The real local development campaign used actual
development services and live API keys; it did not use the isolated test
database.

| Area | Result | Evidence |
| --- | --- | --- |
| Workspace build | Pass | Shared, API, worker, tracker, SMTP gateway and SDK |
| Full automated suite | Pass | 171/171 files; 1,195/1,195 tests (post-fix clean run, 955.07s) |
| Final immutable-audit focused campaign | Pass | 5/5 files; 37/37 tests |
| Production dependency audit | Pass | 0 production vulnerabilities |
| Production readiness template | Pass | OIDC context, remote KMS, WORM bucket/KMS and service topology |
| Fresh/current migrations | Pass | 95 files through `096_independent_audit_exports.sql` |
| Real Free/Paid/Enterprise campaign | Pass | Live keys, real dev DB/Redis/worker/Mailpit |
| Real regulated Enterprise campaign | Pass | HIPAA, FERPA and SEC/FINRA fail-closed paths |
| PostgreSQL restore drill | Pass | 109 tables, 94 applied migrations at drill time, 11.63s local RTO proxy |
| Redis failover drill | Pass | Marker and 3 queued jobs survived; promotee writable |
| Hetzner Terraform | Pass | Terraform 1.9 official container: `fmt`, hcloud provider initialization and `validate`; provider lock file retained |
| Final service readiness | Pass | PostgreSQL, Redis and queue healthy at `http://localhost:3003/ready` |
| Long unsubscribe-link regression | Pass | 10/10 focused tests; live tracker returns 200 for a real link, 400 for malformed 180-character input, and no longer returns router 414/database 500 |

## Environment

- Windows and Docker Desktop
- Host test runtime: Node.js 26
- Container and CI baseline: Node.js 22
- Development API: `http://localhost:3003`
- Development PostgreSQL/Redis/Mailpit: 5432/6379/8025
- Isolated test PostgreSQL/Redis/Mailpit: 5434/6380/8026

The runtime baseline was upgraded from Node 20 to Node 22 because the current
Haraka dependency graph declares Node 22+. Production-pruned images reported
zero vulnerabilities.

## Real persona campaign

Final post-fix run ID: `1785177196739-a0u0s`

| Persona | Customer ID | Result |
| --- | --- | --- |
| Free | `9a667c9a-6eb4-49bf-a038-f0943a47fe9c` | Pass |
| Paid | `fc1ce08d-69ad-4dc2-bdaa-d41e7ff9b85b` | Pass |
| Enterprise | `cd98e63f-98e4-42fe-a8c2-9b7951d29ec4` | Pass |

Coverage included registration, verification, sessions, scoped live keys,
profiles, verified domains, templates, suppressions/consent, privacy records,
support, idempotent sending, worker delivery, Mailpit capture and usage. Free
quota enforcement and Enterprise RBAC/SSO/SCIM/subaccount isolation/audit also
passed.

## Real regulated campaign

Final post-fix run ID: `1785177216108-ohzbv`

Enterprise customer: `580a6d69-5ab6-4c4f-b132-06fc89243996`

Credential type: live API key

- HIPAA: ordinary PHI send was blocked; encrypted portal creation/access
  round-tripped; encrypted four-factor breach assessment was recorded.
- FERPA: amendment/hearing outcome and disclosure accounting were recorded
  without returning plaintext sensitive statements.
- SEC/FINRA: with no real specialist archive configured, the outbound attempt
  failed closed with HTTP 503 and accepted zero messages.
- All temporarily activated synthetic development modes were automatically
  suspended after the run.

## Live compliance-evidence campaign

The fixed development superadmin exercised the real admin API against the
post-fix Enterprise persona. SOC2-06 collected and reviewed all eight expected
control records for June 2026. The collector correctly reported missing
operating evidence for `CANSPAM-05`, `BASE-06`, and `BASE-10` rather than
converting absence into a false pass; `CANSPAM-08`, `BASE-05`, `BASE-03`,
`PCI-02`, and `HIPAA-07` were complete. HIPAA-07 admin read audit `212` reached
the review queue and received an immutable `appropriate` decision. The GDPR-13
processing-record/measures path was also exercised by the live persona.

Production activation was not attempted. Development evidence used
`.invalid` synthetic artifact locations and one-hour expiry and is explicitly
not valid for production.

## Regulated controls validated

- Enterprise-only, per-mode request/review/activation/suspension state machine.
- HTTPS/SHA-256 prerequisite artifacts, different submitter/reviewer,
  expiry-aware recomputation, and no trusted request booleans.
- Value-free PAN/PHI/education/broker-dealer classification on single and batch
  send after template rendering.
- PAN prohibited everywhere; PHI/FERPA ordinary delivery redirected to the
  encrypted portal.
- Two separately delivered portal credentials, hashed tokens, expiry,
  revocation, no-store responses and value-free audit.
- HIPAA access/amendment/restriction/confidential communication/disclosure/
  breach case states and encrypted breach analysis.
- FERPA access/amendment/hearing/disclosure states, redisclosure restriction
  and encrypted disputed-record statement.
- SEC/FINRA archive-before-accept, idempotent external receipt and value-free
  reconciliation index.
- Production OIDC authentication-context enforcement, admin access-review
  queue, remote AWS KMS/Vault key preload and plaintext-key refusal.
- Full audit records plus signed heads exported to an independently
  administered, KMS-encrypted S3 Object-Lock COMPLIANCE bucket.
- Recipient unsubscribe URLs accept bounded long Message-ID parameters;
  canonical decoding rejects malformed values before database access.

## Resilience evidence

The local PostgreSQL dump/restore drill restored 109 public tables and matched
all applied migrations and sampled row counts. It found zero resurrected
erased messages and zero unsafely restored pseudonymized identifiers. The
11.63-second result is a local RTO proxy, not a production SLA.

The isolated Redis primary/replica drill confirmed replication, killed the
primary, promoted the replica, retained all three queued jobs and accepted a
post-failover write.

The three-node Hetzner network/firewall/load-balancer Terraform validates. A
real Hetzner apply, CloudNativePG automatic promotion and object-store PITR
still require the target account, credentials and production-sized data.

At final handoff, the development database had all 95 migrations applied
through `096_independent_audit_exports.sql`; every temporary HIPAA, FERPA, and
SEC/FINRA posture created by live campaigns was `suspended`. API and tracker
readiness were green, and unauthenticated worker metrics correctly returned
401.

## Completion audit

| Requested capability | Repository-controlled result | Authoritative evidence |
| --- | --- | --- |
| Policy and individual activation gates | Complete | migrations 090/094, `regulated-workloads.ts`, activation E2E and final suspended-state query |
| PAN/PHI/education/financial classification | Complete | `regulated-content.ts`, single/batch send enforcement and regulated-content E2E |
| Secure-message portal | Complete | migration 091, `secure-messages.ts`, real HIPAA round trip and portal E2E |
| Encryption and Vault/KMS integration | Complete in source | remote provider preload/config guards and KMS tests; target key custody remains operating evidence |
| Independent immutable audit storage | Complete in source | migration 096, full audit bundles/signed heads, S3 Object Lock COMPLIANCE/KMS tests |
| Production IAM/access review | Complete in source | OIDC auth-context enforcement, default-on admin read audit, immutable review decision exercised live |
| HA, backup, restore and failover | Complete in source/local drills | three-node Hetzner topology, PostgreSQL restore and Redis promotion drills; target RPO/RTO remains external |
| HIPAA workflows/evidence | Complete technical workflow | portal, rights/disclosure/breach artifacts, E2E and real regulated campaign |
| FERPA disclosure/amendment | Complete technical workflow | amendment/hearing/disclosure/redisclosure artifacts, E2E and real regulated campaign |
| SEC/FINRA archive integration | Complete fail-closed adapter | archive-before-accept receipts/reconciliation E2E; real missing-provider run accepted zero messages |
| Pen-test/framework preparation | Complete preparation | assessment scope and evidence index; independent execution/sign-off remains external |
| Enable modes individually | Complete and safe | per-mode evidence gates; no global switch; all development activations suspended at handoff |

## External completion boundary

The following cannot truthfully be completed by source code or local tests and
therefore remain activation blockers:

1. signed BAAs, education direct-control terms and archive-provider contracts;
2. organization-specific HIPAA/FERPA/SEC-FINRA applicability and risk analysis;
3. a real specialist SEC/FINRA archive tenant and provider certification;
4. target-environment HA/PITR/failover evidence and measured production RPO/RTO;
5. an independent external penetration test, remediation retest and
   framework-specific assessor conclusions.

The platform now enforces these as evidence gates. No regulated mode should be
enabled until its genuine artifacts are approved and unexpired, and each mode
must be enabled separately.

## Reproduction

```powershell
$env:API_HOST_PORT = '3003'
docker compose up -d --build
npm run build
npm test
npm run prod:check
npm audit --omit=dev --audit-level=high

$env:DEV_REPLAY_CONFIRM = '1'
$env:DEV_REPLAY_API_BASE = 'http://localhost:3003'
$env:DEV_REPLAY_MAILPIT_BASE = 'http://localhost:8025'
$env:DATABASE_URL = 'postgresql://mail:mailpass@localhost:5432/mail_platform'
npx tsx scripts/e2e-dev-live.ts
npx tsx scripts/e2e-regulated-dev-live.ts
```
