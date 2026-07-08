# Runbook: Dead-Letter Queue Accumulation

## Trigger
- `mp_dlq_depth` gauge > 0 (Prometheus alert)
- Worker logs: `job moved to DLQ` with `reason`
- Customer complaint: emails not delivered and no bounce event received

## What is the DLQ?

`deadLetterQueue` (BullMQ queue, prefix `{QUEUE_PREFIX}dlq`) collects jobs that exhausted all
retry attempts from `sendQueue`, `eventsQueue`, or `webhooksQueue`. Jobs land here after:
- Max retry count exceeded (default 5 attempts with exponential back-off)
- Non-retryable error (e.g. permanent validation failure)
- Worker crash during processing

Jobs in the DLQ **are not processed automatically** — every job here represents a message that
was not delivered to its intended destination.

## First 5 minutes

1. Check DLQ depth:
   ```bash
   # Via admin API
   curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     https://api.yourplatform.com/admin/queues/dlq
   ```

2. Inspect the failed jobs (Bull Board UI at `/admin/queues`):
   - Look at `failedReason` on each job
   - Group by job `name` (e.g. `send`, `deliver`, `process_event`)

3. Common failure patterns:
   | failedReason | Likely cause |
   |---|---|
   | `ECONNREFUSED` to SMTP/SES | Outbound network issue or SES quota |
   | `550 5.1.1` / `551` | Recipient mailbox doesn't exist (invalid address) |
   | `connection timeout` | Blocked port 25 or firewall change |
   | `insufficient quota` | Customer plan quota hit |
   | `pool_paused` | See `POOL_PAUSE` runbook |
   | `body_store_missing` | Body offload file missing from S3/disk |

## Triage by job type

### `send` jobs (message delivery failures)
```sql
-- Find messages in failed state with no corresponding event
SELECT m.message_id, m.customer_id, m.to_address, m.failure_reason, m.created_at
FROM messages m
WHERE m.status = 'failed'
  AND m.created_at > NOW() - INTERVAL '24 hours'
ORDER BY m.created_at DESC LIMIT 50;
```

For recoverable failures (transient network, quota now lifted), replay via:
```bash
curl -X POST https://api.yourplatform.com/admin/queues/dlq/retry-all \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### `deliver` jobs (webhook delivery failures)
Check `webhook_delivery_log.outcome = 'failed'`. If the endpoint is now healthy, use:
```bash
curl -X POST /v1/webhooks/:id/retry-failures \
  -H "Authorization: Bearer $CUSTOMER_TOKEN"
```

### `process_event` jobs
Rarely land in DLQ — usually a schema mismatch. Inspect payload, fix the handler, redeploy,
then replay.

## Replaying individual jobs

Via Bull Board UI:
1. Navigate to `/admin/queues` → Dead Letter Queue
2. Click the failed job → "Retry" button

Via Redis CLI (bulk replay — use carefully):
```bash
# Move all DLQ jobs back to the source queue's waiting list
redis-cli LRANGE {QUEUE_PREFIX}dlq:wait 0 -1 | xargs -I{} redis-cli LMOVE {QUEUE_PREFIX}dlq:wait {QUEUE_PREFIX}send:wait RIGHT LEFT
```

## Discarding jobs

Only discard if the failure is permanent (e.g. invalid message that can never succeed):
```bash
# Via Bull Board: click job → "Delete"
# This logs nothing — add a manual audit_log entry:
INSERT INTO audit_log (action, actor_type, metadata)
VALUES ('admin:dlq_discard', 'system', '{"job_id": "...", "reason": "permanent_invalid"}');
```

## Preventing recurrence

- **Quota exceeded**: upgrade customer plan or add pre-flight quota check before enqueueing.
- **SMTP network issues**: verify outbound port 25 is open; check SES sending limits in AWS console.
- **Body store missing**: ensure S3/NFS is mounted and body TTL is > message retention period.
- **Repeated DLQ growth**: lower `MAX_RETRIES` and add an alert on `mp_dlq_depth > 100` for 5 min.

## Postmortem questions
- How long did jobs sit in the DLQ before ops noticed? → lower alert threshold or add PagerDuty rule.
- Were customers notified of failed delivery? → check webhook events for `message.failed`.
- Should any job type have a longer back-off or more retries?
