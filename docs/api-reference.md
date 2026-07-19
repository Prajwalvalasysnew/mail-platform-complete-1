# API Reference

All endpoints are under `https://api.mailplatform.example/v1` unless noted. Every request (except `POST /v1/signup` and `GET /health`) requires:

```
Authorization: Bearer YOUR_API_KEY
```

Responses use standard HTTP status codes and a consistent JSON error envelope. See [Errors](./guides/errors.md).

---

## Authentication & account

### Create account
```
POST /v1/signup
```
Public — no key required. Creates a customer account and issues a live API key with the `send` scope.

**Body**

| Field | Type | Notes |
|---|---|---|
| `email` | string | Required. Your account email. |
| `name` | string | Required. Your name or company name. |

**Response `201`**
```json
{
  "customer": { "id": "cust_...", "email": "you@example.com", "tier": "free", "daily_quota": 100 },
  "api_key": "mp_live_xxxxxxxxxxxxxxxxxxxxx",
  "note": "Save this API key — it will not be shown again."
}
```

---

### Get profile
```
GET /v1/profile
```
Scope: `messages`

Returns account details including your sending tier, quotas, and physical address.

**Response `200`**
```json
{
  "customer": {
    "id": "cust_...",
    "email": "you@example.com",
    "name": "Acme Inc",
    "physical_address": "123 Main St, Springfield, IL 62701, USA",
    "tier": "starter",
    "daily_quota": 10000,
    "monthly_quota": 200000,
    "billing_status": "active",
    "status": "active",
    "created_at": "2026-01-01T00:00:00.000Z"
  }
}
```

---

### Update profile
```
PATCH /v1/profile
```
Scope: `messages`

**Body**

| Field | Type | Notes |
|---|---|---|
| `name` | string | 1–200 chars. |
| `physical_address` | string \| null | Required by CAN-SPAM for commercial email. Set to `null` to clear. |
| `tls_required` | boolean | Compliance posture: stamp every send with a require-TLS marker and record per-delivery TLS evidence (`tls_secured`) in delivered event payloads. |

**Response `200`**
```json
{ "ok": true }
```

---

### List API keys
```
GET /v1/account/api-keys
```
Scope: `messages`

Returns all keys on the account. The secret is never returned after creation.

---

### Create API key
```
POST /v1/account/api-keys
```
Scope: `messages`

**Body**

| Field | Type | Notes |
|---|---|---|
| `name` | string | Descriptive label (e.g. `"production-backend"`). |
| `scopes` | string[] | One or more of `send`, `domains`, `suppressions`, `messages`, `templates`, `webhooks`. |
| `expires_at` | ISO date | Optional expiry. |

**Response `201`**
```json
{
  "id": "key_...",
  "name": "production-backend",
  "key": "mp_live_xxxxxxxxxxxxxxxxxxxxx",
  "scopes": ["send"],
  "created_at": "2026-01-01T00:00:00.000Z",
  "note": "Save this key — it will not be shown again."
}
```

---

### Rotate API key
```
POST /v1/account/api-keys/:id/rotate
```
Scope: `messages`

Issues a new secret. The old key remains valid during a short overlap window (~48 h) so you can swap secrets with zero downtime.

**Response `201`**
```json
{
  "id": "key_...",
  "key": "mp_live_yyyyyyyyyyyyyyyyyyyyy",
  "note": "Old key is valid for 48 hours. Update your environment before it expires."
}
```

---

### Delete API key
```
DELETE /v1/account/api-keys/:id
```
Scope: `messages`

Immediately revokes the key.

**Response `204`** (no body)

---

## Sending

### Send email
```
POST /v1/send
```
Scope: `send`

**Body**

| Field | Type | Notes |
|---|---|---|
| `from` | string | Required. Address on a verified sending domain. |
| `to` | string \| string[] | Required. Up to 1 000 recipients. |
| `subject` | string | Required unless `template_id` is set. |
| `html` | string | HTML body. Provide `html`, `text`, or both. |
| `text` | string | Plain-text body. |
| `reply_to` | string | Optional reply-to address. |
| `from_name` | string | Sender display name (overrides the address name). |
| `template_id` | string | Render a stored template. Supplies `subject`, `html`, and `text`. |
| `variables` | object | Substitution values for the template (Handlebars). |
| `tags` | string[] | Labels for filtering activity. Max 10 tags, 64 chars each. |
| `tracking_opens` | boolean | Inject a 1×1 open-tracking pixel. Default `false`. |
| `tracking_clicks` | boolean | Rewrite links for click tracking. Default `false`. |
| `unsubscribe_group_id` | string | Associate with an unsubscribe group. |
| `priority` | string | `"critical"` puts the message at the head of the queue (OTPs, fraud/outage alerts). Paid/enterprise tiers; per-minute capped — overflow is delivered on the standard lane and reported via `priority_applied` in the response. |
| `headers` | object | Additional SMTP headers (string → string). |
| `metadata` | object | Arbitrary key/value pairs stored with the message. |
| `ip_pool` | string | Force a specific IP pool (contact support to configure pools). |

**Headers**

| Header | Notes |
|---|---|
| `Idempotency-Key` | Any unique string. A retry with the same key and body returns the original result. |

**Response `202`**
```json
{
  "accepted": 2,
  "rejected": 0,
  "message_ids": ["msg_abc123@mail.yourcompany.com", "msg_def456@mail.yourcompany.com"],
  "results": [
    { "index": 0, "accepted": true,  "message_id": "msg_abc123@mail.yourcompany.com" },
    { "index": 1, "accepted": true,  "message_id": "msg_def456@mail.yourcompany.com" }
  ]
}
```

If some recipients are rejected (suppressed, invalid), `accepted` and `rejected` reflect the actual split. Check `results[n].accepted` per-index.

---

### Batch send
```
POST /v1/send/batch
```
Scope: `send`

Send up to 1 000 messages in a single call. Each message in the array is independent (different `to`, `subject`, `variables`, `template_id`, etc.). Useful for transactional campaigns where each recipient gets personalized content.

**Body**

```json
{
  "messages": [
    {
      "from": "billing@mail.yourcompany.com",
      "to": "alice@example.com",
      "subject": "Your receipt #1001",
      "html": "<p>Hi Alice, thanks for your order.</p>",
      "tags": ["receipt"]
    },
    {
      "from": "billing@mail.yourcompany.com",
      "to": "bob@example.com",
      "template_id": "tmpl_receipt",
      "variables": { "name": "Bob", "order_id": "1002" },
      "tags": ["receipt"]
    }
  ]
}
```

Each message object accepts the same fields as `POST /v1/send`.

**Response `202`**
```json
{
  "accepted": 2,
  "rejected": 0,
  "results": [
    { "index": 0, "accepted": true,  "message_id": "msg_abc..." },
    { "index": 1, "accepted": true,  "message_id": "msg_def..." }
  ]
}
```

Failures are per-index in `results[n]`. The batch always returns `202`; check individual `accepted` flags.

---

## Messages

### List messages
```
GET /v1/messages
```
Scope: `messages`

Returns messages for your account, newest first. Cursor-paginated.

**Query parameters**

| Parameter | Type | Notes |
|---|---|---|
| `limit` | integer | 1–500. Default `50`. |
| `cursor` | string | Opaque cursor from previous response's `next_cursor`. |
| `status` | string | Filter: `queued`, `sending`, `accepted`, `delivered`, `soft_bounced`, `hard_bounced`, `failed`. |
| `to` | string | Filter by exact recipient address. |
| `from_address` | string | Filter by exact sender address. |
| `tag` | string | Filter by tag. |
| `subject_contains` | string | Case-insensitive subject substring. |
| `since` | ISO date | Only messages queued at or after this time. |
| `until` | ISO date | Only messages queued at or before this time. |

**Response `200`**
```json
{
  "messages": [
    {
      "message_id": "msg_abc@mail.yourcompany.com",
      "from_address": "billing@mail.yourcompany.com",
      "to_address": "alice@example.com",
      "subject": "Your receipt #1001",
      "status": "delivered",
      "tags": ["receipt"],
      "queued_at": "2026-06-09T10:00:00.000Z",
      "accepted_at": "2026-06-09T10:00:01.000Z",
      "delivered_at": "2026-06-09T10:00:03.000Z",
      "opened_at": "2026-06-09T10:05:00.000Z",
      "human_opened_at": "2026-06-09T10:05:00.000Z",
      "first_clicked_at": null,
      "attempts": 1
    }
  ],
  "next_cursor": "eyJ0cyI6Ii4uLiIsImlkIjoiLi4uIn0"
}
```

Pass `next_cursor` as `cursor` in the next request to get the following page. When `next_cursor` is absent, you are on the last page.

---

### Get message
```
GET /v1/messages/:id
```
Scope: `messages`

Returns a single message plus its full event timeline.

**Response `200`**
```json
{
  "message": {
    "message_id": "msg_abc@mail.yourcompany.com",
    "from_address": "billing@mail.yourcompany.com",
    "to_address": "alice@example.com",
    "subject": "Your receipt",
    "status": "delivered",
    "queued_at": "2026-06-09T10:00:00.000Z",
    "delivered_at": "2026-06-09T10:00:03.000Z",
    "smtp_response": "250 2.0.0 OK",
    "tags": ["receipt"],
    "metadata": {}
  },
  "events": [
    { "event_type": "sent",      "occurred_at": "2026-06-09T10:00:01.000Z", "payload": { "transport": "haraka" } },
    { "event_type": "delivered", "occurred_at": "2026-06-09T10:00:03.000Z", "payload": { "smtp_response": "250 2.0.0 OK" } },
    { "event_type": "opened",    "occurred_at": "2026-06-09T10:05:00.000Z", "payload": { "verdict": "human" } }
  ]
}
```

---

## Domains

### List domains
```
GET /v1/domains
```
Scope: `domains`

**Response `200`**
```json
{
  "domains": [
    {
      "id": "dom_...",
      "domain": "mail.yourcompany.com",
      "status": "verified",
      "dmarc_policy": "reject",
      "created_at": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

`status` is one of `pending`, `verified`, `failed`.

---

### Add domain
```
POST /v1/domains
```
Scope: `domains`

**Body**

| Field | Type | Notes |
|---|---|---|
| `domain` | string | The domain or subdomain (e.g. `mail.yourcompany.com`). |

**Response `201`**
```json
{
  "domain": {
    "id": "dom_...",
    "domain": "mail.yourcompany.com",
    "status": "pending",
    "dns_records": [
      { "type": "TXT",   "host": "_mailplatform.mail.yourcompany.com", "value": "abc123...",       "purpose": "ownership_verification" },
      { "type": "TXT",   "host": "mail.yourcompany.com",               "value": "v=spf1 include:yourplatform.com ~all", "purpose": "spf" },
      { "type": "TXT",   "host": "default._domainkey.mail.yourcompany.com", "value": "v=DKIM1; k=rsa; p=...", "purpose": "dkim" },
      { "type": "CNAME", "host": "bounces.mail.yourcompany.com",       "value": "bounces.yourplatform.com.", "purpose": "bounce_return_path" }
    ]
  }
}
```

Publish all DNS records, then call `POST /v1/domains/:id/verify`.

---

### Verify domain
```
POST /v1/domains/:id/verify
```
Scope: `domains`

Re-checks DNS and marks the domain `verified` if all records are present. Call this after publishing your DNS records. Safe to call multiple times.

**Response `200`**
```json
{ "status": "verified", "checks": { "ownership": true, "spf": true, "dkim": true } }
```

---

### Get domain
```
GET /v1/domains/:id
```
Scope: `domains`

Returns domain details plus current DNS record values.

---

### Delete domain
```
DELETE /v1/domains/:id
```
Scope: `domains`

Removes the domain from your account. Pending sends from this domain's addresses will fail.

**Response `204`** (no body)

---

## Templates

### List templates
```
GET /v1/templates
```
Scope: `templates`

---

### Create template
```
POST /v1/templates
```
Scope: `templates`

**Body**

| Field | Type | Notes |
|---|---|---|
| `name` | string | Required. Human-readable label. |
| `subject` | string | Required. May contain `{{variables}}`. |
| `html_body` | string | HTML version. May contain `{{variables}}`. |
| `text_body` | string | Plain-text version. |

**Response `201`**
```json
{
  "template": {
    "id": "tmpl_...",
    "name": "welcome",
    "subject": "Welcome, {{name}}",
    "html_body": "<h1>Hi {{name}}</h1>",
    "text_body": "Hi {{name}}",
    "created_at": "2026-01-01T00:00:00.000Z"
  }
}
```

---

### Get template
```
GET /v1/templates/:id
```
Scope: `templates`

---

### Update template
```
PATCH /v1/templates/:id
```
Scope: `templates`

Accepts the same fields as create; only provided fields are updated.

---

### Delete template
```
DELETE /v1/templates/:id
```
Scope: `templates`

**Response `204`** (no body)

---

## Suppressions

### List suppressions
```
GET /v1/suppressions
```
Scope: `suppressions`

**Query parameters**

| Parameter | Type | Notes |
|---|---|---|
| `limit` | integer | 1–1000. Default `100`. |
| `offset` | integer | Default `0`. |
| `reason` | string | Filter by reason: `hard_bounce`, `complaint`, `unsubscribe`, `manual`, `invalid`. |

**Response `200`**
```json
{
  "suppressions": [
    { "email": "user@example.com", "reason": "hard_bounce", "notes": null, "created_at": "2026-06-01T00:00:00.000Z" }
  ]
}
```

---

### Add suppression
```
POST /v1/suppressions
```
Scope: `suppressions`

**Body**

| Field | Type | Notes |
|---|---|---|
| `email` | string | Required. |
| `reason` | string | `hard_bounce`, `complaint`, `unsubscribe`, `manual`, or `invalid`. Default `manual`. |
| `notes` | string | Optional free-text note. Max 500 chars. |

**Response `201`**
```json
{ "email": "user@example.com" }
```

---

### Remove suppression
```
DELETE /v1/suppressions/:email
```
Scope: `suppressions`

URL-encode the email address (e.g. `user%40example.com`). Only remove suppressions when you have fresh, explicit consent from the recipient — do not remove hard bounces.

**Response `204`** (no body)

---

### Bulk import
```
POST /v1/suppressions/import
```
Scope: `suppressions`

Import an existing do-not-email list. The list is quality-scored before import; obviously dirty lists (spam traps, high disposable-domain share) are rejected unless `force: true` is set.

**Body**

| Field | Type | Notes |
|---|---|---|
| `emails` | string[] | Required. Up to 100 000 addresses. |
| `reason` | string | Applied to all imported addresses. Default `manual`. |
| `force` | boolean | Import even if quality score recommends rejection. Default `false`. |

**Response `200`**
```json
{
  "imported": 9842,
  "quality": {
    "total": 10000,
    "valid": 9842,
    "spam_traps": 3,
    "disposable": 155,
    "recommendation": "accept"
  }
}
```

---

### Export suppressions
```
GET /v1/suppressions/export
```
Scope: `suppressions`

Returns a CSV file (streamed). Rate-limited to 10 requests/minute.

**Query parameters**

| Parameter | Type | Notes |
|---|---|---|
| `reason` | string | Optional filter. |
| `since` | ISO date | Only addresses suppressed at or after this date. |

**Response `200`** — `Content-Type: text/csv`

```
email,reason,notes,created_at
user@example.com,hard_bounce,,2026-06-01T00:00:00.000Z
```

---

## Unsubscribe groups

### List groups
```
GET /v1/unsubscribe-groups
```
Scope: `suppressions`

---

### Create group
```
POST /v1/unsubscribe-groups
```
Scope: `suppressions`

**Body**

| Field | Type | Notes |
|---|---|---|
| `name` | string | Required. 1–200 chars. |
| `description` | string | Optional. |
| `is_default` | boolean | Make this the account's default group. Only one group can be default. |

**Response `201`**
```json
{
  "group": {
    "id": "grp_...",
    "name": "Marketing Newsletters",
    "description": "Weekly product updates",
    "is_default": false,
    "created_at": "2026-01-01T00:00:00.000Z"
  }
}
```

---

### Update group
```
PATCH /v1/unsubscribe-groups/:id
```
Scope: `suppressions`

Accepts `name`, `description`, `is_default`.

---

### Delete group
```
DELETE /v1/unsubscribe-groups/:id
```
Scope: `suppressions`

**Response `204`** (no body)

---

### List group members
```
GET /v1/unsubscribe-groups/:id/members
```
Scope: `suppressions`

Returns emails that have unsubscribed from this specific group.

**Query parameters:** `limit` (1–1000, default 100), `offset`.

**Response `200`**
```json
{
  "members": [
    { "email": "user@example.com", "unsubscribed_at": "2026-06-01T00:00:00.000Z" }
  ]
}
```

---

### Add group members
```
POST /v1/unsubscribe-groups/:id/members
```
Scope: `suppressions`

Seed a group with known opt-outs (e.g. migrating from another platform).

**Body**

| Field | Type | Notes |
|---|---|---|
| `emails` | string[] | Required. 1–1000 valid email addresses. |

**Response `200`**
```json
{ "added": 500 }
```

---

### Remove group member (re-subscribe)
```
DELETE /v1/unsubscribe-groups/:id/members/:email
```
Scope: `suppressions`

Re-subscribes the address to this group. Only call this when you have fresh explicit opt-in from the recipient.

**Response `204`** (no body)

---

## Webhooks

### List webhooks
```
GET /v1/webhooks
```
Scope: `webhooks`

---

### Create webhook
```
POST /v1/webhooks
```
Scope: `webhooks`

**Body**

| Field | Type | Notes |
|---|---|---|
| `url` | string | Required. HTTPS only. Must be publicly reachable. |
| `events` | string[] | Required. One or more event types (see [event catalog](./guides/webhooks.md#event-catalog)). |

**Response `201`**
```json
{
  "id": "wh_...",
  "url": "https://yourapp.example.com/hooks/mail",
  "events": ["delivered", "hard_bounce", "complaint"],
  "signing_secret": "whsec_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "created_at": "2026-01-01T00:00:00.000Z",
  "note": "Save the signing_secret — it will not be shown again."
}
```

---

### Delete webhook
```
DELETE /v1/webhooks/:id
```
Scope: `webhooks`

**Response `204`** (no body)

---

### Rotate signing secret
```
POST /v1/webhooks/:id/rotate-secret
```
Scope: `webhooks`

Issues a new signing secret for the endpoint. Update your handler before the old secret expires.

**Response `201`**
```json
{
  "id": "wh_...",
  "signing_secret": "whsec_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
  "note": "Update your endpoint to verify signatures with the new secret."
}
```

---

### Get delivery log
```
GET /v1/webhooks/:id/deliveries
```
Scope: `webhooks`

Cursor-paginated delivery history for an endpoint.

**Query parameters**

| Parameter | Type | Notes |
|---|---|---|
| `limit` | integer | 1–200. Default `50`. |
| `before` | integer | Cursor: return entries with `id` less than this value. |

**Response `200`**
```json
{
  "deliveries": [
    {
      "id": 1042,
      "event_type": "delivered",
      "attempt": 1,
      "status_code": 200,
      "outcome": "success",
      "duration_ms": 134,
      "delivered_at": "2026-06-09T10:00:05.000Z"
    }
  ],
  "next_cursor": 1001
}
```

---

### Send test event
```
POST /v1/webhooks/:id/test
```
Scope: `webhooks`

Rate-limited to 5 calls/minute. Delivers a synthetic `ping` event to verify your endpoint is reachable and correctly verifying signatures.

**Response `200`**
```json
{ "outcome": "success", "status_code": 200, "duration_ms": 98 }
```

---

## Privacy & GDPR

### Delete recipient data
```
POST /v1/privacy/delete-recipient
```
Scope: `suppressions`

Permanently deletes all data associated with a recipient address: messages, events, tracked links, soft-bounce history. An audit record is retained. Irreversible.

**Body**

| Field | Type | Notes |
|---|---|---|
| `email` | string | Required. |

**Response `200`**
```json
{
  "email": "user@example.com",
  "deleted": {
    "messages": 12,
    "events": 47,
    "tracked_links": 8,
    "soft_bounces": 1
  },
  "audit_id": "audit_..."
}
```

---

### Export recipient data
```
GET /v1/privacy/export-recipient?email=user%40example.com
```
Scope: `suppressions`

Returns all stored data for a recipient address. Use this to fulfill GDPR Article 15 access requests.

**Response `200`**
```json
{
  "email": "user@example.com",
  "messages": [ ... ],
  "events": [ ... ],
  "suppression": { "reason": "unsubscribe", "created_at": "..." }
}
```

---

## Account usage

### Get usage
```
GET /v1/usage
```
Scope: `messages`

Returns daily and monthly quota consumption for the current billing period.

**Response `200`**
```json
{
  "daily_used": 1240,
  "daily_limit": 10000,
  "monthly_used": 28400,
  "monthly_limit": 200000,
  "period": "2026-06"
}
```

---

## Support

### List support tickets
```
GET /v1/support/tickets
```

Returns your account's support tickets. Ordered by creation date, newest first.

---

### Create support ticket
```
POST /v1/support/tickets
```

**Body**

| Field | Type | Notes |
|---|---|---|
| `subject` | string | Required. Brief summary. |
| `body` | string | Required. Describe the issue. |
| `priority` | string | `low`, `normal` (default), `high`, `urgent`. |
| `category` | string | `general`, `billing`, `deliverability`, `technical`, `abuse`, `account`. |

**Response `201`**
```json
{
  "ticket": {
    "id": "tkt_...",
    "subject": "Delivery rate dropped on domain",
    "status": "open",
    "priority": "normal",
    "created_at": "2026-06-09T10:00:00.000Z"
  }
}
```

---

### Get ticket
```
GET /v1/support/tickets/:id
```

Returns the ticket and its message thread (agent-only internal notes are hidden).

---

### Reply to ticket
```
POST /v1/support/tickets/:id/messages
```

**Body**

| Field | Type | Notes |
|---|---|---|
| `body` | string | Required. Your reply. |

---

### Rate ticket (CSAT)
```
POST /v1/support/tickets/:id/rate
```

Available only after the ticket is resolved or closed.

**Body**

| Field | Type | Notes |
|---|---|---|
| `rating` | integer | Required. 1–5. |
| `comment` | string | Optional free-text feedback. |

---

## Workflows (Automation)

Multi-step per-recipient journeys. Requires the `workflows` key scope. See the
[Workflows guide](./guides/workflows.md) for the definition format and
concepts.

### List workflows
```
GET /v1/workflows?status=active&limit=50&offset=0
```
Returns workflows with run counts (`active_runs`, `total_runs`).

### Create workflow
```
POST /v1/workflows
```

**Body**

| Field | Type | Notes |
|---|---|---|
| `name` | string | Required. Unique per account. |
| `description` | string | Optional. |
| `definition` | object | Optional draft definition (validated leniently). |

### Get / update / archive
```
GET    /v1/workflows/:id        → draft + published definitions
PUT    /v1/workflows/:id        → edit name/description/draft definition
DELETE /v1/workflows/:id        → archive (stops entries, cancels in-flight runs)
```

### Validate a definition
```
POST /v1/workflows/validate
```
Body: `{ "definition": { … }, "strict": true }`. Returns `{ valid, errors, warnings }` without saving anything.

### Publish / lifecycle
```
POST /v1/workflows/:id/publish   → strict-validate, snapshot a version, activate
POST /v1/workflows/:id/pause     → stop new entries (in-flight runs continue)
POST /v1/workflows/:id/resume
```

### Version history
```
GET  /v1/workflows/:id/versions
GET  /v1/workflows/:id/versions/:version
POST /v1/workflows/:id/versions/:version/restore   → copy back into the draft
```

### Trigger a run
```
POST /v1/workflows/:id/trigger
```
Supports the `Idempotency-Key` header (same semantics as `/v1/send`).

**Body**

| Field | Type | Notes |
|---|---|---|
| `subject_email` | string | Required. The recipient entering the journey. |
| `context` | object | Optional data, available to conditions and templates as `{{context.*}}`. |

Returns `202 { "started": true, "run_id": "…" }` or `409 { "error": "not_started", "reason": "…" }`
(`already_active`, `reentry_blocked`, `reentry_cooldown`, `capacity`).

### Bulk trigger
```
POST /v1/workflows/:id/trigger/bulk
```
Body: `{ "subjects": [{ "email", "context"? }, …], "context"? }` — up to 1000
subjects. Returns per-subject results.

### Simulate (dry run)
```
POST /v1/workflows/:id/simulate
```
Walks the draft (or `"source": "published"`) definition for a hypothetical
subject with zero side effects. `event_outcomes` / `split_outcomes` force
specific branches.

### Runs
```
GET  /v1/workflows/:id/runs?status=&subject_email=&limit=&offset=
GET  /v1/workflows/runs/:runId          → run + step-by-step execution log
POST /v1/workflows/runs/:runId/cancel
```

### Stats
```
GET /v1/workflows/:id/stats?days=30
```
Run counts by status, goal attainment, per-step entered/completed/failed
counters, and a daily started/finished/goals timeseries.

### Webhook signing secret
```
GET /v1/workflows/signing-secret
```
Per-account HMAC-SHA256 secret for verifying workflow `webhook` step
deliveries (`X-Workflow-Signature`).

---

## Tools

### Domain deliverability scan
```
POST /v1/tools/domain-scan
```
Scope: `domains`. Body: `{ "domain": "acme.com", "check_blocklists": true }`.

Analyzes any domain's live DNS posture and returns a graded report
(`score` 0–100, `grade` A–F): SPF record parsing including the 10-DNS-lookup
limit and nested includes, the ESPs currently authorized in SPF
(`esps_detected`), DMARC policy strength, MX provider detection, a DKIM
selector probe, DNSBL listings for the domain's mail IPs, `issues[]` with
severities, and `fixes[]` — copy-paste TXT records that resolve them. Use it
to diagnose your own domains or to audit a domain before migrating it to the
platform.

---

## Other

### Health check
```
GET /health
```
No auth required. Returns `{ "status": "ok" }` when the API is healthy.

---

### OpenAPI spec
```
GET /v1/openapi.json
```
No auth required. Returns the full OpenAPI 3.1 spec. Use with `openapi-generator`, `openapi-typescript`, or any compatible tool to generate a typed client in your language.
