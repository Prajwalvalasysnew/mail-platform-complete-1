# Batch sending

`POST /v1/send/batch` sends up to **1 000 independent messages in a single HTTP call**. Each message in the array is fully independent: different recipients, subjects, templates, and variables. This is the right API for transactional campaigns — order confirmations, account notifications, or any workflow where each recipient gets personalized content.

> **One send per recipient, not bulk broadcast.** Batch send is for personalized transactional messages, not for blasting a single email to a list. For broadcast-style sending, send individual messages or use `POST /v1/send` with multiple `to` addresses.

---

## Request

```
POST /v1/send/batch
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

**Body**

```json
{
  "messages": [
    { /* message object */ },
    { /* message object */ }
  ]
}
```

Each message object accepts the same fields as `POST /v1/send`:

| Field | Type | Notes |
|---|---|---|
| `from` | string | Required. Address on a verified domain. |
| `to` | string | Required. One recipient per message in a batch. |
| `subject` | string | Required unless `template_id` is set. |
| `html` | string | HTML body. |
| `text` | string | Plain-text body. |
| `template_id` | string | Use a stored template. |
| `variables` | object | Template substitution values. |
| `tags` | string[] | Labels for activity filtering. |
| `tracking_opens` | boolean | Open tracking pixel. |
| `tracking_clicks` | boolean | Click rewriting. |
| `unsubscribe_group_id` | string | Associate with a suppression group. |
| `reply_to` | string | Reply-to address. |
| `headers` | object | Additional SMTP headers. |
| `metadata` | object | Arbitrary key/value stored with the message. |

**Limits:** 1–1 000 messages per batch. Each message counts against your daily and monthly quota. The entire batch is evaluated atomically: if the quota cannot cover all messages, the call is rejected with `429` before any messages are queued.

---

## Response

`202 Accepted` — the batch has been queued. Check `results[n].accepted` per-message.

```json
{
  "accepted": 2,
  "rejected": 1,
  "results": [
    { "index": 0, "accepted": true,  "message_id": "msg_abc@mail.yourcompany.com" },
    { "index": 1, "accepted": true,  "message_id": "msg_def@mail.yourcompany.com" },
    { "index": 2, "accepted": false, "error": "recipient_suppressed" }
  ]
}
```

A partial rejection (some accepted, some not) still returns `202`. The batch always returns a single top-level status code regardless of per-message outcomes.

---

## Examples

### Personalized receipts (inline content)

```bash
curl -X POST https://api.mailplatform.example/v1/send/batch \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {
        "from": "billing@mail.yourcompany.com",
        "to": "alice@example.com",
        "subject": "Your receipt #1001",
        "html": "<p>Hi Alice, thanks for ordering the Widget.</p>",
        "text": "Hi Alice, thanks for ordering the Widget.",
        "tags": ["receipt"]
      },
      {
        "from": "billing@mail.yourcompany.com",
        "to": "bob@example.com",
        "subject": "Your receipt #1002",
        "html": "<p>Hi Bob, thanks for ordering the Gadget.</p>",
        "text": "Hi Bob, thanks for ordering the Gadget.",
        "tags": ["receipt"]
      }
    ]
  }'
```

### Template-driven batch (recommended at scale)

Create one template with `{{variables}}`, then send it with per-recipient data:

```ts
import { MailPlatformClient } from '@platform/sdk';

const mp = new MailPlatformClient({ apiKey: process.env.MAILPLATFORM_API_KEY! });

const orders = [
  { email: 'alice@example.com', name: 'Alice', order_id: '1001', total: '$49.99' },
  { email: 'bob@example.com',   name: 'Bob',   order_id: '1002', total: '$89.99' },
];

await mp.messages.sendBatch({
  messages: orders.map((o) => ({
    from: 'billing@mail.yourcompany.com',
    to: o.email,
    template_id: 'tmpl_receipt',
    variables: { name: o.name, order_id: o.order_id, total: o.total },
    tags: ['receipt'],
    tracking_opens: true,
  })),
});
```

---

## Handling partial failures

Always iterate `results` to detect per-message failures:

```ts
const response = await mp.messages.sendBatch({ messages });

for (const r of response.results) {
  if (!r.accepted) {
    console.error(`Message ${r.index} rejected: ${r.error}`);
    // Common errors:
    //   recipient_suppressed   — address is on your suppression list
    //   unsubscribe_group_not_found — the group_id doesn't belong to your account
    //   domain_not_verified    — the `from` domain isn't verified
    //   quota_exceeded         — daily/monthly quota hit mid-batch
  }
}
```

---

## Per-message idempotency

Batch send does not support a top-level `Idempotency-Key`. If you need idempotent delivery, use `POST /v1/send` individually with a per-message key, or implement idempotency at the application layer by checking `results[n].message_id` on a retry.

---

## Tips

- **Chunk large jobs.** If you have more than 1 000 messages, split into batches of 1 000 and send them sequentially (or in parallel with care for rate limits).
- **Prefer templates over inline HTML.** Template rendering runs server-side; sending the full HTML for 1 000 messages in a single request increases payload size unnecessarily.
- **Set `tags` consistently.** Tags let you filter the activity feed by campaign — e.g. `tags: ["receipt", "q2-promo"]`.
- **Monitor per-message failures.** A rejected message in a batch silently refunds its quota. Log `results[n]` so you know which recipients didn't receive the email.
