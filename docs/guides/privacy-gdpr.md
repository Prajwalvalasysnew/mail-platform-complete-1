# Privacy & GDPR

The platform provides endpoints to fulfill data subject rights under the GDPR (General Data Protection Regulation), CCPA (California Consumer Privacy Act), and similar privacy regulations. These endpoints are for use when one of your users exercises their right to erasure or right of access.

---

## Who is the data controller?

You are the **data controller** for the email addresses and personal data you send through the API. Your users are the data subjects. The platform acts as your **data processor** — it stores and processes the data on your behalf according to your instructions.

When a user of your application asks you to delete or export their data, you are responsible for handling that request. The endpoints below let you do so for data stored in the email platform.

---

## Delete recipient data (right to erasure)

`POST /v1/privacy/delete-recipient` permanently erases all stored data for a recipient address:

- All messages sent to that address (message records, headers, metadata)
- All tracking events (delivered, opened, clicked, bounced)
- All tracked links
- Soft-bounce history
- The suppression entry (if present)

An audit record is retained internally for compliance purposes. The deletion itself is irreversible.

```bash
curl -X POST https://api.mailplatform.example/v1/privacy/delete-recipient \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "email": "alice@example.com" }'
```

**Response `200`**
```json
{
  "email": "alice@example.com",
  "deleted": {
    "messages": 12,
    "events": 47,
    "tracked_links": 8,
    "soft_bounces": 1
  },
  "audit_id": "audit_01ABCDEF"
}
```

Retain the `audit_id` in your records to demonstrate compliance if audited.

If the address has no data (never sent to), the call still returns `200` with all counts as `0` (idempotent).

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
  }
}
```

---

## Suppression as consent management

The suppression list is also your unsubscribe ledger. When a user opts out:

- They are added to the suppression list with `reason: "unsubscribe"`.
- Future sends to that address are silently skipped.
- The suppression record persists and is included in an export request.

When a user re-subscribes (providing fresh, documented consent), remove the suppression via `DELETE /v1/suppressions/:email`. Only do this when you have clear evidence of consent — removing suppressions without consent is a legal risk and may violate GDPR and CAN-SPAM.

---

## Data retention

Message records, events, and tracking data are retained for the duration your account is active. If you need to enforce a shorter retention window (e.g. delete all data older than 12 months), use the [delete recipient endpoint](#delete-recipient-data-right-to-erasure) or contact support to discuss bulk data purges.

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

- **Sync erasure requests promptly.** GDPR allows up to 30 days to fulfill a right-to-erasure request. The API endpoint is immediate — integrate it into your user-delete flow so erasure happens automatically.
- **Do not re-add erased emails.** After deleting a recipient's data, do not import the address back from a CRM sync without a fresh, documented opt-in.
- **Log `audit_id`.** The audit record retained on our side + your logged `audit_id` together constitute evidence that the erasure was performed. Keep it in your own records.
- **Check your Privacy Policy.** If you collect email addresses, your privacy policy should disclose that you use a third-party email delivery service (this platform) and describe how recipient data is handled.
