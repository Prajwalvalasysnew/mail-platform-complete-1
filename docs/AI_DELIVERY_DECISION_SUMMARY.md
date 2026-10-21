> **Superseded for the editor and AI chat (21 October 2026):** conversational turns now run on the DeepSeek Harness agent runtime with HTML editing tools. See [AI_AGENT_HARNESS.md](AI_AGENT_HARNESS.md).

# Valasys AI: two-day delivery plan

> Current implementation update: Durable server-side chat history, resumable runs, checkpoint compaction and idempotent draft approvals have been added without changing the design. See [session implementation review](AI_CHAT_SESSION_RELIABILITY_REVIEW.md) for current scope and remaining differences from the supplied harness.
> Implementation constraint: Preserve the existing customer AI and email editor design, reference HTML, generated views and CSS. Connect behavior through adapters. Review generated writing on the existing canvas, use the existing subject dropdown and Undo, and save through existing controls. The chat uses real responses and existing approval cards; unavailable account actions must never simulate success.


Updated 20 October 2026. The requested delivery target is **two working days**, replacing the earlier multiweek schedule. This is a focused working release; the complete autonomous account-agent feature set is not promised in two days. [Detailed scope, design and acceptance checks](AI_OLLAMA_HARNESS_REVIEW_AND_ACTION_PLAN.md#0-active-two-day-delivery-scope).

## What ships

Working **Valasys AI** in the connected email editor using the user's hosted Ollama GPT-OSS 120b model:

- Generate subject suggestions.
- Rewrite selected text.
- Generate an email draft through a bounded structured format.
- Preview, accept, undo and save through the existing template API.
- Real queued/running/completed/error states, stop, retry and recoverable status after refresh.
- Existing session/MFA/organization permissions, tenant and owner checks, content validation, bounded inference and a feature flag.

The implementation now includes durable AI-agent conversations, checkpoint compaction, resumable runs, draft approval and bounded read-only workspace/history retrieval. These additions preserve the original design. Production rollout remains gated by the operations checklist.

Use direct Ollama integration, neutral application interfaces and Valasys branding. Harness session, compaction and reliability mechanisms are adapted into the backend. Defer a second model, streaming, workflow generation, campaign actions, unattended approval automation, routines and uploaded knowledge. Those remain separately prioritized capabilities with no assigned release dates.

## Minimal implementation

Request flow: existing editor ? authenticated API ? committed tenant-owned run ? recoverable enqueue ? separate AI worker ? private Ollama gateway ? validation/content preflight ? saved result ? authorized polling ? preview/accept ? existing template save.

One new ai_runs table holds bounded request/result data, owner, request hash, status, deadlines, dispatch intent, attempt/lease, usage and expiry. Use trusted deployment configuration for enabled tenants, limits and the fixed model. Feedback tables, customer billing and a settings UI are outside the sprint. Enforce limits without a separate usage subsystem.

Return 202 plus a run ID, poll status, and use the existing Redis/BullMQ infrastructure with a separately deployed AI worker. A recurring dispatcher recovers enqueue failures; atomic claims and attempt checks reject late/stale results. Keep inference out of the API request and mail-worker process. Preserve RLS, ownership, privacy deletion/retention, timeouts and duplicate protection despite the reduced scope.

Hard schema/unsafe-markup/blocked-content failures prevent insertion. Spam heuristics and unsupported claims follow explicit advisory or blocking policy. A selected paragraph does not need its own footer. Preserve protected document elements and keep the trusted managed-footer, consent, suppression and other send-time checks in the existing delivery path.

## Day-by-day execution

| Time | Work | Required outcome |
| --- | --- | --- |
| Day 1, first hour | Verify model tag, private endpoint access from the runtime, gateway credential configuration and one synthetic inference | A measured live response; disclose access/capacity blockers immediately |
| Day 1, remainder | Minimal run migration/RLS, direct provider, three operation schemas, generation/status/cancel endpoints, worker/dispatcher and bounded retries | Backend operations work against real hosted inference; failures and cancellation produce honest states |
| Day 2, first half | Connect editor actions, preview/accept/undo, stale-document protection, errors and Valasys branding | All three editor actions work end to end and save normally |
| Day 2, second half | Focused permission, recovery, content, browser and load checks; internal flagged deployment and rollback | Reviewable working release with evidence; external enablement after applicable release review |
| Only after required checks pass | Basic writing-chat page on the same APIs | Ship only if complete; otherwise keep disabled |

The target assumes the existing application/database/Redis environment works, hosted inference access is supplied at the start, and no GPU purchase or substantial serving repair is required. Work can proceed with a synthetic provider when access is missing, but that does not count as completed real integration. The sprint excludes model downloads or infrastructure replacement unless separately authorized.

## Required checks before calling it done

1. A real authenticated customer performs all three operations against the hosted model; valid content is previewed, accepted, undone and saved.
2. A second tenant/user cannot read, cancel or overwrite another user's run. No credentials or backend vendor diagnostics reach the browser.
3. Invalid/truncated output, unsafe HTML/URLs, provider timeout/outage and unavailable Redis produce useful failures. Spam signals follow defined policy; trusted send-time footer and recipient controls remain authoritative.
4. Duplicate requests reuse one logical run; lost enqueue recovers; stale attempts cannot publish; cancel prevents later acceptance; usage is recorded once.
5. Refresh, sign-out, organization switch and concurrent editor changes do not insert old output into the wrong document/account.
6. Input/output limits, conservative global concurrency, retention/export/deletion and an account disable path operate. Confirm AI saturation does not block normal mail delivery.
7. Deployment, real-model smoke test, feature flag and rollback are verified. Record failed gates instead of declaring success because the second day ended.

## Owners and dependencies

Backend/API/worker: implementation owner. Editor: frontend owner. Private model access/deployment: infrastructure owner. Acceptance/enablement: product owner with the applicable privacy/security review. These are responsibilities to assign at kickoff, not fictional named assignments.

The critical missing dependency is exact Ollama endpoint/model/runtime access; credentials belong in secure deployment configuration, not chat or this document. Confirm access in the first hour. Existing notices and agreements need review for actual AI data processing before external customer enablement; internal release does not waive access or retention rules.

Implementation is now in progress; the approved configured model is gpt-oss:120b-cloud. See [implementation and operations](AI_WRITING_OPERATIONS.md) for the delivered scope and verification evidence. Original evidence remains: customer UI typecheck passed; focused harness tests had 84 passes and 19 failures. The harness is outside the two-day delivery path.

Current quality corrections and validation supersede earlier scope statements: [AI_QUALITY_FIXES.md](AI_QUALITY_FIXES.md). The editor now has the user-approved conversation history within its existing panel, and every conversational turn can plan registered workspace reads.
