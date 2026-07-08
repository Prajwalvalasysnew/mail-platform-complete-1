# Webhooks

Webhooks push delivery and engagement events to your server in near real time,
so you don't have to poll. You register one or more HTTPS endpoints and choose
which event types each receives.

## Registering an endpoint

```bash
curl -X POST https://api.mailplatform.example/v1/webhooks \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://yourapp.example.com/hooks/mail",
    "events": ["delivered", "hard_bounce", "complaint"]
  }'
```

The response includes a **signing secret** — store it; you'll use it to verify
incoming requests. The URL must be public and HTTPS; private/loopback/internal
addresses are rejected (SSRF protection).

Manage endpoints with `GET /v1/webhooks`, `DELETE /v1/webhooks/:id`, and (from
the dashboard) secret rotation.

## Event catalog

Subscribe to any subset of these `event_type` values:

| Event | When it fires |
| --- | --- |
| `delivered` | The receiving server accepted the message. |
| `soft_bounce` | Temporary failure (mailbox full, greylisting); will be retried. |
| `hard_bounce` | Permanent failure (no such mailbox); recipient is suppressed. |
| `complaint` | Recipient marked the message as spam; recipient is suppressed. |
| `opened` | The recipient opened the message (requires `tracking_opens`). |
| `clicked` | The recipient clicked a tracked link (requires `tracking_clicks`). |
| `unsubscribed` | The recipient unsubscribed. |

## Payload

Each event is delivered as a `POST` with a JSON body:

```json
{
  "message_id": "a1b2c3@mail.yourcompany.com",
  "event_type": "delivered",
  "occurred_at": "2026-06-07T12:00:00.000Z",
  "smtp_response": "250 2.0.0 OK"
}
```

`message_id`, `event_type`, and `occurred_at` are always present; additional
fields depend on the event (e.g. `smtp_response` on delivery/bounce, the target
`url` on `clicked`). Treat unknown fields as forward-compatible additions.

Request headers:

```
Content-Type: application/json
User-Agent: MailPlatform-Webhooks/1.0
X-MP-Event-Type: delivered
X-MP-Signature: t=1717761600,v1=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

## Verifying the signature

**Always verify** before trusting a webhook. The signature is an HMAC-SHA256
over `"{timestamp}.{raw_request_body}"` using your endpoint's signing secret,
hex-encoded. The `X-MP-Signature` header carries the timestamp (`t=`) and the
signature (`v1=`).

Steps:
1. Read the **raw** request body (do not re-serialize parsed JSON — whitespace
   matters).
2. Parse `t` and `v1` from `X-MP-Signature`.
3. Recompute `HMAC_SHA256(secret, t + "." + rawBody)` and compare to `v1` in
   constant time.
4. Reject if the timestamp is too old (e.g. > 5 minutes) to prevent replay.

**Node (Express)**

```js
const crypto = require('crypto');

function verify(req, secret) {
  const header = req.get('X-MP-Signature') || '';
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // replay window
  const expected = crypto.createHmac('sha256', secret)
    .update(`${t}.${req.rawBody}`)            // req.rawBody = exact bytes received
    .digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Capture the raw body (e.g. express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }))
app.post('/hooks/mail', (req, res) => {
  if (!verify(req, process.env.MP_WEBHOOK_SECRET)) return res.sendStatus(401);
  const event = JSON.parse(req.rawBody);
  // ... handle event.event_type ...
  res.sendStatus(200);
});
```

**Python (Flask)**

```python
import hmac, hashlib, time
from flask import request, abort

def verify(secret: str) -> bool:
    header = request.headers.get("X-MP-Signature", "")
    parts = dict(kv.split("=", 1) for kv in header.split(",") if "=" in kv)
    t, v1 = parts.get("t"), parts.get("v1")
    if not t or not v1 or abs(time.time() - int(t)) > 300:
        return False
    raw = request.get_data()  # exact bytes
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)

@app.post("/hooks/mail")
def hook():
    if not verify(os.environ["MP_WEBHOOK_SECRET"]):
        abort(401)
    event = request.get_json()
    # ... handle event["event_type"] ...
    return "", 200
```

## Delivery semantics

- **Respond fast with 2xx.** Any `2xx` is treated as success. Do minimal work
  inline — enqueue and process asynchronously.
- **Retries.** Non-2xx and timeouts are retried with exponential backoff (up to
  5 attempts by default). After retries are exhausted the delivery is
  dead-lettered.
- **Permanent failures aren't retried.** A `4xx` other than `408`/`429` is
  treated as a permanent rejection and dropped (so a wrong/disabled URL doesn't
  consume the whole retry budget).
- **At-least-once.** Design handlers to be **idempotent** — dedupe on
  (`message_id`, `event_type`, `occurred_at`); the same event may arrive more
  than once.
- **Ordering is not guaranteed.** Use `occurred_at`, not arrival order.
