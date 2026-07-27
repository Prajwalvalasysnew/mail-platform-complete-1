# Runbook: accidental cardholder data

**Control:** PCI-02 (compliance implementation plan)
**Applies when:** a payment card number (PAN) or security code reaches a
platform system that is not an approved cardholder-data channel — which is
every system in this platform.

## Why this exists

The platform is deliberately kept **outside the cardholder data environment
(CDE)**. Card entry happens at the payment provider; no feature here is
designed to accept a PAN. That design intent stops being true the moment a
customer pastes a card number into a support ticket, an email body, or a
webhook metadata field. This runbook covers that case.

Nothing here authorizes storing card data. If the platform ever needs to
accept card data by design, that is a scope change requiring PCI-04 (CDE scope
definition) and a QSA, not a runbook.

## Automated controls already in place

| Ingress | Control | Behaviour |
| --- | --- | --- |
| `POST /v1/send`, `POST /v1/send/batch` | Content screening after template rendering | Rejected with `422 card_data_detected`; nothing is persisted |
| SMTP submission (`packages/smtp-gateway`) | Content screening at DATA | Permanent `554` reject so the device stops retrying |
| Support tickets and ticket replies | Redaction on write | Value replaced with `[redacted-card]`; the ticket is kept |
| Billing webhook payloads | Field allowlist + redaction of retained free text (PCI-03) | Payment-instrument subtrees never stored |

Detection requires a card-plausible digit run **and** a valid Luhn check digit
**and** a recognized brand IIN at a length that brand issues. See
`packages/shared/src/card-data.ts`.

### Policy switch

`CARD_DATA_POLICY` controls the send and SMTP ingress:

- `block` (**default**) — reject. Use this in production.
- `redact` — accept, strip the value first.
- `off` — detect and log only. For a phased rollout: run it long enough to
  size the false-positive rate, then move to `block`. Do not leave it here.

Support tickets always redact regardless of this setting: refusing the ticket
throws away a customer's help request and trains them to route around the
check, which puts the same data somewhere with less scrubbing.

## Detection signals

- API: `422 card_data_detected` responses; `card_data_detected` rows in
  `audit_log`.
- Logs: `[pci] card data detected …` — records field names and brand only,
  never digits.
- Alert on any **sustained** rate. A single hit is a customer mistake; a
  sustained rate means an integration is systematically sending card data and
  the customer must be contacted.

## Response

1. **Confirm scope.** Query the audit trail for the affected tenant:

   ```sql
   SELECT occurred_at, resource, metadata
   FROM audit_log
   WHERE action = 'card_data_detected'
     AND customer_id = '<customer-uuid>'
   ORDER BY occurred_at DESC;
   ```

   The metadata carries field names, brands, and counts — never digits. Do not
   add the value to the ticket, the incident channel, or the evidence record.

2. **Determine whether anything was stored.** Under `block` (the default) a
   rejected send persisted nothing — the request was refused before insert.
   Under `redact` or `off`, or for data that arrived before this control
   shipped, continue to step 3.

3. **Locate and purge stored values.** Check, in order: `messages`
   (`html_body`, `text_body`, `subject`), the object body store for offloaded
   bodies, `support_ticket_messages.body`, `billing_events.payload`,
   `webhook_delivery_log`, and any export artifact generated from them.
   Purge with the existing erasure tooling rather than ad-hoc `UPDATE`s so
   tombstones and queue gates apply. Remember the analytics copy (ClickHouse)
   and any export already downloaded.

4. **Treat backups explicitly.** Online purge does not rewrite backup images.
   Record the affected backup set and its expiry date; the data ages out with
   the backup unless the incident severity justifies a restore-and-rewrite.
   This is a decision for the security owner, not the on-call engineer.

5. **Notify.** Tell the customer what happened, that the platform is not an
   approved card-data channel, and what to send instead (a provider token, or
   the last four digits). Escalate to the security owner if the volume
   suggests a systematic integration problem.

6. **Record the incident** in the evidence register with: date, tenant,
   ingress, whether data was stored, purge actions, backup exposure, customer
   notification, and closure approval. **No card values in the record.**

## False positives

If a legitimate message is rejected, do **not** disable the control for the
tenant. Confirm the value really is not a PAN (Luhn + brand + issued length
all passing is a strong signal it is), then file the sample — field name and
why it is not a card, never the digits — so the brand rules can be tightened.
`CARD_DATA_POLICY=off` is a temporary, time-boxed measure with an owner and an
expiry date, not a fix.

## Related

- `docs/PAYMENT_DATA_FLOW.md` — PCI-01 scope and data-flow evidence
- `docs/DATA_USE_RESTRICTIONS.md` — BASE-15 prohibited data classes
- `docs/COMPLIANCE_IMPLEMENTATION_PLAN.md` — PCI workstream
