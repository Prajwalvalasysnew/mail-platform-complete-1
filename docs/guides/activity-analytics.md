# Activity & analytics

The platform stores a complete record of every message you send and every event that occurs on it. You can query this data via the API to build dashboards, debug delivery issues, or audit your send history.

---

## Message status lifecycle

Every message moves through a sequence of statuses:

```
queued → sending → accepted → delivered
                 ↘ soft_bounced → (retry) → ...
                 ↘ failed
                 ↘ hard_bounced
```

| Status | Meaning |
|---|---|
| `queued` | Accepted by the API, waiting for a send worker to pick it up. |
| `sending` | Currently being handed to the SMTP transport. |
| `accepted` | The sending transport (Haraka or SES) accepted the message for delivery. |
| `delivered` | The recipient's mail server confirmed receipt (250 OK). |
| `soft_bounced` | Temporary failure (mailbox full, greylisting). Being retried automatically. |
| `hard_bounced` | Permanent failure — mailbox does not exist, domain rejects mail. Recipient is suppressed. |
| `failed` | Could not be sent after all retries, or blocked by a policy (e.g. missing physical address). |

`delivered` is the highest-confidence status: the remote server accepted the message. It does not guarantee it reached the inbox — spam filtering on the receiving side happens after your MTA disconnects.

---

## List messages

```bash
curl "https://api.mailplatform.example/v1/messages?limit=50&status=hard_bounced" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

**Useful filters:**

```bash
# Messages to a specific recipient
curl "https://api.mailplatform.example/v1/messages?to=alice%40example.com" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"

# Messages by tag
curl "https://api.mailplatform.example/v1/messages?tag=receipt" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"

# Messages in a date range
curl "https://api.mailplatform.example/v1/messages?since=2026-06-01&until=2026-06-08" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"

# Messages containing a subject
curl "https://api.mailplatform.example/v1/messages?subject_contains=receipt" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

**Pagination:**

The endpoint is cursor-paginated. When the response includes a `next_cursor`, pass it as `?cursor=` to get the next page:

```bash
curl "https://api.mailplatform.example/v1/messages?cursor=eyJ0cyI6Ii4uLi4i..." \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

When `next_cursor` is absent, you are on the last page.

---

## Get a single message with events

```bash
curl https://api.mailplatform.example/v1/messages/msg_abc123 \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

**Response**
```json
{
  "message": {
    "message_id": "msg_abc@mail.yourcompany.com",
    "from_address": "billing@mail.yourcompany.com",
    "to_address": "alice@example.com",
    "subject": "Your receipt #1001",
    "status": "delivered",
    "tags": ["receipt"],
    "queued_at":    "2026-06-09T10:00:00.000Z",
    "accepted_at":  "2026-06-09T10:00:01.000Z",
    "delivered_at": "2026-06-09T10:00:03.000Z",
    "opened_at":    "2026-06-09T10:05:00.000Z",
    "human_opened_at": "2026-06-09T10:05:00.000Z",
    "first_clicked_at": null,
    "human_clicked_at": null,
    "bounced_at":   null,
    "attempts": 1,
    "smtp_response": "250 2.0.0 OK  1234567890 abc.12345.smtp.example.com - gsmtp"
  },
  "events": [
    {
      "event_type": "sent",
      "occurred_at": "2026-06-09T10:00:01.000Z",
      "payload": { "transport": "haraka", "provider_id": "..." }
    },
    {
      "event_type": "delivered",
      "occurred_at": "2026-06-09T10:00:03.000Z",
      "payload": { "smtp_response": "250 2.0.0 OK ...", "smtp_host": "gmail-smtp-in.l.google.com" }
    },
    {
      "event_type": "opened",
      "occurred_at": "2026-06-09T10:05:00.000Z",
      "payload": { "verdict": "human", "ip": "203.0.113.1", "user_agent": "Mozilla/5.0 ..." }
    }
  ]
}
```

**Event types on a message:**

| Event type | When it appears |
|---|---|
| `sent` | Worker handed the message to the transport. |
| `delivered` | Remote server returned 250 OK. |
| `soft_bounce` | Temporary SMTP failure; worker will retry. |
| `hard_bounce` | Permanent SMTP failure. |
| `complaint` | Spam report received via ISP Feedback Loop. |
| `opened` | Tracking pixel loaded. Check `verdict` for human vs bot. |
| `clicked` | Tracked link followed. Check `verdict`. |
| `unsubscribed` | Recipient clicked the unsubscribe link. |
| `failed` | Permanently failed (exhausted retries, or policy block). |

---

## Tracking open and click timestamps

| Field on message | Meaning |
|---|---|
| `opened_at` | Timestamp of the first open event (any verdict, including bot). |
| `human_opened_at` | Timestamp of the first open event with `verdict: "human"`. |
| `first_clicked_at` | Timestamp of the first click event (any verdict). |
| `human_clicked_at` | Timestamp of the first click with `verdict: "human"`. |

For engagement-based logic (trigger a follow-up when the user actually reads the email), use `human_opened_at` and `human_clicked_at` to avoid acting on Apple MPP and bot traffic.

---

## Check your quota usage

```bash
curl https://api.mailplatform.example/v1/usage \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

**Response**
```json
{
  "daily_used": 1240,
  "daily_limit": 10000,
  "monthly_used": 28400,
  "monthly_limit": 200000,
  "period": "2026-06"
}
```

You receive webhook notifications when you reach 80% and 100% of your daily or monthly quota. Subscribe to the `quota_warning` and `quota_exceeded` event types.

---

## Building a delivery dashboard

A common pattern: aggregate data from the message list and webhook events into your own database for dashboards and reporting.

```ts
import { MailPlatformClient } from '@platform/sdk';

const mp = new MailPlatformClient({ apiKey: process.env.MAILPLATFORM_API_KEY! });

let cursor: string | undefined;
const stats = { sent: 0, delivered: 0, bounced: 0, opened: 0 };

do {
  const page = await mp.messages.list({
    since: '2026-06-01',
    until: '2026-06-08',
    limit: 500,
    cursor,
  });

  for (const msg of page.messages) {
    stats.sent++;
    if (msg.status === 'delivered')     stats.delivered++;
    if (msg.status === 'hard_bounced')  stats.bounced++;
    if (msg.human_opened_at)            stats.opened++;
  }

  cursor = page.next_cursor;
} while (cursor);

console.log('Delivery rate:', (stats.delivered / stats.sent * 100).toFixed(1) + '%');
console.log('Bounce rate:',   (stats.bounced   / stats.sent * 100).toFixed(1) + '%');
console.log('Open rate:',     (stats.opened    / stats.sent * 100).toFixed(1) + '%');
```

For real-time reporting, use [webhooks](./webhooks.md) to receive events as they happen rather than polling the message list.

---

## Debugging a delivery problem

If a recipient says they never received your email:

1. Find the message: `GET /v1/messages?to=recipient@example.com`
2. Check its `status`. If `hard_bounced` or `failed`, read `failure_reason` in the event payload.
3. If `delivered`, the remote server accepted it — the issue is on the receiving side (spam folder, inbox filters). Check the `smtp_response` for the remote server's reply.
4. If `queued` and has been for more than a few minutes, contact support.
