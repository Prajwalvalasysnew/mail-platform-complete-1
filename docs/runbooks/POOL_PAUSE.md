# Runbook: IP Pool Paused by Reputation Guard

## Trigger
- `mp_pool_paused{pool=...}` gauge = 1
- Worker logs: `reputation guard action` with `action: "pause"` or `action: "throttle"`
- Delivery rate drops for messages routed through the affected pool

## What happened
The reputation guard (`packages/worker/src/scheduler.ts` → `evaluatePoolHealth()`) detected that
one or more of the following thresholds were exceeded for this pool:
- **Bounce rate** (`mp_bounce_rate_gauge`) ≥ `BOUNCE_PAUSE_THRESHOLD` (default 10%)
- **Complaint rate** (`mp_complaint_rate_gauge`) ≥ `COMPLAINT_PAUSE_THRESHOLD` (default 0.5%)
- An IP in the pool is actively listed on a DNSBL (see `BLOCKLIST` runbook)

The pool is paused at the BullMQ level — new send jobs targeting it are not processed until
the pause is lifted.

## First 5 minutes

1. Confirm the current pool state:
   ```sql
   SELECT pool_id, status, bounce_rate_24h, complaint_rate_24h
   FROM ip_reputation
   WHERE pool_id = '<pool>'
   ORDER BY measured_at DESC LIMIT 5;
   ```

2. Identify which customers/campaigns are driving the elevated rates:
   ```sql
   SELECT customer_id, COUNT(*) AS sends,
          SUM(CASE WHEN event_type='bounced' THEN 1 ELSE 0 END) AS bounces,
          SUM(CASE WHEN event_type='complained' THEN 1 ELSE 0 END) AS complaints
   FROM events
   WHERE occurred_at > NOW() - INTERVAL '6 hours'
     AND pool = '<pool>'
   GROUP BY customer_id ORDER BY bounces DESC;
   ```

3. Inspect the blocklist check table for this pool's IPs:
   ```sql
   SELECT ip, provider, listed_at
   FROM blocklist_checks
   WHERE listed = true AND checked_at > NOW() - INTERVAL '12 hours'
   ORDER BY listed_at DESC;
   ```

## Determine action

| Situation | Action |
|---|---|
| Single customer driving spikes | Pause that customer (`UPDATE customers SET status='suspended' WHERE id=...`), then manually un-pause the pool |
| Purchased / unverified list used | Halt the campaign, suppress affected recipients |
| Blocklist listing | Follow `BLOCKLIST` runbook first |
| False-positive (testing, one-time transient) | Lower send rate, un-pause after 30 min if rates stabilize |

## Manually lifting the pause

Once the root cause is resolved, lift the pause through the admin API:
```bash
curl -X POST https://api.yourplatform.com/admin/reputation/pools/<pool>/unpause \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Or directly via Redis (last resort — bypasses audit trail):
```bash
redis-cli DEL pool:paused:<pool>
```

The reputation guard re-evaluates every 5 minutes. If rates are still elevated it will
re-pause the pool automatically.

## Recovery confirmation

Watch for the worker log line:
```
reputation guard: pool recovered to ok  { pool: "<pool>", prev_action: "pause" }
```
And check `mp_pool_paused{pool="<pool>"}` drops to 0 in Grafana.

## Postmortem questions
- Were bounce/complaint rates trending up for hours before the pause? If so, lower thresholds.
- Which customer(s) drove the spike? Consider per-customer pool isolation.
- Should this pool's IPs be moved to a dedicated pool for that customer tier?
