# Deliverability

Deliverability is whether your email reaches the inbox rather than spam. The platform handles the technical infrastructure (DKIM signing, bounce processing, IP reputation monitoring), but your sending practices have the biggest impact on whether you reach the inbox.

---

## The inbox placement factors

Receiving servers (Gmail, Outlook, Yahoo) evaluate several signals:

1. **Authentication** — Does the message pass SPF, DKIM, and DMARC? Unauthenticated mail is penalized heavily.
2. **Sender reputation** — What is the historical bounce rate, complaint rate, and engagement rate for this IP and domain?
3. **Content** — Does the email look like spam? Certain patterns (urgent financial offers, all-caps subject lines, excessive links) trigger content filters.
4. **Recipient engagement** — Are people opening, clicking, and replying? Low engagement signals irrelevance.
5. **List hygiene** — Is the sending list full of valid, opted-in addresses?

---

## 1. Authenticate your domain

This is non-negotiable. Every message you send must pass SPF, DKIM, and DMARC.

→ Full instructions: [Domain authentication](./dns-setup.md)

The summary:
- **SPF** — publish an include record for our servers.
- **DKIM** — publish the auto-generated public key.
- **DMARC** — start at `p=none`, monitor reports for 2–4 weeks, advance to `quarantine`, then `reject`.

Gmail and Yahoo require DMARC for anyone sending more than 5 000 messages per day to their users. Without DMARC at `p=reject` or `p=quarantine`, bulk mail to those domains risks the spam folder.

---

## 2. Warm up new sending identities

If your sending domain or the IPs behind it are new, you must warm up gradually. Receiving mail servers assign low trust to new senders and set tight hourly limits. Sending too much too fast before you have a reputation causes deferrals and eventual blocklisting.

**Warmup approach:**
- Week 1: 500–1 000 messages/day.
- Week 2: 2 000–5 000/day.
- Week 3: 10 000–25 000/day.
- Week 4+: scale based on engagement.

Start with your **most engaged recipients** — people who regularly open and click. High early engagement teaches ISPs that your mail is wanted.

The platform's IP warmup system manages this for the shared IP pool automatically. On dedicated IPs, your warmup schedule depends on your sending volume.

---

## 3. Keep your bounce rate below 2%

A **hard bounce** means the address is permanently undeliverable. Hard bounces are added to your suppression list automatically. The most harmful thing you can do is try to re-send to bounced addresses.

Your **bounce rate** = (hard bounces) / (sent) in a given period. The platform monitors this:

- Above **5%** — sending is throttled automatically to protect your reputation.
- Above **10%** — sending is paused. Contact support to review and resume.

**Preventing high bounce rates:**
- Only send to addresses that opted in and were confirmed (double opt-in is safest).
- Validate email addresses at the point of collection (`@` present, domain resolves, no obvious typos).
- Never purchase, rent, or scrape email lists.
- Remove addresses that have soft-bounced multiple times over several days.

---

## 4. Keep your complaint rate below 0.1%

A **complaint** happens when a recipient clicks "This is spam" in Gmail, Outlook, or Yahoo. ISPs send these reports to us via Feedback Loops. Complained addresses are suppressed automatically.

Your **complaint rate** = (complaints) / (sent). Industry thresholds:

- Gmail begins penalizing senders above **0.1%**.
- Above **0.3%** — Gmail rejects a significant fraction of your mail.

**Preventing complaints:**
- Only send to people who explicitly opted in. "We thought they'd be interested" is not opt-in.
- Make unsubscribing easy. A buried unsubscribe link causes people to use the spam button instead.
- Match the content to what people signed up for.
- Don't send to old lists (>12 months since last send) without a re-permission campaign first.
- Segment your list and suppress inactive recipients (no opens or clicks in 6 months).

---

## 5. Use the unsubscribe link and one-click unsubscribe

Every marketing email must include an unsubscribe link. The platform:
- Adds `List-Unsubscribe` and `List-Unsubscribe-Post` headers automatically when `unsubscribe_group_id` is set.
- Handles the one-click POST (RFC 8058) required by Gmail for bulk senders.
- Processes the opt-out and suppresses the recipient before the next send.

→ See [Unsubscribe groups](./unsubscribe-groups.md) for topic-scoped unsubscribes.

---

## 6. Maintain list hygiene

| Practice | Impact |
|---|---|
| Double opt-in | Dramatically reduces bounces and complaints. |
| Removing chronic non-openers | Improves overall engagement rate, which helps placement. |
| Never importing purchased/scraped lists | Avoids spam traps and instant reputation damage. |
| Re-permission old lists | Reactivates legitimate subscribers; purges the rest. |

**Spam traps** are addresses maintained by ISPs and blocklist operators to catch senders who use unverified lists. Hitting a spam trap causes immediate blocklisting. They appear in purchased lists, very old lists, and scraped data.

---

## 7. Monitor your reputation

The platform monitors your reputation automatically:

- **Bounce and complaint rates** are tracked per sending pool. If thresholds are exceeded, sending is throttled or paused automatically and you are notified.
- **Blocklist monitoring** checks your sending IPs against major DNSBLs (Spamhaus, SpamCop, Barracuda, SORBS) every 6 hours.
- **Google Postmaster Tools and Microsoft SNDS** provide ISP-level data on domain reputation, IP reputation, and spam rates. Connect these tools to the platform to feed that data into your monitoring.

**To connect Google Postmaster Tools:**
1. Go to [postmaster.google.com](https://postmaster.google.com) and add your sending domain.
2. Publish the TXT verification record Google provides.
3. Contact support to connect the data feed to your platform account.

---

## 8. Content best practices

Content filters are not a single rule — they are machine-learning models trained on billions of emails. But there are patterns that consistently hurt placement:

**Avoid:**
- "Free", "guaranteed", "act now", "limited time offer" in the subject line.
- Subject lines in ALL CAPS.
- Using `@yahoo.com`, `@gmail.com`, etc. as the `from` address. Always send from your own domain.
- A very high image-to-text ratio. Spam filters need text to analyze.
- Links to URL shorteners. Use your actual domain.
- Broken HTML or missing `text` body when `html` is provided.
- Misleading or deceptive subject lines (also illegal under CAN-SPAM).

**Do:**
- Include both HTML and plain-text versions.
- Keep the unsubscribe link prominent.
- Use a consistent sender name and `from` address your recipients recognize.
- Keep the email focused — one primary call to action.
- Test your content with a tool like [Mail Tester](https://www.mail-tester.com) before a large send.

---

## 9. Review and testing

Before a significant send:

1. **Test with a real inbox.** Send to an actual Gmail, Outlook, and Yahoo address you control. Check placement and render quality.
2. **Check authentication.** Send to `check-auth@verifier.port25.com` for a full authentication report.
3. **Score your content.** Use [Mail Tester](https://www.mail-tester.com) to get a spam score before sending.
4. **Use test-mode first.** Send with a `mp_test_...` key to verify rendering, template variables, and tracking — without delivering to real recipients.

---

## Suppression list management

The platform automatically adds hard bounces and complaints to your suppression list. You can also manage it manually:

```bash
# See who's suppressed
curl "https://api.mailplatform.example/v1/suppressions?limit=100" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"

# Add a suppression
curl -X POST https://api.mailplatform.example/v1/suppressions \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "reason": "unsubscribe"}'
```

→ Full suppression management: [Suppressions guide](./suppressions.md)
