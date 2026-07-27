# Regulated-mode activation runbook

1. Tenant requests exactly one mode through
   `POST /v1/compliance/workloads/{mode}/request`.
2. Tenant submits every required artifact with its SHA-256 and expiry through
   `POST /v1/compliance/workload-evidence`.
3. An administrator other than the submitter validates the artifact at its
   immutable URI and approves or rejects it. Rejections require a reason.
4. Operator reruns production readiness, restore/PITR/failover, audit-chain,
   persona and framework workflow tests against the candidate release.
5. Independent assessor completes the external assessment and all critical/
   high findings are retested closed. Submit the final report checksum.
6. Administrator requests activation. The service recomputes approved,
   unexpired evidence; it never trusts request booleans.
7. Verify the mode-specific runtime path with synthetic data, then monitor
   archive/portal errors and audit checkpoints.
8. Suspend immediately if evidence expires, a provider fails outside its
   recovery objective, scope changes, or a material control exception opens.

Never activate several modes as a bundle. Complete and observe one mode before
starting approval of another.
