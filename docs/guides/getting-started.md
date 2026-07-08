# Getting started

This guide takes you from zero to a delivered email. It takes about five minutes — plus DNS propagation time.

---

## Before you start

You need:
- An account (see step 1 below)
- A domain you control and can publish DNS records for
- Your DNS provider (Cloudflare, Route53, Namecheap, GoDaddy, etc.) open in another tab

---

## Step 1 — Create your account

```bash
curl -X POST https://api.mailplatform.example/v1/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "you@yourcompany.com", "name": "Acme Inc"}'
```

**Response**
```json
{
  "customer": { "id": "cust_...", "email": "you@yourcompany.com", "tier": "free" },
  "api_key": "mp_live_xxxxxxxxxxxxxxxxxxxxxx",
  "note": "Save this API key — it will not be shown again."
}
```

Store the API key securely — it is only shown once. Set it as an environment variable:

```bash
export MAILPLATFORM_API_KEY="mp_live_xxxxxxxxxxxxxxxxxxxxxx"
```

---

## Step 2 — Add your sending domain

You can only send from an address on a domain you own and have verified. Add it:

```bash
curl -X POST https://api.mailplatform.example/v1/domains \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain": "mail.yourcompany.com"}'
```

The response includes a `dns_records` array. You must publish every record listed:

```json
{
  "domain": {
    "id": "dom_01ABCDEF",
    "dns_records": [
      { "type": "TXT",   "host": "_mailplatform.mail.yourcompany.com", "value": "abc123...",     "purpose": "ownership_verification" },
      { "type": "TXT",   "host": "mail.yourcompany.com",               "value": "v=spf1 include:yourplatform.com ~all", "purpose": "spf" },
      { "type": "TXT",   "host": "default._domainkey.mail.yourcompany.com", "value": "v=DKIM1; k=rsa; p=...", "purpose": "dkim" },
      { "type": "CNAME", "host": "bounces.mail.yourcompany.com",       "value": "bounces.yourplatform.com.", "purpose": "bounce_return_path" }
    ]
  }
}
```

Publish each record at your DNS provider exactly as shown. See [Domain authentication](./dns-setup.md) for detailed per-record instructions and tips for common DNS providers.

---

## Step 3 — Verify the domain

After publishing the DNS records:

```bash
curl -X POST https://api.mailplatform.example/v1/domains/dom_01ABCDEF/verify \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

**Response on success**
```json
{ "status": "verified", "checks": { "ownership": true, "spf": true, "dkim": true } }
```

DNS propagates quickly on most providers (under 5 minutes on Cloudflare, Route53). If verify returns `pending`, wait a minute and try again. See [common DNS mistakes](./dns-setup.md#common-mistakes) if it keeps failing.

---

## Step 4 — Set your physical address

CAN-SPAM requires your physical postal address in every commercial email. Set it before your first live send:

```bash
curl -X PATCH https://api.mailplatform.example/v1/profile \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"physical_address": "123 Main St, Springfield, IL 62701, USA"}'
```

The address is automatically appended to every email footer.

---

## Step 5 — Send your first email

With the domain verified, send from any address on it:

**curl**
```bash
curl -X POST https://api.mailplatform.example/v1/send \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "hello@mail.yourcompany.com",
    "to": "you@example.com",
    "subject": "Hello from the API",
    "html": "<h1>It works</h1><p>Your first email through the platform.</p>",
    "text": "It works. Your first email through the platform."
  }'
```

**Node.js (official SDK)**
```ts
import { MailPlatformClient } from '@platform/sdk';

const mp = new MailPlatformClient({ apiKey: process.env.MAILPLATFORM_API_KEY! });

const result = await mp.messages.send({
  from: 'hello@mail.yourcompany.com',
  to: 'you@example.com',
  subject: 'Hello from the API',
  html: '<h1>It works</h1>',
  text: 'It works.',
});
console.log('Queued:', result.message_ids[0]);
```

**Python**
```python
import os, requests

resp = requests.post(
    "https://api.mailplatform.example/v1/send",
    headers={"Authorization": f"Bearer {os.environ['MAILPLATFORM_API_KEY']}"},
    json={
        "from": "hello@mail.yourcompany.com",
        "to": "you@example.com",
        "subject": "Hello from the API",
        "html": "<h1>It works</h1>",
        "text": "It works.",
    },
)
resp.raise_for_status()
print("Queued:", resp.json()["message_ids"][0])
```

A `202 Accepted` response with `"accepted": 1` means the message is queued. Delivery is asynchronous.

---

## Step 6 — Track what happened

Check the message status:

```bash
curl https://api.mailplatform.example/v1/messages/MSG_ID \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

For real-time delivery notifications, subscribe to [webhooks](./webhooks.md):

```bash
curl -X POST https://api.mailplatform.example/v1/webhooks \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://yourapp.example.com/hooks/mail",
    "events": ["delivered", "hard_bounce", "complaint"]
  }'
```

---

## Next steps

| What you want to do | Guide |
|---|---|
| Reuse email content with variables | [Templates](./templates.md) |
| Send to many recipients at once | [Batch sending](./batch-sending.md) |
| Track opens and clicks | [Open & click tracking](./tracking.md) |
| Receive events in real time | [Webhooks](./webhooks.md) |
| Manage unsubscribes | [Unsubscribe groups](./unsubscribe-groups.md) |
| Improve inbox delivery | [Deliverability](./deliverability.md) |
| Understand error codes | [Errors](./errors.md) |
| Full endpoint reference | [API reference](../api-reference.md) |
