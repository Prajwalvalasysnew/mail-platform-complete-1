# DNS Setup Guide

Getting DNS right is the difference between mail landing in the inbox and mail
landing in spam (or being rejected entirely). Read this carefully.

There are two DNS configurations you need to handle:

1. **The platform's own DNS** — for the MTAs themselves (you, the operator)
2. **Each customer's sending domain** — automated by `POST /v1/domains`

---

## Part 1: Platform DNS (one-time setup)

These records live on the domain that operates the platform (e.g.,
`yourplatform.com`).

### 1.1 Reverse DNS (PTR) — most critical

For each IP your MTAs send from, request a PTR record from your hosting provider.
The PTR must resolve to a hostname whose forward A record points back to the same IP.

```
# At your hosting provider (Hetzner, OVH, AWS):
1.2.3.4   →  PTR  mta1.yourplatform.com

# Then in your DNS zone:
mta1.yourplatform.com.   A     1.2.3.4
```

Without matching forward and reverse DNS, **Gmail will reject your mail outright**.
This is non-negotiable. Test with:

```bash
dig -x 1.2.3.4 +short          # should return mta1.yourplatform.com
dig mta1.yourplatform.com +short # should return 1.2.3.4
```

### 1.2 Platform SPF

Tell the world which IPs are allowed to send mail claiming to be from your platform.

```
yourplatform.com.   TXT   "v=spf1 ip4:1.2.3.4 ip4:1.2.3.5 -all"
```

Customers reference this with `include:yourplatform.com` in their own SPF.

### 1.3 MX for bounces

The inbound MTA must be reachable on port 25 to receive bounces.

```
bounces.yourplatform.com.   A    1.2.3.4
bounces.yourplatform.com.   MX   10  bounces.yourplatform.com.
```

### 1.4 MX for feedback loops (FBL)

Register this address with ISPs as your complaint-reception endpoint.

```
fbl.yourplatform.com.   A    1.2.3.4
fbl.yourplatform.com.   MX   10  bounces.yourplatform.com.
```

### 1.5 Tracking subdomain

Point at the tracker server (typically behind a load balancer with HTTPS).

```
track.yourplatform.com.   A    1.2.3.6
```

You need a valid TLS certificate here (Let's Encrypt is fine).

### 1.6 Abuse and postmaster mailboxes (RFC 2142)

These must be real, monitored mailboxes:

```
abuse@yourplatform.com
postmaster@yourplatform.com
```

ISPs send abuse reports here. Ignoring these will get you blocklisted.

---

## Part 2: Customer sending domain (per-customer, automated)

When a customer calls `POST /v1/domains`, the API returns the exact records to add.
Here's what each one does.

Assume the customer domain is `send.acme.com` (a subdomain, recommended over the
apex domain).

### 2.1 Ownership verification

```
_mailplatform.send.acme.com.   TXT   "abc123def456..."
```

Proves the customer controls the domain before we'll sign mail with their DKIM key.

### 2.2 SPF

```
send.acme.com.   TXT   "v=spf1 include:yourplatform.com ~all"
```

`~all` (soft fail) is recommended initially; tighten to `-all` (hard fail) once
you're confident no other systems send for this domain.

### 2.3 DKIM

```
default._domainkey.send.acme.com.   TXT   "v=DKIM1; k=rsa; p=MIIBIjANBgkq..."
```

The public key is auto-generated when the domain is added. Some DNS providers
(notably GoDaddy) require splitting long TXT values into 255-char chunks.

### 2.4 DMARC

```
_dmarc.send.acme.com.   TXT   "v=DMARC1; p=none; rua=mailto:dmarc@send.acme.com;"
```

Start with `p=none` to monitor, then move to `p=quarantine`, then `p=reject` over
weeks once you've confirmed all legitimate mail is properly authenticated.

For Gmail/Yahoo bulk sender compliance (≥5000 messages/day to those ISPs),
DMARC is **required**.

### 2.5 Bounce CNAME

```
bounces.send.acme.com.   CNAME   bounces.yourplatform.com.
```

This lets your envelope-from be `bounce+...@bounces.send.acme.com`, which aligns
the return-path with the customer's domain (helps DMARC alignment) while bounces
still arrive at your inbound MTA.

---

## Part 3: Verifying it all works

### SPF check

```bash
dig TXT send.acme.com +short
# "v=spf1 include:yourplatform.com ~all"

# Look up included record:
dig TXT yourplatform.com +short
# "v=spf1 ip4:1.2.3.4 -all"
```

### DKIM check

```bash
dig TXT default._domainkey.send.acme.com +short
# "v=DKIM1; k=rsa; p=MIIBIj..."
```

### DMARC check

```bash
dig TXT _dmarc.send.acme.com +short
# "v=DMARC1; p=none; rua=mailto:dmarc@send.acme.com;"
```

### End-to-end check

Send a test email to `check-auth@verifier.port25.com`. You'll get a reply with
the full authentication results — SPF, DKIM, DMARC all should pass.

Or use Gmail's [Message Source view](https://support.google.com/mail/answer/29436):
look for `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS` in the Authentication-Results
header.

---

## Part 4: Postmaster registrations (do this before serious volume)

These aren't DNS but they unlock reputation data and complaint signals:

| Provider | What to register | URL |
|---|---|---|
| Google | Postmaster Tools (per domain) | https://postmaster.google.com/ |
| Microsoft | SNDS (per IP) + JMRP (per IP) | https://sendersupport.olc.protection.outlook.com/ |
| Yahoo | Complaint Feedback Loop | https://senders.yahooinc.com/ |
| Comcast | Feedback Loop | https://feedback.comcast.net/ |
| La Poste / Orange | Postmaster contact | https://postmaster.laposte.net/ |
| Mail.ru | Postmaster | https://postmaster.mail.ru/ |

Microsoft's JMRP is particularly important — it's how you find out when Outlook
users mark your mail as junk. Without it, you'll just see deliverability silently
degrade.

---

## Part 5: Common DNS mistakes

- **Multiple SPF records on the same hostname** — DNS allows it, SPF doesn't.
  Merge them into one TXT record.
- **DKIM TXT record split incorrectly** — some DNS UIs auto-split long values
  and corrupt the key. Verify with `dig` after adding.
- **CNAME at the apex** — `acme.com CNAME bounces.platform.com` is invalid.
  Always use a subdomain.
- **Trailing dots** — in zone files, FQDN values need a trailing dot
  (`bounces.yourplatform.com.`) or DNS will append the zone origin.
- **Long propagation waits** — most providers update within minutes, but
  Cloudflare and Route53 can take up to an hour. Don't panic.

---

## Part 6: TLS for SMTP (STARTTLS)

In production, your outbound MTA should advertise STARTTLS so encrypted
delivery happens whenever the recipient supports it. Configure in
`packages/haraka-outbound/config/tls.ini`:

```ini
[main]
key=/etc/letsencrypt/live/mta1.yourplatform.com/privkey.pem
cert=/etc/letsencrypt/live/mta1.yourplatform.com/fullchain.pem
```

Let's Encrypt certificates work fine. Renew automatically via certbot.
