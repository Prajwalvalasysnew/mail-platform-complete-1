# SMTP Relay (Smart Host)

Anything that speaks SMTP can send through the platform — ERP and billing
systems, scan-to-email devices, CCTV/IoT alert senders, VoIP
voicemail-to-email, monitoring tools, or a self-hosted mail server using the
platform as its outbound **smart host**. No code changes: point the device at
the relay, authenticate, done.

Every relayed message goes through the **same pipeline as the API**:
suppression screening, quotas, content scanning, DKIM signing, delivery
events, webhooks, and analytics.

## Settings

| Setting | Value |
|---|---|
| Server | `smtp.yourplatform.example` |
| Port | `587` (STARTTLS) |
| Username | `apikey` (any value is accepted) |
| Password | an API key with the `send` or `smtp` scope |
| From address | must be on one of your **verified sending domains** |

Create a dedicated relay credential so you can revoke it independently:

```bash
curl -X POST https://api.yourplatform.example/v1/account/api-keys \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "erp-relay", "scopes": ["smtp"] }'
```

The `smtp` scope can *only* submit mail over the relay — if the credential
leaks from a device, it cannot read messages, change domains, or touch
anything else on your account.

## Examples

**Postfix smart host** (`main.cf`):

```
relayhost = [smtp.yourplatform.example]:587
smtp_sasl_auth_enable = yes
smtp_sasl_password_maps = static:apikey:mp_live_xxxxxxxxxxxx
smtp_sasl_security_options = noanonymous
smtp_tls_security_level = encrypt
```

**Any device UI**: SMTP host `smtp.yourplatform.example`, port `587`,
STARTTLS on, username `apikey`, password = your key.

## Behavior details

- **Verified senders only** — `MAIL FROM` on an unregistered/unverified
  domain is rejected at the envelope stage (`550`), before the message body
  is transmitted.
- **Suppressions are honored** — suppressed recipients are silently skipped
  (the server reply tells you how many), everything else delivers. Your
  do-not-email list applies to machine mail too.
- **Quotas apply** — exceeding your daily/monthly quota returns a `452`
  temporary failure, so well-behaved senders retry later automatically.
- **Attachments** — same rules as the API: 5 MB per file, 7 MB per message,
  executable types rejected.
- **Limits** — up to 100 recipients per message, 15 MB raw message size;
  repeated authentication failures lock the source IP out temporarily.
  Global connections, connections per source IP, messages per connection, and
  per-account messages per minute are also bounded. A `421` or `452` response
  is temporary; retry with exponential backoff.
- **Tracking** — relay mail is machine-generated, so open/click tracking
  pixels and link rewriting are **not** applied.
- Messages appear in [Activity](./activity-analytics.md) tagged `smtp`, and
  delivery/bounce [webhooks](./webhooks.md) fire exactly as for API sends.
