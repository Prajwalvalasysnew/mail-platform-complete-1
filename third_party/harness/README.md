# Harness reliability adaptations

Source: https://github.com/deepseek-ai/deepseek-harness at c291e7961a515f6d7af9304e7fd1d257929aef26.

The customer integration adapts the durable-session, balanced recent-tail, checkpoint-summary, manual compaction, single-writer and bounded overflow-retry approach inspected in:

- packages/session/session-persistence-jsonl
- packages/compaction/compaction-basic/src/config.ts
- packages/compaction/compaction-basic/src/region.ts
- packages/compaction/compaction-basic/src/summarizer.ts

Platform implementation: packages/shared/src/ai/chats.ts and chat-context.ts, migrations 106 and 107, the existing AI run worker, and the existing customer design adapter.

Storage is tenant-scoped PostgreSQL instead of a per-session JSONL file. The platform retains its existing authentication, queue, inference adapter, approvals and retention policy. The complete Cordis/harness runtime, coding tools, full native token-meter runtime and JSONL codec are not dependencies of this integration. Context pressure currently uses a conservative byte estimate, not the harness's route-specific token measurement. Model summaries can omit details; the original transcript is retained for review and testing.

The upstream MIT notice is preserved in LICENSE.

Additional adaptations: fixed-density text estimation from `packages/llm/token-meter/src/estimate.ts`, typed bounded read planning, repeat-call guards, per-tool timeout policy and owner-scoped session querying. These mechanisms use platform authorization and PostgreSQL observations (`agent.ts`, `workspace-tools.ts`, `tool-contracts.ts`, `meter.ts`, migration 108); they do not import coding tools or the full Cordis runtime. The estimator is telemetry and does not establish the hosted model's exact context capacity.

The quality correction also reinspected `packages/core/agent-loop/src/agent.ts` and `tool-calls.ts` for session-derived step requests, ordered tool observation feedback, no-progress termination and cancellation. See `docs/AI_QUALITY_FIXES.md` for the implemented scope and validation; the full upstream runtime is not mounted.
