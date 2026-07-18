# Mail Platform Documentation

Welcome. This is everything you need to integrate, send, and manage transactional email through the API.

## Get started in 5 minutes

→ **[Getting started](./guides/getting-started.md)** — API key → verified domain → first email.

---

## Guides

Task-oriented walkthroughs for every major feature.

| Topic | What it covers |
|---|---|
| [Getting started](./guides/getting-started.md) | First email in under 5 minutes |
| [Authentication](./guides/authentication.md) | API keys, scopes, rotating credentials |
| [Sending email](./guides/sending-email.md) | Send API, parameters, message lifecycle |
| [Batch sending](./guides/batch-sending.md) | Send to many recipients in one call |
| [Templates](./guides/templates.md) | Create and reuse Handlebars templates |
| [Workflows](./guides/workflows.md) | Multi-step automation journeys with delays, branching, and goals |
| [Open & click tracking](./guides/tracking.md) | Tracking pixels, link rewriting, bot detection |
| [Webhooks](./guides/webhooks.md) | Real-time delivery events pushed to your server |
| [Suppressions](./guides/suppressions.md) | Manage your do-not-email list |
| [Unsubscribe groups](./guides/unsubscribe-groups.md) | Topic-level opt-outs and one-click unsubscribe |
| [Deliverability](./guides/deliverability.md) | Getting to the inbox — authentication, warmup, reputation |
| [Domain authentication](./guides/dns-setup.md) | SPF, DKIM, DMARC records for your sending domain |
| [Activity & analytics](./guides/activity-analytics.md) | Message status, event timeline, activity feed |
| [Account & quotas](./guides/account-quotas.md) | Plans, daily/monthly limits, usage |
| [Privacy & GDPR](./guides/privacy-gdpr.md) | Recipient data deletion and export |
| [Support](./guides/support.md) | How to contact support, SLA, ticket portal |
| [Errors](./guides/errors.md) | Error envelope, status codes, stable error codes |
| [Rate limits](./guides/rate-limits.md) | Per-key limits, headers, backoff |

---

## API reference

Full endpoint-by-endpoint reference: **[API Reference](./api-reference.md)**

Machine-readable OpenAPI 3.1 spec: `GET https://api.mailplatform.example/v1/openapi.json`

---

## SDKs

| Language | Package | Notes |
|---|---|---|
| Node.js / TypeScript | `@platform/sdk` | Official. Dependency-free, fully typed. |
| Python, Go, PHP, Ruby, Java | Generated from OpenAPI | Use the spec at `/v1/openapi.json` with `openapi-generator`. |

→ **[SDK reference](./SDK.md)**

---

## Key concepts

**Sending is asynchronous.** `POST /v1/send` returns `202 Accepted` when the message is queued, not when it is delivered. Follow status changes via [webhooks](./guides/webhooks.md) or by polling `GET /v1/messages/:id`.

**Suppressions are global per account.** Hard bounces and spam complaints are automatically suppressed — future sends to those recipients are silently skipped to protect your reputation. See [suppressions](./guides/suppressions.md).

**Sending domains must be verified.** The `from` address must be on a domain you own and have published DNS records for. See [domain authentication](./guides/dns-setup.md).

**Test mode is free.** API keys prefixed `mp_test_` run the full send pipeline — quota, content scanning, tracking, suppression — but never deliver to real recipients and never affect your sender reputation. Use them in CI and staging environments.

---

## Base URL

All API endpoints are relative to:

```
https://api.mailplatform.example/v1
```

Replace `api.mailplatform.example` with your deployment's hostname.
