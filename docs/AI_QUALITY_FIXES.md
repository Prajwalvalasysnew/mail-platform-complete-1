# AI quality corrections ? 21 October 2026

The user's connected-domain question exposed a real routing defect. Prior HTTP-completion smoke checks did not establish product quality. This update adds answer-level checks and conversational template editing while retaining the existing customer layout. The user explicitly approved a compact conversation history inside the existing AI assistant panel.

## Corrections

- Remove keyword gating before read planning. Every conversational turn now receives the registered tool catalog and canonical history, including short follow-ups without resource names.
- Domain evidence includes the exact total across all tenant sending-domain rows and a separate verified total. A bounded list of 20 names cannot be mistaken for the total. Private keys and verification tokens remain excluded.
- Expand the bounded observe/plan/read loop to up to four planning steps and four distinct reads. Stop on no new reads, enforce timeouts and per-tool authority, persist ordered observations, and fence stale/cancelled attempts.
- Let the conversational response choose an answer, clarification or draft proposal. Remove the customer adapter's phrase-based draft detection. All provider output is schema-validated.
- Render designed emails through constrained theme/layout tokens, hero typography, feature cards, optional supplied-link CTAs and table-based email structure. Text remains escaped; arbitrary executable HTML is never accepted. Generated email styling is distinct from the customer application's design.
- Prohibit invented merge tags and links throughout the draft. Provider corrections receive the specific validation error. Explicit editor instructions not to change the email reject draft output. The live route uses medium reasoning for conversational answers/drafts.
- Add editor chat history, current-canvas context, follow-up instructions and Stop inside the existing panel. Answers do not overwrite the canvas. Draft changes keep Undo, stale-edit protection and existing Save. Current design tokens accompany follow-ups. The conversation ID is restored from the URL and saved template metadata; pending work resumes and recovered drafts require explicit application.
- Clear editor conversation state on an identity/organization change. Tenant and owner validation remains server-side. Retention, holds and privacy deletion continue to cover transcripts and observations.
- The dispatcher only re-enqueues pending work for enabled tenants. Deterministic browser fixtures enable only their own synthetic tenant.

## Harness source relationship

Reinspected the supplied harness's `packages/core/agent-loop/src/agent.ts` and `tool-calls.ts`: session-derived requests, explicit step boundaries, tool results feeding the next step, ordered persistence, cancellation and bounded dispatch. These inform the platform's PostgreSQL/BullMQ implementation alongside the existing session/compaction adaptations. This is not an unmodified deployment of the full Cordis runtime, and no claim of full harness parity is made. A separate backend process already runs AI outside the mail worker; creating another service alone would not fix routing or template quality.

The source and MIT notice remain documented in `third_party/harness`.

## Validation

The expanded focused suite passed 51 tests. The production-bundle browser check passed editor questions without canvas mutation, follow-up generation, saved history after reload, Undo, section insertion, stale-edit rejection, main-chat history/compaction and retry/resume checks. Seven synthetic live-model checks passed: the user's exact domain question, verified-count follow-up, the exact product-demo prompt, editor theme/content follow-up, delivery totals, selected-template grounding and exact history retrieval.

The live product-demo check initially failed because the model invented merge tags and capabilities. The draft was blocked, the generation/correction guidance was revised, and the live case subsequently passed. This result covers these scenarios; it is not a guarantee of all model answers or production concurrency.

Local rollout uses the already-built runtime images plus compiled shared/API/worker/UI layers, preserving existing dependencies and credentials outside images. A full source build includes the same changes. No new database migration is required beyond 105?108.

## Running-application acceptance

The updated API, dedicated AI worker and customer UI were deployed locally. `packages/customer-ui/scripts/check-ai-quality-live.mjs` passed through the real UI, API, queue, worker and hosted model with a temporary synthetic account: 23 connected domains, zero verified domains, product-demo generation, ocean-theme follow-up preserving CEDAR-482 preview, a question explicitly forbidding edits, template save, and conversation restore after reload. Synthetic records were removed afterward. Screenshots are in the ignored `packages/customer-ui/test-results/ai-live` directory (`live-domain-answer.png`, `live-product-demo.png`, `live-editor-conversation.png`).

One earlier live editor attempt failed before the passing acceptance run; its cause was not captured. The application blocked completion rather than applying an invalid draft. Safe failure categories were subsequently added to worker diagnostics (schema/links/merge tags/output limit/provider/connectivity/cancellation), without logging customer content. Live model behavior remains variable; the passing acceptance cases establish these workflows, not universal response correctness.

The original generated/reference customer views and global styling have no content changes. The only approved visible addition is conversation history and controls within the existing editor AI panel. The panel scrolls to the latest response.

The final shared/API/AI-worker/customer UI layers are running and healthy. The live running-application browser acceptance passed again after the diagnostics and conversation-scroll update. The 32 affected provider/chat tests were rerun and passed after the final backend changes; the full focused suite previously passed 51 tests. No temporary QA accounts remain.

A final editor context correction separates visible canvas copy from the exported subject/preheader and supplies existing absolute link URLs separately. This prevents email metadata from being mistaken for body content during follow-up generation and retains approved CTA destinations in model context.

After the final visible-copy/link-context correction, all 51 focused tests passed again. Both the deterministic production-bundle browser suite and the real running-application/Ollama browser acceptance passed. The final local services are healthy.
