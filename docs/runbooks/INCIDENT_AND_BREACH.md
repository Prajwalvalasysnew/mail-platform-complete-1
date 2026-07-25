# Runbook: incident and personal-data breach management

**Control:** BASE-11 (compliance implementation plan); supports GDPR-09,
HIPAA-11, CCPA and SOC 2 incident criteria.
**Reviewed:** 2026-07-25

This runbook covers the technical response. **The notification decision is not
an engineering decision** — it belongs to Legal and the privacy owner, and the
clock in §4 starts whether or not they have been reached yet.

Names, phone numbers, and the escalation rota are deliberately **not** in this
repository. The deploying organization must maintain them alongside it; a
runbook with unfilled contacts is not an operable control.

## 1. Severity

| Sev | Definition | Response |
| --- | --- | --- |
| **SEV1** | Confirmed or likely unauthorized access to personal data; cross-tenant data exposure; loss of the audit chain; key compromise | Page immediately, 24/7. Incident commander assigned within 15 minutes |
| **SEV2** | Availability loss affecting sending or the API; suspected but unconfirmed exposure; erasure or suppression failing silently | Page during business hours, escalate to SEV1 on confirmation |
| **SEV3** | Single-tenant degradation, a contained control failure with no data exposure | Ticket, next business day |
| **SEV4** | Cosmetic or informational | Backlog |

**Cross-tenant data exposure is always SEV1**, regardless of record count. One
record leaking across a tenant boundary means the isolation control failed, and
the blast radius is unknown until proven otherwise.

## 2. Roles

| Role | Responsibility |
| --- | --- |
| Incident commander | Owns the incident; the only person who declares severity changes and closure |
| Technical lead | Containment and remediation |
| Comms lead | Customer and internal updates |
| Privacy owner | Personal-data assessment, notification recommendation |
| Legal owner | Regulatory obligation, final notification decision |
| Scribe | Timeline — every action with a timestamp |

One person may hold several roles in a small team, **except** that the
incident commander must not also be the technical lead on a SEV1: the person
fixing it cannot simultaneously track the clock and coordinate.

## 3. Response

1. **Declare.** Open the incident channel, assign the commander, start the
   timeline. Declaring early and standing down is cheap; declaring late is not.
2. **Contain** before diagnosing. Revoke the credential, disable the endpoint,
   suspend the tenant, pause the queue. Containment beats a clean root cause.
3. **Preserve evidence.** Before destructive remediation: snapshot the affected
   database and object-store state, export the audit log for the window, and
   capture the relevant logs. Verify the audit hash chain **before** and
   **after** — a break is itself a SEV1 finding.
   ```sql
   SELECT * FROM audit_log
   WHERE occurred_at BETWEEN :start AND :end
   ORDER BY occurred_at;
   ```
4. **Assess scope.** Which tenants, which data classes (see
   `docs/DATA_INVENTORY.md`), how many records, what left the system. Use the
   inventory rather than intuition — the answer must survive a regulator asking
   how it was derived.
5. **Remediate**, then verify the fix in production.
6. **Recover.** If a restore is involved, tombstone replay is mandatory before
   the node serves traffic — `RESTORE_RE_DELETION.md`.
7. **Stand down** and schedule the review.

## 4. Personal-data breach clock

**Start the clock at AWARENESS, not at confirmation.** "We are investigating a
possible exposure" starts it; waiting for certainty does not stop it.

| Obligation | Deadline | Owner |
| --- | --- | --- |
| GDPR supervisory authority | 72 hours from awareness, unless unlikely to result in risk | Legal + privacy owner |
| GDPR data subjects | Without undue delay, where high risk | Legal |
| Processor → controller (customers) | Without undue delay | Privacy owner |
| HIPAA (if ever applicable) | Per Breach Notification Rule after risk assessment | Legal |
| US state laws | Varies — jurisdiction-specific | Legal |
| Customer contractual terms | Often stricter than statute — **check the contract** | Legal |

Because the platform is typically a **processor** for recipient data and a
**controller** for account data, most recipient-data incidents mean notifying
the customer promptly so *they* can meet *their* deadline. Missing that is a
contract breach even when no regulator deadline is missed.

Record the decision either way. "We assessed and concluded notification was not
required, because X" is a defensible position; silence is not.

## 5. Evidence to retain

- Timeline with timestamps and named actors.
- Severity assessment and every change to it.
- Scope: tenants, data classes, record counts, method of derivation.
- Containment and remediation actions with times.
- Audit-chain verification before and after.
- Notification decision, its rationale, and who approved it.
- Customer and regulator communications as sent.
- Post-incident review with owned, dated actions.

**Do not put the exposed data itself into the incident record.** Reference
locations and counts. For card data see `CARD_DATA.md`; the same rule applies
to every regulated class.

## 6. Platform-specific playbooks

| Scenario | First actions |
| --- | --- |
| Leaked API key | Revoke the key, review `audit_log` for its activity, check for suppression/erasure calls made with it, notify the tenant |
| Cross-tenant exposure | SEV1. Freeze deploys, confirm RLS posture is fail-closed, identify the query path, quantify from audit and access logs |
| Audit chain break | SEV1. Preserve the archive, verify checkpoints, do not repair the chain — a repaired chain is not evidence |
| Erasure silently failing | Check `deletion_object_items` for exhausted retries; every affected data subject has an unfulfilled request with its own deadline |
| Regulated data received | `CARD_DATA.md` and `DATA_USE_RESTRICTIONS.md` §4 |
| Key compromise | `KEY_COMPROMISE.md` |
| Backup restore required | `RESTORE_RE_DELETION.md` — replay before serving traffic |

## 7. Exercises

BASE-11 requires the procedure be **exercised**, not merely written. Schedule
at least annually, and record the outcome as evidence:

- a cross-tenant exposure tabletop, including the notification decision;
- a restore drill that ends with tombstone replay (`npm run backup-drill`);
- a key-compromise exercise.

An exercise that everyone passes without discovering a gap was probably too
easy.

## 8. Open items

- Named on-call rota and 24/7 contact path.
- Regulator and customer notification templates approved by Legal.
- Incident tooling and channel conventions.
- First tabletop scheduled and evidenced.

## Related

- `docs/DATA_INVENTORY.md` — scope assessment input
- `docs/AUDIT_HASH_CHAIN.md` — chain verification
- `docs/OPERATIONAL_DRILLS.md` — drill schedule
- `docs/COMPLIANCE_IMPLEMENTATION_PLAN.md` — BASE-11, GDPR-09, HIPAA-11
