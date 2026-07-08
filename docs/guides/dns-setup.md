# Domain authentication (SPF, DKIM, DMARC)

Before you can send from an address, you must verify that you own the domain. This involves publishing a set of DNS records that authenticate your email. Properly authenticated email is essential for inbox delivery — unauthenticated mail is rejected or spam-foldered by Gmail, Outlook, and Yahoo.

---

## Quick setup

1. Add your domain to the API — it returns the exact records to publish.
2. Publish the records at your DNS provider.
3. Call verify. The API checks the records and marks your domain verified.

```bash
# Step 1: Add the domain
curl -X POST https://api.mailplatform.example/v1/domains \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain": "mail.yourcompany.com"}'
```

The response includes a `dns_records` array — publish every record listed before calling verify.

```bash
# Step 2: (publish DNS records at your provider)

# Step 3: Verify
curl -X POST https://api.mailplatform.example/v1/domains/dom_ID/verify \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

DNS propagation typically takes a few minutes but can take up to an hour. Run verify again if it does not pass immediately.

---

## The four DNS records

### 1. Ownership verification (TXT)
Proves you control the domain before we generate signing keys for it.

```
_mailplatform.mail.yourcompany.com.   TXT   "abc123def456..."
```

Once verified, this record can be kept or removed — it is only checked during the initial verification step.

### 2. SPF (TXT)
Authorizes our sending servers to send mail on behalf of your domain. Receiving servers check SPF to verify the sending IP is allowed.

```
mail.yourcompany.com.   TXT   "v=spf1 include:yourplatform.com ~all"
```

`~all` means "soft fail" — mail from unauthorized IPs is delivered but marked. Once you are confident all your mail comes through this platform, you can tighten to `-all` (hard fail).

**Common SPF mistake:** do not create more than one TXT record on the same hostname. If your domain already has an SPF record (e.g. for another email service), merge them into one:

```
"v=spf1 include:yourplatform.com include:sendgrid.net ~all"
```

### 3. DKIM (TXT)
A cryptographic signature that proves the message content wasn't modified in transit and that it was authorized by the domain owner.

```
default._domainkey.mail.yourcompany.com.   TXT   "v=DKIM1; k=rsa; p=MIIBIjAN..."
```

The public key is auto-generated when you add the domain. Some DNS providers (notably GoDaddy) require splitting long TXT values into 255-character chunks separated by quotes:

```
"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA" "nkx6i2P5Wz..."
```

### 4. Bounce return-path (CNAME)
Routes bounced messages back through our inbound MTA so we can parse them and update your suppression list automatically.

```
bounces.mail.yourcompany.com.   CNAME   bounces.yourplatform.com.
```

Without this record, the platform cannot receive delivery status notifications (DSNs) and your bounce handling will be incomplete.

---

## Add DMARC (highly recommended)

DMARC is a policy that tells receiving servers what to do with mail that fails SPF or DKIM. It is **required** by Gmail and Yahoo for senders sending more than 5 000 messages per day, and strongly recommended for all senders.

Publish a DMARC record at `_dmarc.<yourdomain>`:

```
_dmarc.mail.yourcompany.com.   TXT   "v=DMARC1; p=none; rua=mailto:dmarc@mail.yourcompany.com;"
```

**Progression plan** (recommended approach):

| Stage | Policy | When to move |
|---|---|---|
| Monitor | `p=none` | Start here. Receive reports without blocking anything. |
| Quarantine | `p=quarantine` | After 2–4 weeks of clean reports. Unauthenticated mail goes to spam. |
| Reject | `p=reject` | After 2–4 weeks at quarantine with no legitimate mail being affected. |

DMARC aggregate reports (`rua`) are sent to the email address you specify and show you which sources are sending on behalf of your domain. Use a service like Postmark's DMARC Digests, Valimail, or Dmarcly to parse them.

---

## Verifying your records with `dig`

After publishing, verify each record is present:

```bash
# Ownership verification
dig TXT _mailplatform.mail.yourcompany.com +short

# SPF
dig TXT mail.yourcompany.com +short

# DKIM
dig TXT default._domainkey.mail.yourcompany.com +short

# Bounce CNAME
dig CNAME bounces.mail.yourcompany.com +short

# DMARC
dig TXT _dmarc.mail.yourcompany.com +short
```

For an end-to-end authentication check, send a test email to `check-auth@verifier.port25.com`. You will receive an automated reply showing SPF, DKIM, and DMARC results.

---

## Using a subdomain (recommended)

We strongly recommend sending from a subdomain (`mail.yourcompany.com`, `send.yourcompany.com`) rather than your root domain (`yourcompany.com`). Reasons:

- DMARC policy on the subdomain does not affect your root domain's policy.
- A bounce or complaint rate problem on your sending subdomain doesn't directly impact your corporate email reputation.
- You can tighten the DMARC policy on the sending subdomain independently.

---

## Common mistakes

**Multiple SPF records on the same hostname**
DNS allows multiple TXT records on the same name, but SPF processors treat it as an error and may reject all. Merge into one.

**DKIM key truncated by the DNS UI**
Some DNS providers silently truncate long TXT values. Always verify with `dig` after adding a DKIM record — look for the full public key starting with `MIIBIjAN`.

**CNAME at the domain apex**
A CNAME record at the root of your domain (e.g. `yourcompany.com CNAME ...`) is not allowed by DNS standards and breaks your website's A record. Always use a subdomain.

**Not waiting for propagation**
After adding or changing DNS records, allow up to an hour for propagation before calling verify. Cloudflare and Route53 are usually faster (minutes); other providers can take longer.

---

## DKIM key rotation

DKIM private keys are automatically rotated periodically for security. When a rotation occurs:

1. A new key is generated (`pending` status).
2. You are notified to publish the new DKIM record (`rotating._domainkey.yourdomain`).
3. After the new record propagates and you confirm it, the old selector is retired.
4. A 7-day grace period ensures messages signed with the old key continue to verify during the transition.

You can also trigger a manual rotation from the domain management page in your dashboard.
