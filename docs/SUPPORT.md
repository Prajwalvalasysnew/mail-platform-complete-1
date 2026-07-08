# Support desk

The support module is a two-sided ticketing system: customers raise and track
tickets from their account; agents work them from the admin plane. It has SLA
tracking, AI triage + suggested replies, canned responses (macros), and CSAT.

Live chat (websockets) is intentionally out of scope here — tickets are the
async backbone a real-time widget would sit on top of.

## Data model

A ticket has `status` (open → pending → resolved → closed), `priority`
(low/normal/high/urgent), `category` (general/billing/deliverability/technical/
abuse/account), an optional assigned agent, threaded messages (customer/agent/
system, with agent-only `internal` notes), SLA timestamps, AI triage fields, and
CSAT fields.

## Customer endpoints (session, `logs:read`, under `/v1`)

```
GET  /v1/support/tickets                 list own tickets
GET  /v1/support/tickets/unread-count
POST /v1/support/tickets                 { subject, body, priority?, category? }
GET  /v1/support/tickets/:id             thread (internal notes hidden)
POST /v1/support/tickets/:id/read
POST /v1/support/tickets/:id/messages    { body }
POST /v1/support/tickets/:id/rate        { rating: 1..5, comment? }   # CSAT, resolved/closed only
```

## Agent endpoints (admin plane, under `/admin`)

```
GET   /admin/support-tickets                 list/filter
GET   /admin/support-tickets/unread-count
POST  /admin/support-tickets                 open on behalf of a customer
GET   /admin/support-tickets/:id             full thread incl. internal notes
POST  /admin/support-tickets/:id/messages    { body, internal? }
PATCH /admin/support-tickets/:id             { status?, priority?, category?, assignedAdminUserId? }
POST  /admin/support-tickets/:id/triage      AI triage (summary, suggested priority/category)
POST  /admin/support-tickets/:id/suggest-reply   AI draft reply (returned, never sent)
GET   /admin/support-tickets/sla-breaches    work queue: tickets past SLA

GET    /admin/support/canned-responses[?category=]
POST   /admin/support/canned-responses       { title, body, category? }
PATCH  /admin/support/canned-responses/:id
DELETE /admin/support/canned-responses/:id   (operator+)
```

## SLA

Due times are derived from priority at creation and re-anchored to creation
time if priority changes:

| Priority | First response | Resolution |
| --- | --- | --- |
| urgent | 1h | 8h |
| high | 4h | 24h |
| normal | 24h | 72h |
| low | 48h | 120h |

`first_responded_at` is stamped on the first non-internal agent reply. A ticket
is **breached** when it is still open/pending and now is past its first-response
due time (and unanswered) or past its resolution due time.
`GET /admin/support-tickets/sla-breaches` returns those tickets, each with an
`sla: { firstResponseBreached, resolutionBreached, breached }` block, ordered by
priority then first-response due time.

## AI assist

`triage` classifies a ticket (summary, suggested priority/category, confidence,
labels) and stores it on the ticket. `suggest-reply` returns an editable draft
grounded in the latest customer message and the ticket category — it is **only
returned to the agent, never posted or sent**. Both run through the
`InferenceProvider` seam; the default is a local heuristic, swappable for a real
LLM via `setInferenceProvider` without touching the routes.

## CSAT

After a ticket is resolved or closed, the owning customer can submit a 1–5
rating with an optional comment via `POST /v1/support/tickets/:id/rate`. Rating
an open ticket returns `409 not_rateable`.
