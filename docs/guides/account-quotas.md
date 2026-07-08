# Account & quotas

Your account has **daily** and **monthly** sending quotas that reset automatically. This page explains how quotas work, how to monitor them, and what happens when you reach a limit.

---

## How quotas work

Every message you send counts against two counters:

- **Daily quota** — resets at midnight UTC each day.
- **Monthly quota** — resets on the first day of each calendar month (UTC).

Quota is reserved atomically at the moment a send is accepted. If the quota would be exceeded, the API returns `429 quota_exceeded` before any messages are queued — nothing is sent and nothing is charged.

For [batch sends](./batch-sending.md), the entire batch is reserved at once. If the batch would take you over quota, the whole batch is rejected (not partially accepted).

---

## Check your current usage

```bash
curl https://api.mailplatform.example/v1/usage \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

**Response**
```json
{
  "daily_used": 1240,
  "daily_limit": 10000,
  "monthly_used": 28400,
  "monthly_limit": 200000,
  "period": "2026-06"
}
```

---

## Quota notifications

You automatically receive webhook events when you approach and hit your limits. Subscribe to receive them:

```bash
curl -X POST https://api.mailplatform.example/v1/webhooks \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://yourapp.example.com/hooks/mail",
    "events": ["quota_warning", "quota_exceeded"]
  }'
```

| Event | When it fires |
|---|---|
| `quota_warning` | You have used 80% of your daily or monthly quota. Fired once per period. |
| `quota_exceeded` | You have hit 100% of your daily or monthly quota. |

**Example payload**
```json
{
  "event_type": "quota_warning",
  "occurred_at": "2026-06-09T14:00:00.000Z",
  "quota_type": "daily",
  "used": 8000,
  "limit": 10000,
  "percent": 80
}
```

---

## Sending tiers

Your quota is determined by your account tier:

| Tier | Daily quota | Monthly quota | Notes |
|---|---|---|---|
| Free | 100 | 1 000 | No payment required. For development and testing. |
| Starter | 10 000 | 200 000 | For small production workloads. |
| Pro | 100 000 | 2 000 000 | For growing applications. |
| Enterprise | Custom | Custom | Contact sales for high-volume and custom limits. |

To upgrade your tier, contact support or billing.

---

## Handling `429 quota_exceeded`

When a send is rejected due to quota:

```json
{
  "error": "quota_exceeded",
  "message": "Daily sending quota exceeded. Resets at 2026-06-10T00:00:00.000Z.",
  "retry_after": 36000,
  "request_id": "req_..."
}
```

- Do **not** retry immediately. The `retry_after` value (in seconds) tells you when the quota resets.
- For daily resets, the wait is at most 24 hours. For monthly limits, plan your volume more carefully.
- Use the [usage endpoint](#check-your-current-usage) to check remaining capacity before a large batch.

---

## Test mode and quotas

Messages sent with a test-mode API key (`mp_test_...`) consume your test-mode quota, which is separate from your live quota. Test sends never affect live quota and are never delivered to real recipients. There is no cost for test-mode sends.

---

## Physical address requirement

Before you can send to live recipients, your account must have a **physical postal address** set. This is required by CAN-SPAM §5(a)(5) for commercial email.

```bash
curl -X PATCH https://api.mailplatform.example/v1/profile \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "physical_address": "123 Main St, Springfield, IL 62701, USA"
  }'
```

Live sends without an address set will fail with `physical_address_required`. Test-mode sends are not affected.

---

## KYC and sending limits

New accounts start on the Free tier with low limits. Upgrading to higher tiers may require identity verification (KYC). If you attempt to send above your tier's cap, the API returns `403 kyc_required` with instructions.

---

## Tips for staying within quota

- **Use batch sends** for large jobs. `POST /v1/send/batch` amortizes overhead and is more efficient than individual sends.
- **Smooth out your volume.** Sending 50 000 messages at midnight the moment your daily quota resets is fine technically, but can look like a spam pattern to ISPs. Spread sends throughout the day when practical.
- **Filter suppressions before sending.** The API skips suppressed recipients and refunds their quota, but calling the suppression list check in your application before sending avoids the round-trip entirely at scale.
- **Monitor the `quota_warning` webhook.** Build an alert for when you hit 80% so you can decide whether to throttle, upgrade, or defer non-urgent sends.
