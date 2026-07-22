# Sending email

`POST /v1/send` sends a single email (to one or multiple recipients). For sending independent personalized messages to many recipients in one API call, use [`POST /v1/send/batch`](./batch-sending.md).

---

## Minimal example

```bash
curl -X POST https://api.mailplatform.example/v1/send \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "hello@mail.yourcompany.com",
    "to": "alice@example.com",
    "subject": "Hello",
    "html": "<h1>It works</h1>"
  }'
```

**Response `202 Accepted`**
```json
{
  "accepted": 1,
  "rejected": 0,
  "message_ids": ["msg_abc123@mail.yourcompany.com"],
  "results": [{ "index": 0, "accepted": true, "message_id": "msg_abc123@mail.yourcompany.com" }]
}
```

`202` means the message was queued, not yet delivered. [Track delivery via webhooks](./webhooks.md) or by polling `GET /v1/messages/:id`.

---

## Request parameters

| Field | Type | Notes |
|---|---|---|
| `from` | string (email) | **Required.** Must be on a [verified domain](./dns-setup.md). |
| `to` | string \| string[] | **Required.** One address or up to 1 000. |
| `subject` | string | Required unless `template_id` is set. |
| `html` | string | HTML body. Provide `html`, `text`, or both. |
| `text` | string | Plain-text body. Always include this alongside `html` for accessibility and spam-filter friendliness. |
| `reply_to` | string | Optional reply-to address. |
| `from_name` | string | Sender display name (`"Acme Support" <support@mail.yourcompany.com>`). |
| `template_id` | string | Render a [stored template](./templates.md) instead of inline content. |
| `variables` | object | Substitution values for the template. |
| `tags` | string[] | Labels for filtering the activity feed. Max 10 tags, 64 chars each. |
| `tracking_opens` | boolean | Inject an [open-tracking pixel](./tracking.md). Default `false`. |
| `tracking_clicks` | boolean | Rewrite links for [click tracking](./tracking.md). Default `false`. |
| `unsubscribe_group_id` | string | Assign to an [unsubscribe group](./unsubscribe-groups.md) for topic-level opt-outs. |
| `headers` | object | Additional SMTP headers (`string → string`). |
| `metadata` | object | Arbitrary key/value stored with the message. Max 50 keys. |
| `ip_pool` | string | Force a specific IP pool. Contact support to configure dedicated pools. |
| `message_class` | string | CAN-SPAM legal classification: `transactional`, `relationship`, or `commercial`. Defaults to `commercial` (full CAN-SPAM treatment). Declaring a non-commercial class requires an API key with the `classify` scope and is audit-logged; without the scope the request is rejected with `403 classification_not_authorized`. |

**Request headers**

| Header | Notes |
|---|---|
| `Idempotency-Key` | Any unique string (UUID recommended). A retry with the same key and body returns the original result without sending again. Reusing the same key with a different body returns `422`. |

---

## Sending to multiple recipients

Pass `to` as an array. Each address gets its own message record and message ID:

```bash
curl -X POST https://api.mailplatform.example/v1/send \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "alerts@mail.yourcompany.com",
    "to": ["alice@example.com", "bob@example.com", "charlie@example.com"],
    "subject": "System maintenance tonight",
    "text": "We will be performing maintenance from 2–4 AM UTC.",
    "tags": ["system-alert"]
  }'
```

If some recipients are suppressed, the response still returns `202` — check `results[n].accepted` per recipient:

```json
{
  "accepted": 2,
  "rejected": 1,
  "results": [
    { "index": 0, "accepted": true,  "message_id": "msg_abc..." },
    { "index": 1, "accepted": false, "error": "recipient_suppressed" },
    { "index": 2, "accepted": true,  "message_id": "msg_def..." }
  ]
}
```

---

## Using a template

See [Templates](./templates.md) for full template management. To send with a template:

```bash
curl -X POST https://api.mailplatform.example/v1/send \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "hello@mail.yourcompany.com",
    "to": "alice@example.com",
    "template_id": "tmpl_welcome",
    "variables": {
      "name": "Alice",
      "dashboard_url": "https://app.yourcompany.com"
    }
  }'
```

When `template_id` is set, do not pass `subject`, `html`, or `text` — the template provides them.

---

## Idempotency

Network issues can cause the same request to be sent twice. An `Idempotency-Key` prevents duplicate sends:

```bash
curl -X POST https://api.mailplatform.example/v1/send \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Idempotency-Key: password-reset-user-12345-2026-06-09" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "security@mail.yourcompany.com",
    "to": "alice@example.com",
    "template_id": "tmpl_password_reset",
    "variables": { "reset_url": "https://app.yourcompany.com/reset?token=xyz" }
  }'
```

A second request with the same key and identical body returns the original `202` response. If the body differs, it returns `422 idempotency_key_reused`.

Keys expire after 24 hours.

---

## Message status lifecycle

```
queued → sending → accepted → delivered
                 ↘ soft_bounced  (retried automatically)
                 ↘ hard_bounced  (recipient suppressed)
                 ↘ failed        (policy block or exhausted retries)
```

| Status | Meaning |
|---|---|
| `queued` | Accepted by the API, waiting for a worker. |
| `sending` | Being handed to the SMTP transport. |
| `accepted` | Transport accepted the message for delivery. |
| `delivered` | Recipient's mail server confirmed receipt (250 OK). |
| `soft_bounced` | Temporary failure; being retried. |
| `hard_bounced` | Permanent failure. Recipient automatically suppressed. |
| `failed` | Permanently failed — check the event payload for `failure_reason`. |

Poll `GET /v1/messages/:id` or use [webhooks](./webhooks.md) to follow status changes.

---

## Test mode

API keys prefixed `mp_test_` run the full pipeline — quota reservation, abuse scanning, suppression checking, template rendering, tracking — but the message is never delivered to a real recipient and never affects your sender reputation.

Use test-mode keys in development and CI to verify your integration without real sends.

---

## SDK example (Node.js)

```ts
import { MailPlatformClient } from '@platform/sdk';

const mp = new MailPlatformClient({
  apiKey: process.env.MAILPLATFORM_API_KEY!,
});

// Simple send
const result = await mp.messages.send({
  from: 'billing@mail.yourcompany.com',
  to: 'alice@example.com',
  subject: 'Your receipt #1001',
  html: '<p>Hi Alice, thanks for your order.</p>',
  text: 'Hi Alice, thanks for your order.',
  tags: ['receipt'],
  trackingOpens: true,
  trackingClicks: true,
  idempotencyKey: `receipt-order-1001`,
});

console.log('Message queued:', result.message_ids[0]);
```

```python
# Python
import os, requests

response = requests.post(
    "https://api.mailplatform.example/v1/send",
    headers={
        "Authorization": f"Bearer {os.environ['MAILPLATFORM_API_KEY']}",
        "Idempotency-Key": "receipt-order-1001",
    },
    json={
        "from": "billing@mail.yourcompany.com",
        "to": "alice@example.com",
        "subject": "Your receipt #1001",
        "html": "<p>Hi Alice, thanks for your order.</p>",
        "text": "Hi Alice, thanks for your order.",
        "tags": ["receipt"],
        "tracking_opens": True,
    },
)
response.raise_for_status()
data = response.json()
print("Message queued:", data["message_ids"][0])
```

---

## Common send errors

| Error | Status | Fix |
|---|---|---|
| `domain_not_verified` | 403 | The `from` domain is not verified. [Verify it](./dns-setup.md). |
| `domain_not_registered` | 403 | The `from` domain has not been added to your account yet. |
| `missing_content` | 400 | Provide `html`, `text`, or a `template_id`. |
| `template_not_found` | 404 | The `template_id` doesn't exist on your account. |
| `content_rejected` | 422 | Content flagged by abuse filters. Check the `reasons` field. |
| `quota_exceeded` | 429 | Daily or monthly quota hit. See [Account & quotas](./account-quotas.md). |
| `physical_address_required` | 422 | Set your physical address via `PATCH /v1/profile` before sending live mail. |

See the full [Errors reference](./errors.md) for all error codes and handling patterns.
