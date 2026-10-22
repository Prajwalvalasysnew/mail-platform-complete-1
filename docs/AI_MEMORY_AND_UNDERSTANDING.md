# Valasys AI: understands you, remembers you

Updated 22 October 2026. Users reported that the email builder's AI had to be told the same things repeatedly and misread requests such as "make this bigger". This document describes how every AI surface now keeps context and resolves references.

## Workspace memory (never repeat yourself)

- **One memory per workspace**, shared by:
  - the template editor;
  - the workflow builder;
  - the AI agent chat;
  - the page assistant drawer.

  It is stored in `ai_workspace_memory` (migration `113`, tenant RLS).
- **What it holds:** industry, about the business, brand voice, audience, rules, and up to 40 remembered facts.
- **Editing it:** use **AI agent → Memory**. Edits save automatically; the panel used to be per chat.
- **The AI saves facts itself.** When a user states a durable fact ("our site is valasys.com", "our brand colour is #d6343c", "sign off as The Valasys team"), the agent calls `remember` and confirms in one clause.
  - Facts are topic-prefixed ("Website: …"), so a new fact replaces the old one on the same topic.
  - "Forget …" calls `forget`.
- **Links in memory count as user-provided everywhere**, so "add a button to our site" works in a new chat without pasting the link again.
- **Guardrail:** `remember` saves only links and email addresses the user typed in this conversation, or that are already in memory. Text from workspace data (templates, campaigns, attached records) cannot plant a link.
- **Brand colour:** a remembered brand colour becomes the default accent of composed emails.

## Understanding references

- **The selected block is "this".** The editor marks the block selected on the canvas in the copy of the HTML it sends; the canvas itself is never touched. The agent is told "The user has selected link “Book a demo” (e14)", so "make this orange" changes exactly that block. The marker is stripped before anything returns to the editor.
- **The system prompt now explains how to resolve:**
  - "this / it / the selected …";
  - "the button / the second section";
  - "do the same for …" and "bigger / smaller";
  - "undo" (the Undo button restores the previous canvas).

  It also tells the agent to use the conversation and memory instead of asking again, and to ask only when a wrong guess would waste the user's work.

## Consistent, premium new emails

- `compose_email` is the preferred tool for a new email or an explicitly requested redesign. It takes copy blocks, renders them in the platform's tested layout (centred 600px, hero, bulletproof button, unsubscribe footer) and sets the subject and preheader.
- Text is escaped, and links must come from the user or from memory.
- The layout accepts a brand `accent` (`#rrggbb`) and derives a matching tint and ink colour.
- It refuses to replace an existing email unless the user asked for a redesign. Changes to existing emails stay targeted edits.

## Verification

- `packages/tests/e2e/ai-editor-understanding.e2e.test.ts` runs on the real harness with a scripted model. It covers:
  - facts remembered in the editor and used in a new chat, with the link allowed and the brand colour applied;
  - the same memory reaching the workflow builder;
  - topic replacement and forget;
  - injected links refused;
  - the selection resolving "this" with no marker leak;
  - compose refusing to overwrite existing work;
  - the memory API's validation and workspace isolation.
- `packages/customer-ui/scripts/check-ai-agent-browser.mjs` now also checks, in the production UI:
  - clicking a button on the canvas, then "make this green", changes only that button;
  - a fact remembered in the editor appears on the AI agent page's Memory panel;
  - Memory edits persist across reloads.
