# Guides

Task-oriented documentation for integrating with the email platform API.

For the full endpoint-by-endpoint reference, see [API Reference](../api-reference.md).  
For the machine-readable OpenAPI spec, call `GET /v1/openapi.json`.

---

## Getting started

| Guide | What it covers |
|---|---|
| [Getting started](./getting-started.md) | Account → domain → first email in 5 minutes |
| [Authentication](./authentication.md) | API keys, scopes, rotation, security best practices |

## Sending

| Guide | What it covers |
|---|---|
| [Sending email](./sending-email.md) | Send API, parameters, lifecycle, test mode |
| [Batch sending](./batch-sending.md) | Send independent messages to many recipients in one call |
| [Templates](./templates.md) | Create and reuse Handlebars templates with variables |
| [Open & click tracking](./tracking.md) | Tracking pixels, link rewriting, bot detection |

## Delivery & engagement

| Guide | What it covers |
|---|---|
| [Webhooks](./webhooks.md) | Real-time delivery events, event catalog, signature verification |
| [Activity & analytics](./activity-analytics.md) | Message status, event timeline, activity feed |
| [Suppressions](./suppressions.md) | Do-not-email list management, bulk import, CSV export |
| [Unsubscribe groups](./unsubscribe-groups.md) | Topic-level opt-outs, one-click unsubscribe |

## Deliverability & compliance

| Guide | What it covers |
|---|---|
| [Deliverability](./deliverability.md) | Inbox placement, bounce/complaint rates, list hygiene, content |
| [Domain authentication](./dns-setup.md) | SPF, DKIM, DMARC — the DNS records you must publish |

## Account & compliance

| Guide | What it covers |
|---|---|
| [Account & quotas](./account-quotas.md) | Plans, daily/monthly limits, usage monitoring |
| [Privacy & GDPR](./privacy-gdpr.md) | Recipient data deletion and export (Art. 15) |
| [Support](./support.md) | How to get help, SLA, ticket portal |

## Reference

| Guide | What it covers |
|---|---|
| [Errors](./errors.md) | Error envelope, HTTP status codes, stable error codes |
| [Rate limits](./rate-limits.md) | Per-key limits, response headers, backoff |

---

All examples use `https://api.mailplatform.example/v1`. Replace with your deployment's host.
