# Runbook: Send queue backpressure / 503s

## Trigger
- API returns `503 backpressure` to `/v1/send`
- `mp_backpressure_rejections_total` rate climbing
- Send-queue waiting depth > `SEND_QUEUE_BACKPRESSURE` (default 100,000)

## Read the signal
The 503 means workers can't drain as fast as we're accepting. Either:
1. **Workers are slow** (downstream MTA blocked, DB contention)
2. **Workers are too few** (autoscaler hasn't caught up, or capped)
3. **Genuine spike** (legitimate load above provisioned capacity)

## Diagnose
```bash
# Queue depth
redis-cli LLEN bull:send:wait
# Worker activity
kubectl -n mail-platform top pod -l app=mail-worker
# Send latency
curl -s http://api:3000/metrics | grep mp_send_duration
# DLQ growth (jobs failing rather than just queueing)
redis-cli LLEN bull:send:dead-letter
```

## Mitigate
- Scale workers: `kubectl -n mail-platform scale deploy/mail-worker --replicas=N`
- If MTA is the bottleneck: check Haraka outbound logs and concurrency.
- If DB is the bottleneck: look for slow queries; the most likely culprit is the events insert in event-worker — confirm `events_message_id_idx` exists.

## When to lift the 503
Backpressure is self-healing: once queue depth drops below threshold, accepts resume automatically. **Do not** raise `SEND_QUEUE_BACKPRESSURE` to hide the problem — it just trades 503s for unbounded latency and memory growth.

## Long-term
- Pre-scale before known peaks (newsletter sends, campaign blasts).
- Move to KEDA scaling on `bull:send:wait` length so workers ramp with queue depth, not CPU.
