# Data-use restrictions

**Control:** BASE-15 (compliance implementation plan)
**Reviewed:** 2026-07-25

Certain classes of regulated data must not be sent through, stored in, or
processed by this platform. This document states the prohibitions, the
technical controls that back them, and what happens when prohibited data
arrives anyway.

A prohibition that exists only in a contract is not a control. Each class
below names both the contractual restriction and the enforcement.

## 1. Prohibited data classes

| Class | Status | Why | Enforcement |
| --- | --- | --- | --- |
| **Cardholder data** (PAN, CVV/CVC, magnetic-stripe or chip data) | **Prohibited** | The platform is deliberately outside the CDE; there is no approved card channel (PCI-01) | Detection and rejection at send and SMTP ingress; redaction in support tickets; allowlist on billing payloads (PCI-02/03) |
| **Protected health information (ePHI)** | **Prohibited** until the HIPAA workstream completes and a BAA is signed | No BAA program, no ePHI risk analysis, no guaranteed secure delivery (HIPAA-01…15) | Contractual only — **no content detection today** |
| **Student education records** | **Prohibited** until the FERPA workstream completes | No education contract model, disclosure ledger, or amendment workflow (FERPA-01…11) | Contractual only — **no content detection today** |
| **Broker-dealer regulated communications** (as system of record) | **Prohibited** | The audit chain is not a qualifying SEC 17a-4 archive (SEC-01…09) | Contractual only |
| **Special-category / children's data** | **Requires assessment** before processing | Lawful basis and safeguards not yet established (GDPR-14, CCPA-13) | Contractual only |

### Honest statement of coverage

Only the cardholder-data prohibition is technically enforced. The others rest
on contract and customer diligence. That is a deliberate, documented position,
not an oversight: content-scanning for PHI or education records produces false
positives at a rate that would break legitimate transactional mail, and a
scanner that is routinely overridden provides worse assurance than a clear
contractual prohibition plus support escalation.

The compensating controls are: explicit prohibition in terms, the onboarding
question set below, support escalation on discovery, and the ability to
suspend a tenant.

## 2. Where the restrictions must appear

The deploying organization is responsible for placing these in:

1. **Terms of service / acceptable use policy** — the binding prohibition,
   naming each class and the consequence of breach.
2. **Signup and onboarding** — an acknowledgement that the account will not be
   used for prohibited data.
3. **Product surfaces** — a note on the send/API documentation pages.
4. **Customer-facing docs** — `docs/guides/security-compliance.md` already
   carries the PHI and cardholder-data warnings.

**None of items 1-3 are implemented in this repository.** They are a legal and
product task, tracked as an open item below.

## 3. Enforcement: cardholder data

| Ingress | Behaviour |
| --- | --- |
| `POST /v1/send`, `/v1/send/batch` | Rejected `422 card_data_detected` after template rendering, before persistence |
| SMTP submission | Permanent `554` reject at DATA |
| Support tickets and replies | Redacted on write, ticket preserved |
| Billing webhooks | Payment-instrument fields dropped by allowlist; retained free text redacted |

Policy switch: `CARD_DATA_POLICY` = `block` (default) / `redact` / `off`.
Detection requires a card-plausible digit run, a valid Luhn check digit, and a
recognized brand IIN at an issued length — all three, to keep order ids,
timestamps, and phone numbers from being flagged.

Incident response: `docs/runbooks/CARD_DATA.md`.

## 4. Support escalation for accidental receipt

When support, an engineer, or an automated control finds prohibited data:

1. **Do not copy it** into a ticket, chat, incident channel, or evidence
   record. Reference the location, never the value.
2. **Contain** — for card data the automated controls have already acted; for
   PHI, education records, or regulated communications, stop further
   processing of the affected content.
3. **Escalate** to the privacy owner and security owner the same day.
4. **Purge** using the erasure tooling so tombstones and queue gates apply,
   not ad-hoc SQL. Follow the store order in `runbooks/CARD_DATA.md` §3.
5. **Record backup exposure** — online purge does not rewrite backups.
6. **Notify the customer**, restate the prohibition, and tell them what to
   send instead.
7. **Decide on suspension** if the pattern is systematic rather than a
   one-off. That decision belongs to the security owner.

## 5. Changing a prohibition

A prohibited class becomes permitted only when its framework workstream is
complete, its exit criteria are met, the contracts are signed, and the
executive sponsor, Legal, Security, and Privacy approve — per §16 of the
compliance implementation plan. Removing a line from this table is not the
mechanism.

## 6. Open items

- Terms of service and AUP language (Legal).
- Signup acknowledgement and product-surface notices (Product).
- Support training and tabletop for prohibited-data discovery (BASE-11).
- Decision on whether any detection is warranted for PHI, recorded either way
  with its rationale.

## Related

- `docs/PAYMENT_DATA_FLOW.md` — PCI-01 scope evidence
- `docs/runbooks/CARD_DATA.md` — card-data incident response
- `docs/COMPLIANCE_POSTURE.md` — control status
- `docs/COMPLIANCE_IMPLEMENTATION_PLAN.md` — BASE-15 and the framework gates
