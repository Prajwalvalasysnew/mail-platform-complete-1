# AI chat sessions and context: implementation review

The original customer design remains unchanged. This release adapts the supplied harness's session and compaction approach into the platform backend; it does not mount the complete harness runtime.

## Source and integration

Inspected source revision: `c291e7961a515f6d7af9304e7fd1d257929aef26` from https://github.com/deepseek-ai/deepseek-harness. The relevant source is `session-persistence-jsonl` and `compaction-basic` (`config.ts`, `region.ts`, `summarizer.ts`). Provenance and the upstream MIT notice are retained in [third_party/harness](../third_party/harness/README.md).

| Capability | Platform implementation |
|---|---|
| Durable sessions | Tenant/user-owned PostgreSQL conversations and ordered messages, replacing prototype page memory. History remains available after refresh and a new login, within retention. |
| Canonical context | The worker constructs context from server messages and an immutable per-turn settings snapshot. The browser cannot replace the authoritative transcript. |
| Context compaction | At estimated input pressure of 80%, condense older balanced turns into a checkpoint and aim to retain the newest 16% verbatim. Failed/cancelled turns are excluded. |
| Long individual replies | Plain-text turns exceeding the summary-request budget are processed in bounded pieces. A checkpoint publishes only after all pieces succeed; the full original text remains stored. |
| Manual compaction | `/compact` creates a checkpoint without deleting the transcript. |
| Overflow recovery | A confirmed provider context overflow triggers compaction and one generation retry under the same run deadline. |
| Checkpoint safety | Append checkpoints with source sequence, run and attempt. Lock and verify the live attempt, deadline, authority and prior checkpoint before publication. Cancelled/stale attempts cannot publish. |
| Refresh/resume | Reload the selected chat from its URL and resume polling the existing run. Leaving the chat page detaches the client; explicit Stop cancels server work. |
| Worker interruption | Lease recovery and a maximum of two execution attempts. Graceful worker shutdown preserves queued intent for the remaining attempt. |
| Draft approvals | A saved assistant message is an immutable proposal. Approval locks it, creates a template and version, and records the decision in one transaction. Retried approvals return the same template. |
| History pagination | Return the latest 200 messages, fetch older pages when scrolling upward, and preserve transcript order. |
| Privacy and retention | FORCE RLS on all conversation tables plus API user ownership. Export includes messages/settings/checkpoints. Recipient erasure removes matching conversations. Account deletion clears unheld chats; active legal/regulatory holds preserve required records. |

The existing editor still uses its original controls, canvas, subject dropdown and Undo. Chat approvals do not send email or activate workflows.

## Important differences from the harness

PostgreSQL transactions and row locks replace JSONL logs and file writer locks. BullMQ and the existing run-attempt fences replace an in-process agent loop. No Cordis package or coding-tool profile is imported into the customer platform.

Context pressure uses the configured application byte estimate. A fixed-density text estimator adapted from the harness token meter supplies telemetry, not exact route-specific token prediction. Context JSON is assembled from whole records rather than cut mid-string. The current implementation bounds serialized chat requests to 16 KB or the smaller admission budget. The model's actual context window is separate: Ollama documents cloud models as using their maximum window by default ([Ollama context length](https://docs.ollama.com/context-length)). A local `num_ctx` setting does not establish the cloud service's actual served capacity. Benchmark the configured route before increasing application budgets.

Summaries are lossy model output. Preserving the original transcript does not guarantee that every old detail remains in the next model request. Checkpoints have schema, size, shrink and fencing checks; semantic correctness still needs evaluation. Bounded read-only workspace tools and exact owner-scoped history retrieval are now implemented. Scheduled routines, mutable account actions, retrieval over arbitrary account data, exact provider-token prediction and the full harness event/tool replay protocol remain outside this implementation.

## Lifecycle details

A conversation expires at creation plus `AI_RETENTION_HOURS` (24 hours by default, configurable up to 168); sending another message does not silently extend retention. Expired chats are hidden immediately and removed by worker maintenance unless held. Login-session cleanup invalidates authority for unfinished work without deleting quota records. Historical messages remain readable to the same currently authorized user under a new session. Deleting a conversation cascades its run records and checkpoints, fencing unfinished work.

Business notes, voice, custom skills and mode are saved with the next submitted turn and restored with that conversation. They are not workspace-global preferences. Explicit approval is still required unless the user submitted the request with the existing auto-apply-drafts mode selected and has kept that mode enabled.

Model calls remain bounded by the run deadline, response size, output schema, output-token cap and retry limits. Queueing is globally capped (default concurrency one), per-user admission is serialized, and credentials/model routing remain server configuration. A successful synthetic run is not a concurrency or provider-uptime guarantee.

## Validation

Focused tests: `packages/tests/e2e/ai-chat.e2e.test.ts`, the existing AI writing tests, account data-subject tests and config checks. These cover durable history, owner/tenant isolation, compaction, oversized replies, failed summaries, overflow retry, cancellation fences, approval idempotency, worker interruption, retention holds, pagination and login cleanup. Account tests include chat export and account erasure.

The browser verification script is `packages/customer-ui/scripts/check-ai-live.mjs`; it uses an isolated test database, a dedicated Redis queue and the production UI bundle. It exercises hosted inference, refresh/resume, manual compaction and fact recall, the existing approval card, editor writing operations and temporary network failures. Recorded result: all 48 focused tests passed. The production-bundle browser check passed against the approved hosted model, including exact codename recall after manual compaction and reload, and pending-run resume without duplicate submission. The five-operation hosted smoke check also passed. Shared/API/worker/customer builds passed; reference design files and generated view content are unchanged. The operations runbook records the commands and rollout requirements.

## Rollout

Apply migrations 105 through 108 using the migration owner. The API and AI worker need the non-bypass application role and all RLS tables. Upgrade the AI worker before admitting the new chat requests; drain older active work during rollout. Build/deploy the updated API and customer bundle, then enable a small tenant allowlist. Validate retention, queue saturation, provider latency, restart recovery and rollback in staging before broad enablement. Production deployment has not been performed by this local implementation work.

## Additional harness adaptations

Typed tool contracts, a bounded four-step/four-read loop, duplicate-call guards, tool timeouts and durable observations extend the session/compaction work. Selected template/campaign/workflow/audience references are resolved on the server. Delivery totals come from retained calendar-day rollups; campaign observations distinguish accepted and delivered mail and automated tracking. No tool can send mail or mutate a campaign. Exact history reads can recover details omitted by compaction, subject to ownership, retention and excerpt bounds.

Migration 108 adds fenced run-step persistence and tenant RLS. Tool observations participate in export, conversation deletion and recipient-erasure matching. Existing UI progress steps and the @ picker carry the new behavior without modifying generated views or styles.

### Verification update ? 21 October 2026

Shared, API, worker and customer production builds passed. All 48 focused tests passed, including workspace grounding, exact owner history retrieval, secret exclusion, repeated-call blocking and fail-fast provider failure. Previously recorded hosted writing/session checks predate these additions. The new live grounding evaluation attempted all three cases after the user restarted Ollama, but the configured gateway still failed TCP connection with `UND_ERR_CONNECT_TIMEOUT`; `/api/version` failed the same way. Live grounding quality remains unverified until this machine can reach the configured endpoint. No production deployment was performed.

The current production-bundle browser check passed with the deterministic provider: original AI design, chat, saved history, pending-run resume, manual compaction and codename recall, real tenant template selection through the existing @ picker, grounded reply, draft approval, editor subject/rewrite/full/section generation, Undo, stale-edit protection and injected submission/poll failures. This validates the application flow; it does not validate new hosted-model grounding quality.

Current quality corrections and validation supersede earlier scope statements: [AI_QUALITY_FIXES.md](AI_QUALITY_FIXES.md). The editor now has the user-approved conversation history within its existing panel, and every conversational turn can plan registered workspace reads.
