# Workflow Automation Engine

Enterprise-grade workflow automations (the backend for the visual "Automation
builder"): multi-step journeys per recipient with delays, engagement-based
branching, template sends, signed webhooks, suppression actions, goals,
immutable version history, and durable, exactly-once execution.

## Concepts

| Concept | Table | Notes |
|---|---|---|
| Workflow | `workflows` | Container + lifecycle: `draft → active ⇄ paused → archived`. The **draft definition** is the working copy the builder edits. |
| Version | `workflow_versions` | Append-only snapshots created by publish. Runs always execute a snapshot, never the draft. |
| Run | `workflow_runs` | One journey per subject (recipient email) through a published version. Durable state machine. |
| Step log | `workflow_run_steps` | Per-run execution ledger (audit trail + idempotency). |
| Step stats | `workflow_step_stats` | Per (version, step) entered/completed/failed counters for builder overlays. |

All five tables carry fail-closed tenant RLS (migration 068), matching the
platform posture from migration 043.

## Definition model

A definition is a validated DAG (`packages/shared/src/workflow-definition.ts`):

```jsonc
{
  "trigger": { "type": "event", "event_type": "delivered" },   // or {"type": "api"}
  "entry_step_id": "wait1",
  "steps": [
    { "id": "wait1",  "type": "delay", "duration_seconds": 86400,
      "deliver_window": { "start_hour": 9, "end_hour": 17 }, "next": "opened" },
    { "id": "opened", "type": "wait_for_event", "event_types": ["opened"],
      "timeout_seconds": 172800, "scope": "run",
      "on_event": "welcome", "on_timeout": "nudge" },
    { "id": "welcome", "type": "send_email", "template_id": "…", "from": "hi@acme.com", "next": "goal" },
    { "id": "nudge",   "type": "webhook", "url": "https://…", "next": "goal" },
    { "id": "goal",    "type": "goal", "name": "engaged", "next": "end" },
    { "id": "end",     "type": "exit" }
  ],
  "goal": { "event_type": "clicked", "exit_on_goal": true },
  "settings": { "allow_reentry": true, "reentry_cooldown_seconds": 604800 }
}
```

Step types: `delay`, `condition` (attribute if/else over
`trigger.* / context.* / subject.email`), `wait_for_event` (engagement wait
with timeout branch; `scope: "run"` counts only events on messages this run
sent), `split` (A/B percentage split — assignment is a deterministic hash of
run + step, so a retried execution always lands on the same branch),
`send_email`, `webhook`, `suppress` (add/remove suppression), `goal`, `exit`.

`settings.exit_on_events` (default `["unsubscribed", "complaint"]`) auto-exits
in-flight subjects the moment one of those events arrives — processed before
any wait-resume, and enforced even while the workflow is paused.

Validation is two-tier: drafts may be incomplete (warnings), publish is strict
(entry required, no unreachable steps, no cycles, referenced templates must
exist in the org, webhook URLs must pass the DNS-resolving SSRF gate).

## Execution semantics

`packages/shared/src/workflow-engine.ts` + the `workflow` BullMQ queue
(`packages/worker/src/workflow-worker.ts`):

- **Runs rows are the source of truth; Redis jobs are only the fast path.**
  Every transition re-verifies the run row `FOR UPDATE`, so duplicate/stale
  jobs collapse into no-ops. Two scheduler sweeps (`workflow_run_sweep`)
  re-arm waiting runs whose delayed job was lost and re-enqueue stuck
  `running` runs — the same philosophy as the send outbox.
- **send_email is exactly-once**: the message row, `queued` event, and
  send-outbox row commit atomically with the run advancement; delivery flows
  through the existing outbox → send worker pipeline. Sends honor
  suppressions (skip, not fail), domain verification, content scanning, and
  quotas (quota exhaustion parks the run and retries hourly, bounded).
- **webhook is at-least-once**: SSRF-guarded, 10s timeout, HMAC-signed
  (`X-Workflow-Signature: v1=hex(hmac_sha256(secret, "<ts>.<body>"))`; fetch
  the per-org secret from `GET /v1/workflows/signing-secret`). Receivers
  dedupe on `X-Workflow-Delivery`. Transient failures (5xx / timeout /
  network) park the run and retry every `WORKFLOW_WEBHOOK_RETRY_MINUTES`
  (default 5) up to `WORKFLOW_WEBHOOK_MAX_RETRIES` (default 5); permanent
  failures (4xx, SSRF, bad URL) fail the step through to its next edge.
- **Event integration**: the event worker calls `dispatchWorkflowEvent` for
  every engagement event, which (1) resumes matching `wait_for_event` runs,
  (2) marks goals (optionally exiting the run), and (3) starts runs for
  event-triggered workflows — all guarded by a per-tenant "has workflows"
  Redis cache so tenants without automations pay ~nothing on the hot path.
- **Re-entry policy** per workflow (`allow_reentry` + cooldown); a partial
  unique index guarantees at most one in-flight run per (workflow, subject).
- **Safety caps** (env): `WORKFLOW_MAX_STEPS_PER_RUN` (200),
  `WORKFLOW_STEP_BUDGET_PER_JOB` (25), `WORKFLOW_MAX_ACTIVE_RUNS_PER_WORKFLOW`
  (50k), `WORKFLOW_QUOTA_RETRY_MINUTES`/`WORKFLOW_MAX_QUOTA_RETRIES`,
  `WORKFLOW_WEBHOOK_TIMEOUT_MS`, `WORKFLOW_WORKER_CONCURRENCY`.

Lifecycle: pausing stops **new entries** (in-flight runs continue, and
auto-exit rules still bind); archiving stops new entries **and cancels**
in-flight runs.

Data lifecycle: finished runs age out after `WORKFLOW_RUN_RETENTION_DAYS`
(default 90; step ledgers cascade, aggregate `workflow_step_stats` survive),
and GDPR recipient erasure (`POST /v1/privacy/delete-recipient`) removes the
recipient's workflow runs in the same transaction as their messages/events.

## API (scope: `workflows`)

```
GET/POST      /v1/workflows                       list / create draft
GET/PUT/DELETE /v1/workflows/:id                  detail / edit draft / archive
POST          /v1/workflows/validate              validate without saving
POST          /v1/workflows/:id/publish           strict-validate + snapshot + activate
POST          /v1/workflows/:id/pause|resume      lifecycle
GET           /v1/workflows/:id/versions[/:v]     version history / snapshot
POST          /v1/workflows/:id/versions/:v/restore
POST          /v1/workflows/:id/trigger           start a run (subject_email + context; Idempotency-Key supported)
POST          /v1/workflows/:id/trigger/bulk      enroll up to 1000 subjects, per-subject results
POST          /v1/workflows/:id/simulate          dry-run path trace (no side effects)
GET           /v1/workflows/:id/runs              run listing (+status/subject filters)
GET           /v1/workflows/runs/:runId           run detail + step ledger
POST          /v1/workflows/runs/:runId/cancel
GET           /v1/workflows/:id/stats?days=30     run counts, goal attainment, step counters, daily timeseries
GET           /v1/workflows/signing-secret        webhook-step HMAC secret
```

Lifecycle mutations are audit-logged (`workflow:published`, `workflow:paused`,
`workflow:archived`, `workflow:run_canceled`, …).

## Observability

Prometheus: `mp_workflow_runs_started_total{trigger_source}`,
`mp_workflow_runs_finished_total{status}`,
`mp_workflow_steps_executed_total{step_type,outcome}`,
`mp_workflow_sweep_recovered_total{kind}` (alert if the last one grows — it
means Redis jobs are being lost and the durability net is catching them).

## Tests

- `packages/tests/workflows.test.ts` — definition validation, condition
  evaluation, simulation, delivery-window math (pure, no services).
- `packages/tests/e2e/workflows.e2e.test.ts` — full engine over live
  Postgres + Redis + the real BullMQ worker: builder CRUD + publish, API
  triggers, wait/resume via event dispatch, event triggers, goal exits,
  suppression skips, re-entry blocking, cancellation, archive semantics.
