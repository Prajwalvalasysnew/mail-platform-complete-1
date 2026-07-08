# Provider failure taxonomy (gap analysis Top-20 #14)

## The gap

Report #14 (score 7.0): "SMTP/SES errors are not classified deeply enough for
ISP-grade retry shaping." The base transport split failures only into
permanent vs transient off a crude `code >= 500` check. But a 421 throttle, a
451 greylist, a 452 mailbox-full, a 550 5.1.1 bad-recipient, and a 550/554
5.7.1 reputation block all need DIFFERENT handling despite overlapping code
classes — retrying a rate-limit like a normal transient makes reputation worse;
treating a reputation block as plain-permanent drops recoverable mail.

## What was built

`packages/shared/src/failure-taxonomy.ts` — pure classification logic:

- `classifyFailure({ code, response, provider })` → `{ category, strategy,
  permanent, suppress, code, enhanced, reason }`. Categories: invalid_recipient,
  mailbox_full, message_too_large, rate_limited, greylisted, reputation_block,
  auth_failure, content_rejected, connection_failure, temporary_failure,
  permanent_failure, unknown. It reads message-pattern intent first (most
  specific), then the RFC-3463 enhanced status (5.1.1 etc.), then the numeric
  SMTP code class, then connection-level signals.
- `retryDelayMs(strategy, attempt)` → per-strategy backoff curves: greylist
  retries fast (1m→15m), standard backoff (1m→2h), rate-limited/reputation
  back off slow (30m→6h), and remediation-needed retries sparingly (1h→12h).

Wired into `transport.ts`: `makeDeliveryError` now attaches
`category`/`strategy`/`suppress`, and derives `permanent` from the taxonomy
(strategy `no_retry`) rather than a blanket 5xx rule — so reputation/auth
blocks are no longer misfiled as plain-permanent.

Wired into `send-worker.ts`: the permanent-failure branch records the category
on the failure event (observability), tags the `messages_blocked` metric by
category, and AUTO-SUPPRESSES only when the taxonomy sets `suppress` (invalid
recipient = hard bounce) — a precise signal instead of "suppress any 5xx".

## Key correctness fix found by testing

The first cut mis-classified `451 4.7.1 Greylisted, please try again later` as
`rate_limited`, because the rate-limit pattern matched "try again later" before
the greylist check ran. Fixed by ordering greylist detection first (it's the
more specific 451/4.7.1 defer). Caught by the unit test asserting the greylist
category.

## Verified how (real infra)

- `npm run build` (all packages): exit 0.
- `failure-taxonomy.test.ts`: 18/18 — real ISP response strings for each
  category, the not-permanent reputation-block improvement, code-from-text
  parsing, and the per-strategy delay curves/caps.
- Full suite: 91 files, 625 tests, 0 failures — the transport + send-worker
  changes (core send path) broke nothing.

## Follow-up (not done here)

Actually feeding `retryDelayMs`/strategy into BullMQ's per-job backoff (instead
of the queue's global backoff) is a worker-scheduling change that benefits from
load testing (#11) to tune the curves against real ISP behavior. The
classification + the recommended curves are in place; wiring them into the
queue's backoff option per category is the remaining integration step.
