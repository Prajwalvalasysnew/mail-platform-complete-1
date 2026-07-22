# Privacy & GDPR

The platform provides technical endpoints that can help fulfill data-subject
access, portability, and erasure workflows under GDPR, CCPA, and similar laws.
Using these endpoints does not by itself establish legal compliance; the
controller must verify the requester, determine scope, apply exceptions and
legal holds, and meet applicable deadlines. See
[Compliance posture and evidence](../COMPLIANCE_POSTURE.md).

---

## Who is the data controller?

You are the **data controller** for the email addresses and personal data you send through the API. Your users are the data subjects. The platform acts as your **data processor** — it stores and processes the data on your behalf according to your instructions.

When a user of your application asks you to delete or export their data, you are responsible for handling that request. The endpoints below let you do so for data stored in the email platform.

---

## Delete recipient data (right to erasure)

`POST /v1/privacy/delete-recipient` starts tenant-scoped erasure for a recipient
address:

- All messages sent to that address (message records, headers, metadata,
  inline bodies, and inline attachments)
- All tracking events (delivered, opened, clicked, bounced)
- All tracked links
- Soft-bounce history
- The suppression entry (if present)
- Workflow runs and step ledgers for the recipient
- Offloaded body/attachment objects when no surviving message references them
- ClickHouse event data and queued BullMQ payloads when enabled
- Unsubscribe-group memberships for the recipient

The operation retains a deletion request, per-object completion state, and an
append-only consent event without retaining the deleted message content.
The records that survive erasure as compliance evidence — the deletion
request itself and the consent ledger — do not keep the recipient's email
address: it is replaced by a keyed HMAC pseudonym (`erased:<hex>`, computed
with `PRIVACY_PSEUDONYM_SECRET`, falling back to `ENCRYPTION_KEY`), and
free-text consent notes are cleared. With the key, the same address always
recomputes the same pseudonym, so opt-out and erasure evidence remains
verifiable without storing the identifier.
External object, analytics, or queue cleanup failures return a pending result
and are retried by the worker scheduler. Online deletion is irreversible, but
the application does not selectively rewrite historical backups.

```bash
curl -X POST https://api.mailplatform.example/v1/privacy/delete-recipient \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "recipient": "alice@example.com", "requested_by": "dsar-1234" }'
```

**Response `200`**
```json
{
  "recipient": "alice@example.com",
  "status": "completed",
  "request_id": "00000000-0000-0000-0000-000000000000",
  "messages_deleted": 12,
  "events_deleted": 47,
  "bodies_deleted": 3,
  "objects_pending": 0,
  "consent_events_pseudonymized": 2,
  "group_memberships_deleted": 1
}
```

Retain the `request_id` in your case-management records and monitor
the request until its status is `completed`.

If an active tenant or recipient legal hold applies, the endpoint returns
`409 legal_hold_active` before deleting anything. If external cleanup is still
pending, it returns `202`; otherwise it returns `200`. Repeated requests remain
safe, but each accepted request creates its own deletion audit record.

---

## Export recipient data (right of access)

`GET /v1/privacy/export-recipient` returns all data the platform holds on a specific address. Use this to fulfill GDPR Article 15 access requests, which require you to tell a user what data you hold about them.

```bash
curl "https://api.mailplatform.example/v1/privacy/export-recipient?email=alice%40example.com" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

**Response `200`**
```json
{
  "email": "alice@example.com",
  "messages": [
    {
      "message_id": "msg_abc@mail.yourcompany.com",
      "subject": "Your receipt #1001",
      "from_address": "billing@mail.yourcompany.com",
      "status": "delivered",
      "queued_at": "2026-06-09T10:00:00.000Z",
      "delivered_at": "2026-06-09T10:00:03.000Z"
    }
  ],
  "events": [
    { "event_type": "delivered", "occurred_at": "2026-06-09T10:00:03.000Z" },
    { "event_type": "opened",    "occurred_at": "2026-06-09T10:05:00.000Z", "verdict": "human" }
  ],
  "suppression": {
    "reason": "unsubscribe",
    "created_at": "2026-06-15T08:00:00.000Z"
  },
  "tracked_links": [
    { "message_id": "msg_abc@mail.yourcompany.com", "original_url": "https://example.com/receipt", "label": null }
  ],
  "consent_history": [
    { "action": "suppress", "reason": "unsubscribe", "source": "one_click_unsubscribe", "created_at": "2026-06-15T08:00:00.000Z" }
  ],
  "unsubscribe_group_memberships": [
    { "group_id": "00000000-0000-0000-0000-000000000000", "group_name": "Newsletter", "unsubscribed_at": "2026-06-15T08:00:00.000Z" }
  ],
  "workflow_runs": [],
  "soft_bounce": null,
  "erasure_requests": []
}
```

The export covers every recipient-linked record class the platform holds:
messages, events, tracked links, suppression state, the full consent history,
unsubscribe-group memberships, workflow journey runs, soft-bounce state, and
retained (pseudonymized) erasure evidence for the address.

---

## Privacy case management (data-subject requests)

Data-subject requests are deadline-bound legal obligations, not fire-and-forget
API calls. The `/v1/privacy/cases` endpoints track each request as a case:

- `POST /v1/privacy/cases` opens a case with intake source, request types
  (access, erasure, rectification, restriction, objection, portability,
  opt-out, limit-sensitive-PI), and jurisdiction. The statutory due date is
  computed automatically: GDPR one month (extendable by two further months),
  CCPA 45 days (extendable by 45).
- `POST /v1/privacy/cases/:id/verify` records identity verification — a case
  cannot be fulfilled without it.
- `POST /v1/privacy/cases/:id/transition` moves the case through
  `received → verifying → in_progress → fulfilled/denied → closed`. Denial
  requires a documented reason.
- `POST /v1/privacy/cases/:id/extend` applies the single statutory extension
  with a documented reason.
- `POST /v1/privacy/cases/:id/artifacts` and `/communications` attach
  fulfillment evidence references and communication summaries.
- `GET /v1/privacy/cases?overdue=true` surfaces cases past their effective
  deadline for monitoring.

Every action is recorded in an append-only per-case event ledger (closure
evidence). The ledger and logs never carry the subject's identifier — only
case ids — and when a case that included erasure closes, the case record's
own subject identifier is replaced with the same keyed pseudonym the erasure
uses.

---

## Suppression as consent management

The suppression list is also your unsubscribe ledger. When a user opts out:

- They are added to the suppression list with `reason: "unsubscribe"`.
- Future sends to that address are silently skipped.
- The suppression record persists and is included in an export request.

When a user re-subscribes (providing fresh, documented consent), remove the suppression via `DELETE /v1/suppressions/:email`. Only do this when you have clear evidence of consent — removing suppressions without consent is a legal risk and may violate GDPR and CAN-SPAM.

---

## Data retention

Retention runs in bounded scheduled sweeps. The effective body and event
windows resolve from a customer override, then the active plan, then platform
defaults. Catalog defaults are currently 7 days for Free, 30 for Starter, 90
for Pro, and Enterprise defaults of 365 days for events and 90 days for bodies.
Platform physical ceilings can shorten those values. Message metadata and
operational tables have separate environment-configured windows.

Active legal holds preserve applicable recipient/tenant data. DMARC evidence is
covered by tenant-wide holds. Audit rows that leave the hot table are archived
with their hash-chain fields instead of being destroyed.

Historical backups are outside the application erasure path. Operators must
define backup expiration or cryptographic-erasure policy and ensure restore
procedures reapply deletion tombstones before restored data is used.

---

## CAN-SPAM requirements

US CAN-SPAM requires every commercial email to include a physical postal address. Set yours before sending live mail:

```bash
curl -X PATCH https://api.mailplatform.example/v1/profile \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "physical_address": "123 Main St, Springfield, IL 62701, USA" }'
```

The address is automatically appended to the footer of every outgoing email. Live sends without an address set fail with `physical_address_required`.

---

## Best practices

- **Sync erasure requests promptly.** Integrate the endpoint into your approved
  request workflow and monitor asynchronous cleanup to completion. Confirm the
  deadline and any extension/exception with counsel for the applicable law.
- **Do not re-add erased emails.** After deleting a recipient's data, do not import the address back from a CRM sync without a fresh, documented opt-in.
- **Log `request_id`.** Keep the case identifier and completion status
  in your own records; an accepted request alone is not proof that all external
  deletion items completed.
- **Check your Privacy Policy.** If you collect email addresses, your privacy policy should disclose that you use a third-party email delivery service (this platform) and describe how recipient data is handled.
