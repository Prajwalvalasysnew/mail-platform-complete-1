# Webhook delivery replay

Addresses gap-analysis §2.5.11 / §C.4 ("customer webhook replay UI/API").

## What already existed (verified in code)

The customer-facing webhook surface (`packages/api/src/routes/webhooks.ts`)
already had:
- `GET  /webhooks/:id/deliveries` — paginated delivery history (status, outcome,
  timing, error) with cursor pagination.
- `POST /webhooks/:id/test` — send a synthetic `test_ping` event.
- `POST /webhooks/:id/retry-failures` — bulk re-queue non-success deliveries,
  reconstructing each original event payload from the `events` table (not an
  empty body).
- `POST /webhooks/:id/rotate-secret` — with a previous-secret grace window.

## What this pass added

`POST /webhooks/:id/deliveries/:deliveryId/replay` — replay ONE specific
delivery by its log id, regardless of its original outcome. This covers the
case `retry-failures` can't: re-sending an event that WE delivered
successfully but the customer's downstream lost.

Safety properties:
- The webhook is first confirmed to belong to the caller's customer (via
  `tenantScoped` on the RLS-protected `webhooks` table), then the delivery row
  is required to belong to that webhook — so a customer cannot replay another
  tenant's delivery by guessing a numeric log id.
- The original payload is reconstructed from the source `events` row (looked up
  tenant-scoped), matching the exact `WebhookJobData` shape the event worker
  sends. If the source event is gone (retention purge / GDPR erasure) it returns
  `422 source_event_gone` rather than delivering a fabricated body.
- Rate-limited (30/min) and requires the `webhooks` scope.

The event-reconstruction logic is now factored into a single `buildDeliveryJob`
helper shared by `retry-failures` and the new single-delivery replay, so the
two paths can't drift.

## Known related drift (now bounded by a test)

The OpenAPI spec (`packages/shared/src/openapi.ts`) documents `/webhooks` and
`/webhooks/{id}` but NOT the `/deliveries`, `/retry-failures`, `/test`,
`/rotate-secret`, or (now) `/deliveries/{deliveryId}/replay` sub-routes — the
same OpenAPI-vs-runtime drift the gap analysis flags in §23.3.3. Rather than
patch just the new route (which would make the spec more inconsistent), these
are tracked in the `ALLOWLIST` of `packages/tests/openapi-route-parity.test.ts`
(see docs/OPENAPI_ROUTE_PARITY.md), which now prevents the drift from growing
silently. The right long-term fix is spec-from-schema generation, tracked in
§23.3.3.

## Verified how

- `npm run build --workspace=@platform/api` passes — the new handler typechecks,
  and critically the `webhooksQueue.add('deliver', buildDeliveryJob(...))` call
  typechecks against `Queue<WebhookJobData>`, confirming the replayed job shape
  matches what the worker consumes.
- No DB-backed test run possible in this environment (no Postgres/Redis); the
  tenant-isolation and reconstruction behavior needs an e2e run in staging/CI.
