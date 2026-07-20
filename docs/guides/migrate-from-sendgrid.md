# Migrating from SendGrid

Most SendGrid integrations move over in under an hour. Two paths:

## Path 1 — zero-code cutover (compatibility shim)

Your existing SendGrid v3 client code keeps working. Change two things:

1. **Base URL**: `https://api.sendgrid.com` → `https://api.yourplatform.example`
2. **API key**: your `SG.…` key → a platform key (`mp_live_…`)

```bash
curl -X POST https://api.yourplatform.example/v3/mail/send \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "personalizations": [{ "to": [{ "email": "user@example.com" }] }],
    "from": { "email": "notify@yourcompany.com", "name": "Acme" },
    "subject": "Hello from the other side",
    "content": [{ "type": "text/plain", "value": "Same request body as before." }]
  }'
```

The shim translates the request into the native pipeline, so **all platform
protections apply** — suppressions, quotas, content scanning, rate limits,
domain verification. The response mirrors SendGrid: `202` with an empty body
and an `X-Message-Id` header.

Supported: personalizations (multiple, with per-personalization subjects and
`dynamic_template_data`), `content`, `attachments`, `categories` → tags,
`custom_args` → metadata, `headers`, `send_at`, `reply_to`,
`tracking_settings`, `Idempotency-Key`.

Not supported (the shim returns a clear `400`): SendGrid dynamic template ids
(`d-…`) — recreate the template first (`POST /v1/templates`) and pass its
platform UUID; `asm` group ids — use [unsubscribe groups](./unsubscribe-groups.md);
`cc`/`bcc`.

## Path 2 — native API (recommended endpoint for new code)

Swap `/v3/mail/send` calls for [`POST /v1/send`](../api-reference.md#sending)
— a flatter payload, per-recipient results, idempotency, scheduled sends, the
critical-priority lane, and workflows.

## Migration checklist

1. **Verify your domain here first** — add SPF/DKIM/DMARC records
   (`POST /v1/domains`, then `verify`). Run the
   [domain scanner](../api-reference.md#tools) to confirm before cutover.
2. **Import suppressions** — export your SendGrid suppression lists and bulk
   import them (`POST /v1/suppressions/import`) so opted-out recipients stay
   opted out. This is a compliance requirement, not an optimization.
3. **Recreate templates** — `POST /v1/templates` (Handlebars). Dynamic
   template data maps to `variables`.
4. **Repoint webhooks** — register your endpoint (`POST /v1/webhooks`); event
   payloads cover the same lifecycle (delivered/open/click/bounce/complaint/
   unsubscribe) with HMAC signatures.
5. **Cut over gradually** — keep both keys live and shift traffic; watch
   deliverability in [Activity & Analytics](./activity-analytics.md).
6. **Warm up dedicated IPs** if you're moving high volume — automatic warmup
   schedules apply; see [Deliverability](./deliverability.md).
