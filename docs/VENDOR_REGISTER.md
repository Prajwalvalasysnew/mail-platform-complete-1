# Vendor and subprocessor register

**Control:** BASE-13 (compliance implementation plan); supports GDPR-07,
CCPA-09, SOC 2 vendor criteria.
**Reviewed:** 2026-07-25
**Review frequency:** annually per vendor, and before adding any new one.

A subprocessor register is a **deployment fact, not a source-code fact**: which
vendors are in scope depends on how the platform is deployed, in which regions,
under which contracts. This document provides the required structure and lists
the integration points the codebase can reach, so the register can be completed
rather than invented.

**The register below is a template with unfilled columns. It is not evidence
until the deploying organization completes it.**

## 1. Integration points in the codebase

These are the external services the platform is built to talk to. Whether each
is actually used, and who supplies it, is a deployment decision.

| Integration | Purpose | Personal data reaching it | Configured by |
| --- | --- | --- | --- |
| Amazon SES | Outbound email delivery | Recipient address, full message content | `SES_SMTP_*`, `DELIVERY_TRANSPORT=ses` |
| Self-hosted Haraka | Outbound/inbound MTA | Recipient address, full message content | `DELIVERY_TRANSPORT=haraka` |
| Stripe | Billing | Account email, provider ids | `STRIPE_*` |
| PayPal | Billing | Account email, payer id | `PAYPAL_*` |
| Cashfree | Billing | Account email, customer id | `CASHFREE_*` |
| S3-compatible object storage | Message bodies, attachments, export artifacts | Message content, recipient data | `BODY_S3_*` |
| ClickHouse | Analytics event copy | Recipient address, event metadata | `CLICKHOUSE_*` |
| OpenTelemetry / tracing backend | Traces | Should contain no recipient identifiers — verify sampling | `OTEL_*` |
| Prometheus / Grafana | Metrics | Aggregate counters only | Deployment |
| DNSBL providers | Reputation checks | Sending IPs, recipient domains | Deployment |

Cloud hosting, managed PostgreSQL/Redis, log aggregation, and email-support
tooling are also subprocessors in most deployments and must be added.

## 2. Register template

Complete one row per vendor. A row with blanks is an open item, not a record.

| Field | Description |
| --- | --- |
| Vendor | Legal entity name |
| Service | What it does for the platform |
| Data classes | From `DATA_INVENTORY.md` §1 |
| Personal data? | Yes/No — drives DPA and subprocessor-disclosure obligations |
| Role | Processor / sub-processor / controller |
| Regions | Where data is stored and processed |
| Transfer mechanism | SCCs, adequacy, or n/a |
| Contract | MSA/DPA reference and date |
| Breach notification terms | Deadline the vendor owes you |
| Assurance | SOC 2 / ISO 27001 / PCI AOC, report date |
| Criticality | Impact if unavailable or breached |
| Owner | Named internal accountable person |
| Last review | Date |
| Next review | Date |
| Exit plan | Data return and destruction on termination |

### Rows to complete

| Vendor | Service | Personal data? | Role | Owner | Last review |
| --- | --- | --- | --- | --- | --- |
| _(hosting provider)_ | Compute, network | Yes | Sub-processor | — | — |
| _(managed PostgreSQL)_ | Primary datastore | Yes | Sub-processor | — | — |
| _(object storage)_ | Bodies, exports | Yes | Sub-processor | — | — |
| _(email delivery)_ | Outbound SMTP | Yes | Sub-processor | — | — |
| _(payment provider)_ | Billing | Yes (account only) | Processor/controller | — | — |
| _(log aggregation)_ | Operational logs | Redacted | Sub-processor | — | — |
| _(analytics store)_ | Event analytics | Yes | Sub-processor | — | — |

## 3. Onboarding a vendor

Before any personal data flows:

1. Classify the data it will receive against `DATA_INVENTORY.md`.
2. Collect current assurance (SOC 2 Type II, ISO 27001, or PCI AOC).
3. Execute a DPA with Article 28 terms where personal data is involved,
   including a breach-notification deadline that lets **you** meet yours.
4. Record the region and transfer mechanism.
5. Add to the public subprocessor list and give customers the notice period
   their DPA promises.
6. Assign an internal owner and a review date.
7. Update `DATA_INVENTORY.md` §4 egress table.

A vendor added without steps 3 and 5 creates a customer-contract breach
independent of any security failure.

## 4. Annual review

For each vendor: refresh the assurance report, re-check regions and
subprocessors, confirm the contract is current, review incidents they reported,
and re-assess criticality. Record the review date and reviewer.

Assurance reports have periods. A SOC 2 Type II covering a window that ended
fourteen months ago does not evidence anything about today.

## 5. Termination

On exit: confirm data return or destruction per contract, obtain a destruction
certificate where the contract requires one, revoke credentials and network
access, remove from the subprocessor list, and record the closure.

## 6. Open items

- Complete every row above with a named owner.
- Collect the current assurance report for each.
- Publish the customer-facing subprocessor list and its change-notice process.
- Set the annual review calendar.

## Related

- `docs/DATA_INVENTORY.md` — data classes and egress points
- `docs/PAYMENT_DATA_FLOW.md` — payment provider responsibility split
- `docs/COMPLIANCE_IMPLEMENTATION_PLAN.md` — BASE-13, GDPR-07, CCPA-09
