# Workflows (Automation)

Workflows are multi-step, per-recipient journeys: "when someone signs up, wait
a day, send the welcome email; if they don't open it within two days, notify
my app." You define the journey once, publish it, and the platform runs every
recipient through it — with delays, branching on engagement, A/B splits,
template sends, and signed webhooks.

Everything below is available via the REST API with the `workflows` key scope.
(The visual builder in the dashboard produces the same JSON definitions.)

## Anatomy of a workflow

A workflow definition is a graph of **steps** entered from a single
**trigger**:

```json
{
  "trigger": { "type": "api" },
  "entry_step_id": "wait1",
  "steps": [
    { "id": "wait1", "type": "delay", "duration_seconds": 86400, "next": "opened" },
    {
      "id": "opened", "type": "wait_for_event",
      "event_types": ["opened"], "timeout_seconds": 172800, "scope": "run",
      "on_event": "congrats", "on_timeout": "nudge"
    },
    { "id": "congrats", "type": "send_email",
      "template_id": "e6f9…", "from": "hello@yourcompany.com", "next": "end" },
    { "id": "nudge", "type": "webhook",
      "url": "https://yourapp.example.com/hooks/nudge", "next": "end" },
    { "id": "end", "type": "exit" }
  ],
  "goal": { "event_type": "clicked", "exit_on_goal": true },
  "settings": { "allow_reentry": true, "reentry_cooldown_seconds": 604800 }
}
```

### Triggers

| Trigger | Starts a run when… |
|---|---|
| `{ "type": "api" }` | You call `POST /v1/workflows/:id/trigger` (from your app, CRM, signup flow, …) |
| `{ "type": "event", "event_type": "delivered" }` | A matching engagement event occurs for a recipient (`delivered`, `opened`, `clicked`, `soft_bounce`, `hard_bounce`, `complaint`, `unsubscribed`), with optional `filters` rules |

### Step types

| Step | What it does |
|---|---|
| `delay` | Wait a duration; optional `deliver_window` (`{"start_hour": 9, "end_hour": 17}`, UTC) shifts the wake-up into working hours |
| `condition` | If/else over `trigger.*`, `context.*`, or `subject.email` with `eq / neq / contains / gt / lt / in / exists …` operators |
| `wait_for_event` | Park until the recipient opens/clicks (yes branch) or a timeout passes (no branch). `scope: "run"` counts only emails this journey sent; `"any"` counts any activity |
| `split` | A/B percentage split (`percent_a`) — assignment is stable per run |
| `send_email` | Send one of your [templates](./templates.md), personalized with `{{subject.email}}`, `{{trigger.*}}`, and `{{context.*}}` |
| `webhook` | Signed JSON POST to your endpoint (see below) |
| `suppress` | Add or remove the recipient on your [suppression list](./suppressions.md) |
| `goal` | Record conversion at this point in the journey |
| `exit` | End the journey |

### Safety defaults you get for free

- **Auto-exit**: a recipient who unsubscribes or complains is immediately
  pulled out of every in-flight journey (`settings.exit_on_events`, default
  `["unsubscribed", "complaint"]`).
- **Suppression-aware sends**: `send_email` silently skips suppressed
  recipients — the run continues, nothing is delivered, and the run log
  records why.
- **One journey per recipient**: a recipient can never be in the same
  workflow twice at once. Re-entry after completion is off by default; enable
  `allow_reentry` (optionally with a cooldown) to change that.
- **Exactly-once sends**: retries and infrastructure failures can never
  double-send a step's email.

## Create → publish → run

```bash
# 1. Create (drafts can be incomplete while you build)
curl -X POST https://api.mailplatform.example/v1/workflows \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Welcome series", "definition": { …definition above… } }'

# 2. Publish — strict validation + an immutable version snapshot
curl -X POST https://api.mailplatform.example/v1/workflows/$WF_ID/publish \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"

# 3. Enroll a recipient
curl -X POST https://api.mailplatform.example/v1/workflows/$WF_ID/trigger \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Idempotency-Key: signup-42" \
  -H "Content-Type: application/json" \
  -d '{ "subject_email": "user@example.com", "context": { "plan": "pro", "name": "Sam" } }'
```

Publishing snapshots the definition as an immutable **version**; recipients
already mid-journey keep executing the version they started on. Edit the
draft freely and republish when ready — `GET /v1/workflows/:id/versions`
lists the history and `POST …/versions/:v/restore` brings any version back
into the draft.

`Idempotency-Key` makes enrollment retries safe: the same key replays the
original response instead of enrolling the recipient twice.

### Bulk enrollment

Enroll up to 1,000 recipients in one call — with per-recipient results:

```bash
curl -X POST https://api.mailplatform.example/v1/workflows/$WF_ID/trigger/bulk \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "context": { "cohort": "2026-07" },
    "subjects": [
      { "email": "a@example.com", "context": { "seat": 1 } },
      { "email": "b@example.com" }
    ]
  }'
```

```json
{
  "started": 1,
  "total": 2,
  "results": [
    { "email": "a@example.com", "started": true, "run_id": "…" },
    { "email": "b@example.com", "started": false, "skipped_reason": "already_active" }
  ]
}
```

`skipped_reason` values: `already_active`, `reentry_blocked`,
`reentry_cooldown`, `capacity`, `workflow_not_active`.

## Test before you ship

Validate a definition without saving, and dry-run it with a hypothetical
recipient — no emails, no webhooks, no side effects:

```bash
curl -X POST https://api.mailplatform.example/v1/workflows/$WF_ID/simulate \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "subject_email": "test@example.com", "event_outcomes": { "opened": false } }'
```

The response traces the exact path — which branch each condition took, what
each step would have done, and the total virtual time elapsed. Use
`event_outcomes` / `split_outcomes` to force specific branches.

## Workflow webhooks (the `webhook` step)

Webhook steps POST JSON to your endpoint with an HMAC signature:

```
X-Workflow-Delivery:  <unique delivery id — dedupe on this>
X-Workflow-Timestamp: <unix seconds>
X-Workflow-Signature: v1=<hex hmac-sha256 of "<timestamp>.<raw body>">
```

Fetch your signing secret once from `GET /v1/workflows/signing-secret` and
verify like this:

```js
const crypto = require('node:crypto');
const expected = 'v1=' + crypto
  .createHmac('sha256', SIGNING_SECRET)
  .update(`${req.headers['x-workflow-timestamp']}.${rawBody}`)
  .digest('hex');
const ok = crypto.timingSafeEqual(
  Buffer.from(expected), Buffer.from(req.headers['x-workflow-signature']));
```

Return a 2xx quickly. Timeouts and 5xx responses are retried on a bounded
schedule; 4xx responses are treated as permanent and the step fails through
to its next edge (visible in the run log).

## Monitor journeys

```bash
# Runs for a workflow (filter by status or recipient)
GET /v1/workflows/:id/runs?status=waiting_event

# One run with its full step-by-step log
GET /v1/workflows/runs/:runId

# Cancel an in-flight run
POST /v1/workflows/runs/:runId/cancel

# Aggregates: run counts, goal attainment, per-step counters, daily trend
GET /v1/workflows/:id/stats?days=30
```

Run statuses: `running`, `waiting_delay`, `waiting_event`, `completed`,
`goal_met`, `exited`, `failed`, `canceled`.

Lifecycle: `POST …/pause` stops **new** entries (in-flight runs continue and
auto-exit rules still apply); `POST …/resume` reopens entry; `DELETE
/v1/workflows/:id` archives — no new entries **and** in-flight runs are
canceled.

## Limits

| Limit | Default |
|---|---|
| Steps per definition | 100 |
| Steps executed per run | 200 |
| Max delay / wait timeout | 90 days |
| Bulk enrollment batch | 1,000 subjects |
| Trigger rate | 600/min (single), 60/min (bulk) |
| Definition size | 256 KB |

Sends from workflows count against your normal [quotas](./account-quotas.md);
if quota is exhausted mid-journey the run waits and retries hourly instead of
failing.
