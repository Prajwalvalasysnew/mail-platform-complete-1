# Consent ledger (gap analysis Top-20 #8)

## The gap

Report: "Suppressions exist, but consent history/preference center is
incomplete" (score 5.5). The `suppressions` table stored only the CURRENT
opt-out state — one mutable row per recipient, no history. For GDPR / CAN-SPAM
you must be able to PROVE when a recipient opted out, why, through what channel,
and when they were resubscribed. That audit trail did not exist.

## What was built

**Append-only `consent_events` ledger** (`037_consent_events.sql`): every
consent-affecting operation writes an immutable row —
`(action, reason, source, notes, message_id, created_at)`. There is no UPDATE
path; rows are only ever inserted.

Wired into the two functions all consent changes flow through
(`packages/shared/src/suppression.ts`), writing the ledger row in the SAME
executor/transaction as the suppression change so they commit atomically:
- `addSuppression` -> `suppress` event. Source is derived from the reason
  (`complaint` -> complaint, `hard_bounce` -> bounce_escalation,
  `unsubscribe` -> one_click_unsubscribe) unless the caller overrides it.
- `addSuppressionsBulk` -> one `suppress` event per address, source `bulk_import`.
- `removeSuppression` -> `unsuppress` event, but ONLY when a row was actually
  deleted (a no-op remove logs nothing). Callers can attribute it, e.g. the
  GDPR erasure path passes `source: 'gdpr_erasure', reason: 'erasure'`.

Call sites updated for correct attribution: the tracker's one-click
unsubscribe now records `source: one_click_unsubscribe` + the triggering
`message_id`; the privacy erasure endpoint records `gdpr_erasure`.

**Read API**: `GET /v1/suppressions/{email}/consent-history` (scope:
suppressions) returns the full history newest-first. Documented in the OpenAPI
spec. Service function `getConsentHistory(customerId, email)`.

**RLS**: `consent_events` was introduced with the standard permissive rollout
policy and is tightened by `infra/migrations/043_rls_fail_closed.sql` alongside
the other tenant tables.

## Verified how (real, live infra)

- Migration 037 applies cleanly on a fresh DB (table + RLS as one unit; the
  migration immutability guard correctly caught an out-of-band edit during
  development, confirming that safety feature works).
- `npm run build` (all packages): exit 0, no TS errors.
- `consent-ledger.test.ts`: 7/7 pass against live Postgres — suppress event
  recording, reason-derived sources, explicit source/messageId override,
  full suppress/unsuppress/suppress transition history, no-op-remove logs
  nothing, bulk-import per-address rows, and GDPR-erasure attribution.
- The OpenAPI route-parity guard caught the new undocumented route (working as
  designed); it was then documented, and parity passes.
- Full suite: 88 files, 590 tests, 0 failures — the ledger writes did not break
  any existing suppression/e2e behavior.

## Scope note: what this does and does NOT include

This delivers the **consent ledger** half of #8 — the append-only,
auditable consent history, which is the compliance substance. It does NOT
include a **hosted preference center UI** (report §13.4.3: "One-click
unsubscribe exists, but no full preference center"). That is a customer-facing
web surface (subscription-group management page) — a frontend deliverable that
belongs with the self-serve dashboard work (#16), not the backend ledger. The
backend it would build on — unsubscribe groups, group membership, and now the
consent ledger — is in place.
