# DMARC Monitoring

DMARC tells receiving servers what to do with mail that fails authentication
as your domain — and, crucially, sends you daily **aggregate reports** listing
every source sending as you and whether it passed. Those reports are XML that
piles up unread in a mailbox. This turns them into an answer: **who is sending
as your domain, and is it authenticated?**

It's the natural next step after the [domain scanner](../api-reference.md#tools)
(which finds the problem) and [DKIM setup](./dns-setup.md) (which fixes
authentication): monitoring *proves* your mail is aligned and lets you move
safely from `p=none` to `p=reject` without blocking your own legitimate senders.

## 1. Get your reporting address

```bash
curl https://api.yourplatform.example/v1/dmarc/reporting-address \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

```json
{
  "rua_address": "dmarc_x8Kq2f9A@dmarc.yourplatform.example",
  "dns_hint": "v=DMARC1; p=none; rua=mailto:dmarc_x8Kq2f9A@dmarc.yourplatform.example"
}
```

## 2. Publish it in DNS

Add (or update) the `_dmarc` TXT record for your domain to include the
`rua=` address. Start at **`p=none`** — monitoring only, nothing is blocked:

```
_dmarc.yourdomain.com   TXT   "v=DMARC1; p=none; rua=mailto:dmarc_x8Kq2f9A@dmarc.yourplatform.example"
```

Receivers (Gmail, Yahoo, Microsoft, …) begin mailing daily aggregate reports
to that address within ~24 hours. (You can also POST reports directly to
`/v1/dmarc/reports` if you already collect them elsewhere — raw XML, `.xml.gz`,
or `.zip`.)

## 3. See who's sending as you

```bash
# Pass-rate + disposition summary
curl "https://api.yourplatform.example/v1/dmarc/summary?days=30" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"

# Per-source-IP breakdown — spoofers / misconfigured senders first
curl "https://api.yourplatform.example/v1/dmarc/sources?days=30" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

`sources` returns each sending IP with its message volume, how many aligned
(passed DMARC), the pass rate, and a `likely_spoof` flag for sources with real
volume that **never** authenticate — the rows to investigate before you
enforce. A source might be:

- **A forgotten legitimate sender** (an old marketing tool, a billing system,
  a CRM) → add it to your SPF record or set up DKIM for it, then re-check.
- **An actual spoofer** → this is exactly what DMARC enforcement will stop.

## 4. Move to enforcement

Once `sources` shows every legitimate sender aligned and nothing important is
failing:

1. `p=quarantine` — failing mail goes to spam instead of the inbox.
2. `p=reject` — failing mail is refused outright.

Advance one step at a time, watching the reports after each change. The
scanner's `remediation` output walks you through this same staged path.

## Why it matters

For institutions the whole point is **brand protection** — stopping attackers
from sending phishing and fake invoices as your domain — and satisfying the
Gmail/Yahoo bulk-sender rules that now require DMARC. Monitoring is what makes
the move to `p=reject` safe instead of a gamble that silently blocks your own
mail.
