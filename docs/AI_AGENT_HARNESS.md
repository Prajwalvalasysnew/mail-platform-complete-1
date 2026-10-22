# Valasys AI agent on the DeepSeek Harness

Updated 22 October 2026. This replaces the structured-draft approach for the template editor, the workflow builder, the assistant drawer on every workspace page and the main AI chat. Earlier documents (`AI_QUALITY_FIXES.md`, `AI_CHAT_SESSION_RELIABILITY_REVIEW.md`) describe the previous design.

The workflow step-format, polling and conversation-isolation corrections and their live-model verification are documented in [AI_WORKFLOW_CHAT_RELIABILITY.md](AI_WORKFLOW_CHAT_RELIABILITY.md).

One-prompt campaigns (segment, emails, A/B journey, approval and launch) and the model context requirements are documented in [AI_CAMPAIGNS.md](AI_CAMPAIGNS.md).

## Why the approach changed

A real editor conversation showed that the old design could not do what users asked:

| What the user saw | Root cause in the old design |
|---|---|
| "Highly attractive template" came back plain | The model could only fill 5 block types with 5 fixed themes; it never wrote HTML |
| "Change the background to orange" was refused | Colours were limited to `indigo/ocean/forest/charcoal/rose` |
| "I've added a CTA" but nothing changed | The reply and the change were separate; nothing checked the claim |
| `valasys.com` was not accepted as a link | Only `https://` URLs typed exactly were allowed |
| "Just add a CTA" rebuilt the whole email | The model only saw plain text and returned a complete new draft every time |

## New design

The model works on the user's real email the way a coding agent works on code: it looks at the HTML, makes targeted edits through tools, and replies.

```
editor / AI chat ──► API (/account/ai/chats/:id/turns) ──► ai_runs + BullMQ ──► AI worker
                                                                               │
                         ┌─────────────────────────────────────────────────────┘
                         ▼
     DeepSeek Harness runtime (@deepseek-ai/dsh, profile "valasys-agent", one process per turn)
       agent loop · step scheduling · retries · context compaction · MCP client
                         │  tool calls (loopback MCP, per-run bearer token)
                         ▼
     Valasys tool server in the AI worker (packages/shared/src/ai/mcp-server.ts)
       view_email · read_element · update_element · insert_html · replace_element
       remove_element · write_email · set_subject · read_workspace
                         │
                         ▼
     EmailDocument (sanitised HTML with data-ai ids) + tenant-scoped workspace reads
```

- **Harness, not hand-built.** The loop is the published DeepSeek Harness (`@deepseek-ai/dsh` and `@deepseek-ai/dsh-sdk-client` 0.2.1-rc.2) on its `sdk-minimal` bundle. `packages/worker/harness/cordis.patch.yml` turns off its shell, terminal, sandbox, subprocess, file and working-directory tools and the DeepSeek-only model adapter. It adds two plugins: `dsh-llm-pi-ai`, which points at our model route, and `dsh-mcp-client`, which points at our tools.
- **Model route.** The harness calls `${AI_BASE_URL}/v1/chat/completions` (OpenAI-compatible, with tool calling) using `AI_MODEL` and `AI_GATEWAY_TOKEN`. Ollama serves this API, so the existing `gpt-oss:120b` route works unchanged. DeepSeek, vLLM and LiteLLM routes also work.
- **Isolation.** The harness child process gets only `PATH`, a temporary `HOME`/`DSH_HOME`, the model route and a per-run MCP token. It receives no database, Redis, KMS or tenant credentials. Every tool call goes back to the worker, which checks tenant authority, the run's attempt and deadline, the link policy and HTML sanitisation. The temporary harness home, including its JSONL transcript, is deleted after each turn. PostgreSQL remains the system of record.
- **Targeted edits.** Every element carries a `data-ai` id. `update_element` changes text, inline CSS (any colour) or attributes on one element, and `insert_html` adds a button or section. `write_email` works only on an empty canvas or when the model quotes the user asking for a redesign. "Add a CTA" therefore cannot rebuild the email.
- **Real HTML, sanitised.** The model writes table-based email HTML with inline styles. Scripts, `<style>`, forms, event handlers, `javascript:` and data URLs, and CSS expressions are removed.
- **Links and merge tags.** URLs the user typed are allowed, including bare domains (`valasys.com` becomes `https://valasys.com`), and so are links already in the email. Invented URLs and images are rejected with an error the model can see. A button without a link uses `href="#"`, and the model asks the user for the link. Merge tags are limited to the platform's tags and tags already in use.
- **Claims are checked.** If the model says it changed something and no tool changed the document, the worker sends the harness a verification follow-up in the same session. The model then either makes the change or corrects its reply. Every successful edit produces a plain-English summary ("Updated link “Book your demo”: href: https://valasys.com/product"). The editor shows these summaries under the reply.
- **Workspace reads** use the existing tenant-scoped read tools (`read_workspace`) inside the same loop. Records attached with `@` are read before the turn starts.

## Where the agent works

| Surface | Operation | Tools | Result |
|---|---|---|---|
| Template editor (AI panel) | `editor` | email tools + workspace reads | Edited canvas applied as one undoable step |
| Workflow builder (AI panel, Build tab) | `workflow` | workflow tools + workspace reads | Edited graph applied as one undoable step; autosaved as an unpublished draft |
| Assistant drawer on every workspace page (Home, Campaigns, Contacts, Messages, Automations, Templates, Analytics, Deliverability, Webhooks, API keys, Settings) | `assist` with `settings.page` | all tools | Answers from workspace data; email or workflow drafts with a Review action |
| AI agent page | `assist` | all tools | Same, with the approval card: email drafts become templates, workflow drafts become inactive draft workflows (migration 109 adds `ai_chat_messages.workflow_id`) |

The assistant drawer sends the current page, so "why are messages bouncing?" on Messages or "how many domains are verified?" on Settings uses the matching workspace reads. Each turn edits at most one draft (an email or a workflow).

### Workflow tools

`view_workflow`, `build_workflow` (empty workflow or explicit redesign only), `add_steps` (inserted between existing steps), `update_step`, `remove_step` (orphaned branches are cleaned up), `set_trigger` and `update_workflow_settings`. The document is the builder's own graph (`packages/shared/src/ai/workflow-draft.ts`). It accepts only what the execution engine can publish, matching `workflow-codec.ts`:
- triggers: `event`, `opened`, `clicked`, `delivered`;
- steps: email (an existing template id), duration or engagement waits, if/else and filter on the two context conditions, A/B split, and an https webhook.

Unsupported requests (SMS, tags, notifications, segment conditions, quiet hours) get a tool error and the model explains this to the user. Each tool result lists the remaining publish issues. The agent never publishes or activates a workflow.

## Editor behaviour

The editor sends the canvas body HTML (editor CSS inlined, up to 60,000 characters), the subject and the preheader. It applies the edited document as one undoable step. The existing stale-edit protection and Undo still apply. The main AI chat uses the same agent: a new request builds an email with `write_email`, and follow-ups ("make the heading blue") edit the latest draft in that conversation. Saving still goes through the existing draft-approval card.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `AI_BASE_URL` | — | Model host; the harness appends `/v1` |
| `AI_MODEL` | `gpt-oss:120b` | Must support tool calling |
| `AI_CONTEXT_TOKENS` | 32768 | Was 8192; agent turns carry HTML and tool results |
| `AI_MAX_OUTPUT_TOKENS` | 8192 | Was 3000; a full designed email needs room |
| `AI_AGENT_TIMEOUT_MS` | 480000 | Whole multi-step turn, counted from when it starts (queue time excluded); run deadline adds 30 s. Turns stop 45 s early and keep finished work |
| `AI_PROVIDER` | `ollama` | Only for the simple operations (subjects/rewrite/compact); `openai` uses `/v1/chat/completions` in JSON mode |
| `AI_THINK` | `medium` | Ollama `think` value for simple operations (subject lines, compaction and routing run without reasoning so their small output caps are not used up) |
| `AI_USER_DAILY_LIMIT` | 50 | Requests per user in a rolling 24 hours. Deleting chats does not reset it |
| `AI_RETENTION_HOURS` | 24 | Run inputs and results (the per-request records) |
| `AI_CHAT_RETENTION_DAYS` | 30 | Saved conversations. Each new message extends the window; a chat with a reply in progress is never purged |

Helm: the AI worker now mounts an `emptyDir` at `/tmp`, because its root filesystem is read-only. Its memory limit is raised to 1.5 Gi for the harness child process. The worker image installs about 550 MB of extra harness packages. The harness publishes only release-candidate versions, so they are pinned exactly.

## Chat experience and reliability

- **Plain chat in the builders.** The template editor and workflow builder panels show only the conversation and one message box (Enter sends, Shift+Enter adds a line). While the agent works, the status names the current step ("Editing the email…", "Building the workflow…") and offers Stop. AI replies can be copied. A failed or stopped reply offers Retry. New chat starts over.
- **Conversations persist.** The editor stores its chat with the template; each workflow remembers its chat in the browser, including a new workflow once it is first saved. The AI agent page lists saved chats and can delete them.
- **Context.** Each chat sees only its own messages. Requests that failed or were stopped stay in context, marked as such, so "try again" works. Compaction measures only the conversation, not the editor or workflow state sent with each message.
- **Clear errors.** Failures say what to do: a link the user did not provide, an email that grew too large, a request that took too long, the daily limit (with when it frees up), or a conversation that is too long.
- **Safety.** Links already in the email (including `mailto:` and CSS background images) stay editable; new links, CSS `url()` images, webhook URLs and alert recipients must come from the user's own words. Workflow settings apply all-or-nothing. If the model keeps calling tools past the 40-step budget, the worker ends the session and returns what was done.
- **Deleting.** Deleting a chat or a run stops it and erases its content immediately; a minimal record remains until retention ends so the daily limit cannot be reset.

## Verification

- `packages/tests/e2e/ai-agent-harness.e2e.test.ts` runs the real harness against a scripted OpenAI-compatible model. It covers create → CTA + orange background (the invented link is rejected, then `#` is used) → link the CTA. It checks that untouched content is unchanged and that history is carried between turns. It also covers claim verification, bare domains, questions that must not edit, and main-chat drafting, revision and approval.
- `packages/tests/ai-email-document.test.ts` covers the sanitiser, the link and merge-tag policy, targeted edits, outlines and the HTML budget.
- `packages/tests/ai-workflow-draft.test.ts` covers workflow building, inserting, editing, removing and publish issues; the harness e2e suite also builds and edits workflows in the builder, has the Automations drawer draft one, and approves it into an inactive draft workflow.
- `packages/customer-ui/scripts/check-ai-everywhere-browser.mjs` runs the real API server and AI worker against the production bundle. It builds a workflow from the builder's AI panel (autosaved to the workspace), stops a reply and retries it, reopens the workflow to check the chat is restored, starts a new chat, answers a domain question from the Settings drawer using workspace data, and drafts a workflow from the Automations drawer. Screenshots are written to `packages/customer-ui/test-results/ai-everywhere/`.
- `packages/customer-ui/scripts/check-ai-agent-browser.mjs` replays the original conversation in Chromium through the production UI bundle, API, queue, AI worker process and harness. Screenshots are written to `packages/customer-ui/test-results/ai-agent/`.

These checks use a scripted model, so they prove the plumbing, the tools, the policy and the UI, not how good a particular model's writing is. Before enabling tenants, run the browser script against the real Ollama route with the scripted server disabled, and review the generated emails.

## Known limits

- The harness has no mid-turn cancel. Stop ends the harness process, and the run is marked cancelled.
- Each turn starts a harness process, which adds roughly 1 s. Turns run one at a time per worker (`AI_CONCURRENCY`).
- Models that do not support OpenAI-style tool calling will answer without editing. The verification step then makes them say so rather than claim a change.
- The `<style>` blocks and media queries that GrapesJS keeps outside inline styles are not sent to the agent.
- Replies are delivered when complete (with live step progress), not streamed token by token.
- Workspace data the agent read in an earlier turn is not replayed in later turns; it reads again when needed.
- Token usage is recorded only for successful runs.
