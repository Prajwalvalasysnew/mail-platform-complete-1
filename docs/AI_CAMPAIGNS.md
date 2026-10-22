# Valasys AI campaigns: one prompt to launch

Updated 22 October 2026. The landing page promises that one plain-English request becomes a segment, emails in the brand voice, a journey with an A/B test, and a launch that waits for one approval. Before this change the AI chat could produce only one draft per turn (one email or one workflow). It could not create audiences and had no launch step. This document describes how the promise now works end to end.

## What the user sees

1. **Ask.** In the AI chat: "Win back customers who've been inactive for 30 days."
2. **Plan.** In one turn the agent produces a **Campaign plan** card:
   - **Create segment**: "Inactive 30 days" (opened nothing and clicked nothing in the last 30 days), with live counts: how many contacts match and how many can receive marketing email.
   - **Write email** (one item per email): two or three emails in the brand voice. They use the trusted branded layout with an unsubscribe footer.
   - **Save workflow draft**: the journey in one line, for example `A/B test “Win-back 1”: “We saved your spot” vs “It has been a while” → wait 3 days → send “Win-back 2”`, plus any publish blockers.
   - **Launch campaign**: "Email 2,201 contacts".
3. **Approve.** Each part has Approve and Skip, and there is also Approve all:
   - Approving a segment saves it to Contacts.
   - Approving an email saves it as a template.
   - Approving the workflow saves it as an inactive draft. It saves the emails it sends at the same time, and a skipped email leaves its step empty.
4. **Launch.** Approving the launch always shows a browser confirmation. Confirming it:
   - saves any parts that are still pending;
   - compiles and publishes the workflow (including any edits the user made in the builder);
   - enrolls the audience's **subscribed, consent-confirmed** contacts.

   The card then reads "Live · N contacts enrolled". Every part links to its saved record.
5. **Iterate.** Follow-up turns edit the same plan. For example, "Make the second email shorter and wait 5 days" rewrites that email by key, changes the wait, and keeps everything else.

"Auto-apply drafts" mode saves segments, emails and workflows automatically. It never launches.

## Guardrails

- The model never saves, publishes or sends anything. Its tools only change the in-memory plan for the turn.
- Launching needs `confirm: true` on the decision request; the UI sends it only after the user accepts the confirmation dialog. It also needs the `send` capability. Launch is idempotent: a double click or retry never enrolls anyone twice.
- If a blocker exists, nothing is sent and the drafts stay saved so the user can fix it and retry. Blockers are:
  - no verified sending domain;
  - an email step without a template;
  - nobody sendable in the audience;
  - more than `AI_CAMPAIGN_LAUNCH_MAX_CONTACTS` sendable contacts (default 10,000).
- Buttons may link only to URLs the user typed; otherwise they use `#` and the reply asks for the link. Invented merge tags are rejected.
- Email copy is rendered by the platform's layout (escaped text, fixed design tokens), not model-written HTML. Every campaign email is spam-screened and checked for blocked link domains before the plan is shown.
- Campaign tools are offered only in the AI chat, not in the template editor or the workflow builder.

## Implementation

| Area | File |
| --- | --- |
| Segment rules and member queries (shared by Audiences, campaigns and AI) | `packages/shared/src/audiences.ts` |
| Plan model, branded email rendering, lenient rule parsing | `packages/shared/src/ai/campaign-plan.ts` |
| Agent tools: `define_audience`, `draft_campaign_email`, `remove_campaign_email`, `view_campaign` | `packages/shared/src/ai/email-tools.ts` |
| Campaign instructions, seeding follow-ups, the `campaign` result | `packages/shared/src/ai/email-agent.ts` |
| Per-part approval and launch | `packages/shared/src/ai/campaign-launch.ts` |
| Decision API (`item`, `confirm`, `timezone`) | `POST /v1/account/ai/chats/:id/messages/:mid/decision` |
| Per-part state | migration `112_ai_campaign_plan_items.sql` (`ai_chat_messages.plan_items`) |
| Chat card, journey summary, launch confirmation | `packages/customer-ui/src/faithful/agent-adapter.ts` |

Workflow email steps reference unsaved campaign emails as `draft:<key>`. Saving the workflow replaces those references with the saved template ids.

## Launch rules (from the approval audit)

- One launch per conversation. A follow-up version of a launched plan can be saved as new drafts, but it is never launched again. Older versions cannot launch while a newer version exists, and older plan cards show no actions.
- Launch requires the "Started via API or manually" trigger. Other triggers would keep enrolling future contacts after launch, outside the confirmed audience.
- The conversation rules are checked before anything is saved, so a refused launch leaves no stray drafts.
- Only an approval is final. A skipped part can be approved later, and confirming the launch applies the required audience and workflow even if they were skipped. Skipped emails stay skipped.
- Saved names are unique per workspace ("Name (2)"). Allocation is serialized per tenant, so parallel approvals cannot collide.

## Reliability with real models

| Situation | Behavior |
| --- | --- |
| Arguments sent as JSON strings, numbers as strings, empty ids, tool names prefixed with the server name | Coerced to the tool's schema before validation |
| Multi-part campaign left unfinished (no audience, emails or journey) | One "Completeness check" follow-up names what is missing; the agent finishes it |
| Reply cut off at the output cap (its tool call never ran) | Detected from the harness turn end; the agent is asked to continue with smaller calls (at most twice) |
| Provider fails mid-turn after work was done | The finished work is returned, with "The AI service stopped responding… ask me to continue" |
| Slow model near the deadline | The turn stops 45 s before the hard deadline (or at 85% of the budget) and keeps finished work |
| Turn budget | Counted from when the turn starts, not from when it was queued. Long-history compaction does not consume it. Default 480 s |
| Identical repeated calls | Blocked only while the draft is unchanged; re-reading after an edit is allowed, and failed calls can be retried |
| Step budget or repeated tool failures | The reply names the real cause |
| A reply claims a change no tool made | Replaced with an honest "nothing was modified" message |

These are covered by `packages/tests/e2e/ai-agent-reliability.e2e.test.ts`, which uses the real harness with a scripted misbehaving model.

## Model configuration (important for quality)

An AI chat turn carries about 6,200 tokens of tool definitions and 2,700 tokens of instructions before any conversation. A designed email can need several thousand output tokens.

- Use `AI_CONTEXT_TOKENS=32768` and `AI_MAX_OUTPUT_TOKENS=8192`. Docker Compose and `.env.example` defaulted to 8192/3000 until this change, which truncated nearly every chat turn. The AI worker now warns at startup below 16,384.
- **Local Ollama:** the OpenAI-compatible endpoint uses the server's context length, not the request's. Start Ollama with `OLLAMA_CONTEXT_LENGTH=32768`, or set `num_ctx 32768` in a Modelfile. Otherwise the instructions are silently cut. Cloud-hosted models (`*-cloud`) already serve their full context.
- The harness profile (`packages/worker/harness/cordis.patch.yml`):
  - sends the output cap as `max_tokens` and the reasoning level as `reasoning_effort`, which Ollama's OpenAI-compatible endpoint reads;
  - sends `reasoning_effort` (from `AI_THINK`, default medium) only for reasoning-model families (gpt-oss, DeepSeek-R1, Qwen3…);
  - sizes history compaction for the configured window. The bundle default assumed a 64k headroom, which turned compaction off at 32k;
  - trims oversized old tool outputs.
- The model must support tool calling. Results depend on the model; `gpt-oss:120b` is the documented default.

## Verification

- `packages/tests/e2e/ai-campaign.e2e.test.ts` runs on the real DeepSeek Harness with a scripted model. It covers:
  - the landing-page prompt, from the plan to guarded approval;
  - skipping an email, then launching, which enrolls exactly the 3 consented contacts out of 5 and is idempotent;
  - follow-up edits to the same plan;
  - rejected links and lenient rule spellings;
  - a launch blocked by a missing domain;
  - tool scoping and owner isolation.
- `packages/tests/ai-campaign-plan.test.ts` unit-tests rule parsing, rendering, link and merge-tag policy, and limits.
- `packages/customer-ui/scripts/check-ai-campaign-browser.mjs` runs the production bundle with the real API server, AI worker and harness:
  - the prompt produces the plan card with live counts and the A/B journey;
  - approving the segment saves it, and dismissing the launch dialog sends nothing;
  - confirming publishes the workflow, saves both emails and enrolls the 3 consented contacts;
  - after a reload, every decision and link is still shown.

These checks use a scripted model, so they prove the platform side end to end. How good the copy and plans are still depends on the configured model. Run the live scripts (`check-ai-quality-live.mjs`, `check-ai-workflow-quality-live.mjs`) against your model after changing it.
