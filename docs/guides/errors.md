# Errors

Every error response uses one envelope so you can handle them uniformly:

```json
{
  "error": "validation_failed",
  "message": "to must be a valid email address",
  "request_id": "9b1e...",
  "details": { "fieldErrors": { "to": ["Invalid email"] } }
}
```

- `error` — a **stable, machine-readable code**. Branch on this, not on
  `message`.
- `message` — human-readable explanation (may change; don't parse it).
- `request_id` — include this when contacting support; it pinpoints the request
  in our logs.
- `details` — present for validation errors (per-field messages) and some
  others.

## HTTP status codes

| Status | Meaning |
| --- | --- |
| `200` / `201` / `202` | Success (`202` = accepted/queued for async work). |
| `400` | Malformed request or failed validation. |
| `401` | Missing or invalid authentication. |
| `402` | Billing inactive — settle the account to resume sending. |
| `403` | Authenticated but not allowed: missing scope, suspended account, KYC required, or an unverified/unregistered `from` domain. |
| `404` | Resource not found (or not visible to your account). |
| `409` | Conflict (e.g. an Idempotency-Key whose request is still being processed). |
| `422` | Unprocessable: content rejected by policy, or an Idempotency-Key reused with a *different* body. |
| `429` | Rate limit or sending quota exceeded — back off and retry. |
| `5xx` | Server error. Safe to retry idempotent requests with backoff. |

## Common error codes

| `error` code | Status | Meaning |
| --- | --- | --- |
| `missing_auth` | 401 | No `Authorization: Bearer` header. |
| `insufficient_scope` | 403 | The key lacks the scope this endpoint requires. |
| `account_suspended` | 403 | The account is not active. |
| `domain_not_registered` | 403 | The `from` domain isn't registered — add it via `POST /v1/domains`. |
| `domain_not_verified` | 403 | The `from` domain is registered but not yet verified. |
| `kyc_required` | 403 | Identity verification needed before sending at this volume. |
| `billing_inactive` | 402 | Sending paused due to billing — settle to resume. |
| `validation_failed` | 400 | Body/query failed schema validation (see `details`). |
| `missing_subject` / `missing_content` | 400 | Provide a subject and `html`, `text`, or a `template_id`. |
| `template_not_found` | 404 | The referenced `template_id` doesn't exist. |
| `content_rejected` | 422 | Message flagged by content policy (see `reasons`). |
| `idempotency_key_reused` | 422 | Same Idempotency-Key, different body. |
| `idempotency_in_progress` | 409 | A request with this key is still processing — retry shortly. |
| `quota_exceeded` | 429 | Daily/monthly sending quota hit. |
| `internal_error` | 500 | Unexpected server error — retry with backoff. |

Request-rate throttling (the per-minute limits in [Rate limits](./rate-limits.md))
also returns `429`, distinct from `quota_exceeded`; honor the `retry-after` and
`x-ratelimit-*` headers.

## Handling errors well

- Switch on the `error` code, not the HTTP status alone (multiple codes share a
  status).
- Retry `429` and `5xx` with exponential backoff + jitter; do **not** retry
  `4xx` validation/auth errors without fixing the request.
- Log the `request_id` on failures so support can trace them.
