# Architecture

## Why this shape

A transactional email platform has six fundamentally different workloads, which is
why this project is a monorepo of six services rather than one monolith:

1. **Synchronous request handling** (the API) — must be fast and bounded; can't
   block on SMTP I/O which is unpredictable.
2. **Background sending** (the worker) — long-running, retries, talks to flaky
   external SMTP servers.
3. **SMTP submission and outbound delivery** (Haraka outbound) — needs to be a
   real MTA that speaks SMTP correctly, handles TLS negotiation, retries, and
   per-destination throttling.
4. **Bounce ingestion** (Haraka inbound) — receives mail on port 25 from
   recipient MX servers when delivery fails.
5. **Webhook fan-out** (webhook worker) — fire customer URLs on events; needs
   retries with exponential backoff.
6. **Open/click tracking** (tracker) — must serve tracking pixels in `<50ms` even
   under load; very different latency profile from the API.

Coupling these into one process would mean a slow webhook URL could backlog the
send queue, or a flood of opens could starve the API.

## Data flow: outbound

```
Customer        API           DB           Queue        Worker         Haraka       Internet
  │              │             │             │             │              │             │
  │  POST /send  │             │             │             │              │             │
  ├─────────────▶│             │             │             │              │             │
  │              │ verify domain│             │             │              │             │
  │              ├────────────▶│             │             │              │             │
  │              │ insert msg  │             │             │              │             │
  │              ├────────────▶│             │             │              │             │
  │              │   enqueue   │             │             │              │             │
  │              ├────────────────────────▶  │             │              │             │
  │  202 + ids   │             │             │             │              │             │
  │◀─────────────┤             │             │  pull job   │              │             │
  │              │             │             ├────────────▶│              │             │
  │              │             │             │             │ fetch msg    │             │
  │              │             │◀────────────┼─────────────┤              │             │
  │              │             │             │             │ render+pixels│             │
  │              │             │             │             │              │             │
  │              │             │             │             │ SMTP send    │             │
  │              │             │             │             ├─────────────▶│             │
  │              │             │             │             │              │ DKIM sign   │
  │              │             │             │             │              │ (from DB)   │
  │              │             │             │             │              │             │
  │              │             │             │             │              │ deliver     │
  │              │             │             │             │              ├────────────▶│
```

## Data flow: bounce

```
Recipient MX    Haraka Inbound    Queue        Event Worker    DB              Webhook
     │                │              │              │           │                  │
     │  DSN to VERP   │              │              │           │                  │
     ├───────────────▶│              │              │           │                  │
     │                │ parse DSN    │              │           │                  │
     │                │ extract ID   │              │           │                  │
     │                │              │              │           │                  │
     │                │ enqueue      │              │           │                  │
     │                ├─────────────▶│              │           │                  │
     │                │              │  pull        │           │                  │
     │                │              ├─────────────▶│           │                  │
     │                │              │              │ update msg│                  │
     │                │              │              ├──────────▶│                  │
     │                │              │              │ suppress  │                  │
     │                │              │              ├──────────▶│                  │
     │                │              │              │ enqueue webhook              │
     │                │              │◀─────────────┤           │                  │
     │                │              │                          │                  │
     │                │              │ webhook worker fires     │ POST signed body │
     │                │              │                          ├─────────────────▶│
```

## Queue design

Three BullMQ queues, all backed by the same Redis:

- **`send`** — one job per message. Priority by customer tier (enterprise=1, paid=5, free=10).
  Retries 5 times with exponential backoff (1m, 2m, 4m, 8m, 16m). Soft failures
  (4xx SMTP) re-throw to BullMQ for retry; hard failures (5xx) mark the message
  failed and complete the job.
- **`events`** — events from Haraka and the tracker. Updates DB state, manages
  suppression list, fans out to webhooks.
- **`webhooks`** — one job per (event, subscribed-webhook). Retries 5 times.

## Suppression list (the hot path)

Every send checks suppression before queueing. To keep this fast:

1. **Redis cache** with 1-hour TTL — `supp:{customer_id}:{email}` → `1` or `0`
2. **Postgres** is the source of truth — primary key on `(customer_id, email)`
3. **Write-through** — adding/removing updates both cache and DB

Per-customer suppression means one customer's hard bounce doesn't suppress that
address for everyone (intentional — different customers, different consent).

## DKIM signing

Each verified sending domain has its own RSA keypair. When the worker submits to
Haraka, it includes an `X-MP-Customer-ID` header. Haraka's `customer_dkim` plugin:

1. Reads the customer ID + from-domain from the message
2. Queries `sending_domains` for the matching `dkim_private_key`
3. Signs with `c=relaxed/simple`, including headers: From, To, Subject, Date,
   Message-ID, Reply-To, List-Unsubscribe
4. Adds the `DKIM-Signature` header before queueing for outbound delivery

The `header_cleanup` plugin then strips the `X-MP-*` internal headers so they
never appear in delivered mail.

## VERP for bounce attribution

The envelope-from (return-path) is set to:

```
bounce+<encoded-message-id>@bounces.yourdomain.com
```

Where `<encoded-message-id>` is the Message-ID with `@` replaced by `=`. When the
DSN arrives back at Haraka inbound, the original Message-ID is extracted directly
from the RCPT TO of the bounce — no need to parse the DSN body to identify the
original message.

## Tracking implementation

**Opens** — `<img src="https://track.yourdomain.com/o/<base64url-message-id>">`
The tracker server returns a 1x1 transparent GIF with no-cache headers and fires
an event asynchronously.

**Clicks** — Links in HTML are rewritten to:
`https://track.yourdomain.com/c/<base64url-message-id>/<link-uuid>`
The tracker looks up the original URL in `tracked_links` table and 302-redirects.

**Unsubscribe** — `https://track.yourdomain.com/u/<base64url-message-id>` with
RFC 8058 one-click POST support (required by Gmail/Yahoo bulk sender rules since
Feb 2024).

## Database choices

- **Postgres** for everything in this skeleton. In production, you'll want to
  move the high-volume `events` table to ClickHouse or another columnar/timeseries
  store. The current schema indexes `events` by `(customer_id, occurred_at)` which
  works fine up to ~50M rows, then becomes a problem.
- **Redis** for queues (BullMQ), suppression cache, and rate limiting.
- **No object storage in this version** — message bodies live in Postgres. For
  high volume, move HTML/text bodies to S3 and reference by URL.

## Scaling each component

| Component | Bottleneck | How to scale |
|---|---|---|
| API | CPU (validation, bcrypt) | Horizontal — stateless |
| Worker (send) | SMTP throughput to Haraka | Horizontal + per-IP-pool routing |
| Worker (events) | Postgres writes | Batched inserts, partition events table |
| Worker (webhooks) | Customer URL latency | Horizontal, per-customer concurrency limit |
| Tracker | Request rate | Horizontal — stateless, async events |
| Haraka outbound | Outbound SMTP connections, IP reputation | More IPs, more nodes, per-ISP throttling |
| Haraka inbound | Inbound rate from MX servers | Rarely the bottleneck |
| Postgres | Writes to `events`, `messages` | Read replicas, eventual ClickHouse migration |
| Redis | Memory + ops/sec | Cluster, separate suppression cache from queue |

## Why Haraka and not Postfix

- **Plugin model in Node** — same language as the rest of the stack
- **Programmatic access to mail in flight** — can sign, transform, route, throttle
  using customer-specific logic from Postgres
- **Modern config** — JSON/INI rather than Postfix's main.cf complexity
- **Active community** — used in production by several email providers

Tradeoff: Postfix is faster per-CPU and more battle-tested. For volumes above
~10M messages/day per node, you'd seriously consider Postfix.
