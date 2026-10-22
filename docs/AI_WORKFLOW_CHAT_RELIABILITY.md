# Workflow AI and conversation isolation

Verified locally on 22 October 2026 using the running application and its configured `gpt-oss:120b-cloud` model.

## Causes and corrections

- The recorded failing workflow turns repeatedly called `add_steps` with `type`, `step`, or `step_type` and a nested `duration`, while the document toolkit only read `t`, `amount`, and `unit`. The toolkit now normalizes those known spellings before running its existing validation, destination restrictions, and template ownership checks. Unsupported steps remain rejected. Four repetitions of the same tool error end the attempt with an honest saved answer instead of looping.
- Workspace autosaves invalidated the cache used for AI status requests. A status read could disappear while the browser awaited it, producing `Cannot read properties of undefined (reading 'status')` and releasing the UI while its server run continued. AI reads now use a separate cache without Workspace invalidation and retain their subscription until the response arrives. Poll responses are validated; transient failures reconnect to the same run. Failed cancellation no longer abandons polling or prevents another Stop attempt.
- The main agent listed every conversation and selected the most recently updated one by default. Its list now excludes chats originating in either builder, and opening the agent without an explicit chat starts empty. Classification comes from the original user turn, so later settings changes cannot reclassify a builder conversation. Explicit builder-chat links redirect to the appropriate builder. Existing history is retained; no database migration is needed.
- The workflow assistant waits for builder data before accepting a new request. Resuming a run does not require waiting for canvas loading; recovered changes require the existing Apply saved draft control, preserving edits made during a reload. Live runs still apply automatically when the original canvas is unchanged.
- The sidebar now waits for history restoration when the user immediately submits a prompt. An early Enter no longer silently drops that submission.

Missing audiences, email templates and verified sending domains do not prevent drafting the graph. Required templates and sending setup remain publish blockers. The agent cannot activate or send the workflow. Its guidance now makes that distinction explicit and asks it to use template/step names rather than internal IDs in replies.

## Verification

- Shared, API, worker and customer UI builds passed.
- 38 workflow/document/chat tests passed, including the three recorded step formats, destination restrictions, an empty-workspace draft and conversation-origin filtering across settings changes.
- Five real-harness tests passed against a scripted model, including termination of a repeated invalid-tool loop.
- `packages/customer-ui/scripts/check-ai-everywhere-browser.mjs` passed: malformed poll recovery, a manual autosave during generation, stale-draft review, Stop/Retry, saved history, a fresh main chat, builder-link redirection, workspace reads and sidebar workflow drafting.
- `packages/customer-ui/scripts/check-ai-workflow-quality-live.mjs` passed through the real browser, API, queue, worker, harness and hosted model. A synthetic workspace had no audiences, templates or sending domains. The exact inactive-leads prompt created a connected trigger/email draft; a subsequent request added a two-day wait and a follow-up email, preserving the original node IDs. The four-node graph autosaved; history reloaded; the main agent stayed separate; the builder link returned to the same workflow. Synthetic accounts were removed afterward.

The generated/reference view trees and styles have no source changes. Existing controls, panels and layout are retained. Passing these scenarios establishes their behavior; model responses and execution time can still vary.
