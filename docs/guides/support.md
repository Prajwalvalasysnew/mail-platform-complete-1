# Getting help & support

---

## Support channels

### Support ticket portal

Submit tickets from your account dashboard or via the API. A support ticket is the right channel for:

- Deliverability issues (low inbox rates, blocklisting, reputation drops)
- API errors you cannot resolve from this documentation
- Billing and account management questions
- Abuse reports about mail you have received

```bash
# Create a ticket
curl -X POST https://api.mailplatform.example/v1/support/tickets \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "Messages to Gmail landing in spam folder",
    "body": "Since yesterday our Gmail delivery rate dropped from ~95% to ~40%. No recent content changes. SPF/DKIM/DMARC all passing. Can you help investigate?",
    "priority": "high",
    "category": "deliverability"
  }'
```

**Categories**

| Category | Use for |
|---|---|
| `general` | General questions |
| `billing` | Subscription, invoicing, plan changes |
| `deliverability` | Inbox placement, bounce rates, blocklisting |
| `technical` | API errors, integration issues, SDK questions |
| `abuse` | Reporting abuse or spam received |
| `account` | Account access, user management, API keys |

---

## Support SLA

Response and resolution targets by priority:

| Priority | First response | Resolution target |
|---|---|---|
| `urgent` | 1 hour | 8 hours |
| `high` | 4 hours | 24 hours |
| `normal` | 24 hours | 72 hours |
| `low` | 48 hours | 5 days |

SLA clock starts when the ticket is received. Business hours apply to `normal` and `low` tickets. `urgent` and `high` are handled around the clock.

Set priority based on actual impact:
- **Urgent** — complete sending outage, security incident, data breach.
- **High** — significantly degraded delivery or a critical integration broken in production.
- **Normal** — degraded but functional, or a non-critical issue.
- **Low** — questions, configuration guidance, minor improvements.

---

## Managing your tickets

```bash
# List all your tickets
curl https://api.mailplatform.example/v1/support/tickets \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"

# Get a ticket + its full message thread
curl https://api.mailplatform.example/v1/support/tickets/tkt_ID \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"

# Reply to a ticket
curl -X POST https://api.mailplatform.example/v1/support/tickets/tkt_ID/messages \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "body": "Additional information: the issue started at 14:00 UTC on June 8th." }'

# Rate a resolved ticket (1–5)
curl -X POST https://api.mailplatform.example/v1/support/tickets/tkt_ID/rate \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "rating": 5, "comment": "Quick and thorough resolution, thank you." }'
```

---

## Tips for faster resolution

**Always include:**
- The **request_id** from any error response (it pinpoints the request in our logs immediately).
- The **message_id** if the issue is about a specific email.
- The **time range** when the issue occurred.
- Your **sending domain** and (for deliverability issues) the recipient domains affected.

**For deliverability issues:**
- Share the `Authentication-Results` header from a sample email that landed in spam (available via "Show original" or "View message source" in most email clients).
- Include your recent bounce rate and complaint rate from `GET /v1/usage`.
- Note any recent changes to your sending volume, content, or list composition.

**For API errors:**
- Include the full request (sanitize any secrets), the HTTP status code, the `error` code, and the `request_id`.

---

## Self-service resources

Before opening a ticket, these resources resolve most common questions:

| Issue | Resource |
|---|---|
| Domain not verifying | [DNS setup guide](./dns-setup.md) |
| Low inbox rates | [Deliverability guide](./deliverability.md) |
| `429` quota errors | [Account & quotas guide](./account-quotas.md) |
| Webhook not receiving events | [Webhooks guide](./webhooks.md) |
| Error codes | [Errors reference](./errors.md) |
| GDPR deletion or export | [Privacy & GDPR guide](./privacy-gdpr.md) |
| Full endpoint reference | [API reference](../api-reference.md) |

---

## Status page

Check the real-time status of the API, delivery infrastructure, and tracking services at the status page. Subscribe to incident notifications to be informed of any outages before they affect your application.
