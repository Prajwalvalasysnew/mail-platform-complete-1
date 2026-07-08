# Runbook: IP Warmup

**When to use this:** when adding a new sending IP, recovering from a blocklisting, or onboarding a customer with a fresh dedicated IP pool.

---

## Why warmup matters

ISPs (Gmail, Yahoo, Outlook, etc.) build reputation per sending IP over time. A brand-new IP that immediately sends 100 000 emails looks like a botnet. ISPs rate-limit, defer, or block it. Reputation earned on one IP does **not** transfer to another IP — each IP must be introduced to ISPs gradually.

---

## The schedule built into this platform

`packages/shared/src/warmup.ts` enforces per-pool daily send caps that advance automatically when ≥ 80% of the prior day's cap was actually used:

| Stage | Daily cap |
|-------|-----------|
| 0     | 50        |
| 1     | 100       |
| 2     | 250       |
| 3     | 500       |
| 4     | 1,000     |
| 5     | 2,500     |
| 6     | 5,000     |
| 7     | 10,000    |
| 8     | 20,000    |
| 9     | 40,000    |
| 10    | 75,000    |
| 11    | 125,000   |
| 12    | 200,000   |
| 13    | 350,000   |
| 14    | 500,000   |
| 15    | 750,000   |
| 16    | 1,000,000 |
| 17+   | unlimited |

**Minimum days to reach 1 M/day:** 17 days of consistent sending at ≥ 80% of each day's cap. Real warmups typically take 3–6 weeks because volume naturally varies.

The `warmup-advance` CronJob runs at 06:00 UTC daily (`infra/k8s/mail-platform.yaml`). The per-IP scheduler job (`advanceIpWarmup`) mirrors this for individual IPs inside the pool.

---

## Adding a new IP or pool

1. **Insert the IP into `sending_ips`:**
   ```sql
   INSERT INTO sending_ips (ip, pool_name, status, warmup_stage)
   VALUES ('203.0.113.5', 'transactional', 'active', 0);
   ```
   Start at `warmup_stage = 0` (50/day cap).

2. **Insert the pool if it doesn't exist:**
   ```sql
   INSERT INTO ip_pools (name, warmup_stage)
   VALUES ('transactional', 0)
   ON CONFLICT (name) DO NOTHING;
   ```

3. **Configure the pool in Haraka** (`packages/haraka-outbound/config/`) to bind the new IP.

4. **Monitor Gmail Postmaster Tools** for this IP's reputation once sending starts. Set `GOOGLE_POSTMASTER_SA_KEY_JSON` so the daily ingest job picks it up.

5. **Check DNSBL listings daily** — the `blocklist-monitor` CronJob does this automatically and fires `BlocklistListing` Prometheus alerts. Low-volume IPs sometimes get listed by SORBS on first appearance; delist via the provider's web form.

---

## Manually advancing a stage (emergency override)

Only do this if you have confirmed positive reputation data (Google Postmaster showing HIGH, no blocklist listings, bounce rate < 2%).

```sql
UPDATE ip_pools
SET warmup_stage = <new_stage>
WHERE name = 'your-pool-name';

UPDATE sending_ips
SET warmup_stage = <new_stage>
WHERE pool_name = 'your-pool-name';
```

Then flush the Redis daily counter so the new cap applies immediately:
```bash
redis-cli DEL "warmup:your-pool-name:$(date +%Y-%m-%d)"
```

---

## Recovering from a blocklisting

1. **Pause the pool** to stop new sends to the affected IP:
   ```bash
   redis-cli SET "pool:action:your-pool-name" "pause" EX 86400
   ```

2. **Investigate** — check `blocklist_checks` table and Postmaster data:
   ```sql
   SELECT * FROM blocklist_checks
   WHERE ip = '203.0.113.5'
   ORDER BY checked_at DESC LIMIT 20;
   ```

3. **Fix the root cause** (list quality, bounce rate, sending patterns) before requesting delisting.

4. **Request delisting** from each provider that listed you. Typical sites:
   - Spamhaus: https://check.spamhaus.org/
   - SpamCop: https://www.spamcop.net/bl.shtml
   - Barracuda: https://www.barracudacentral.org/rbl/removal-request
   - SORBS: https://www.sorbs.net/

5. **Reset warmup stage** to at least 2 stages back from where the listing occurred — the IP needs to re-earn trust:
   ```sql
   UPDATE sending_ips SET warmup_stage = GREATEST(0, warmup_stage - 2) WHERE ip = '203.0.113.5';
   ```

6. **Re-enable the pool** once delisted and the cause is resolved:
   ```bash
   redis-cli SET "pool:action:your-pool-name" "ok" EX 3600
   ```

---

## Monitoring

| Signal | Where to look |
|--------|---------------|
| Current pool action | `redis-cli GET pool:action:<pool>` |
| Today's warmup usage | `redis-cli GET warmup:<pool>:<YYYY-MM-DD>` |
| Reputation snapshots | `SELECT * FROM ip_reputation ORDER BY snapshot_date DESC LIMIT 50;` |
| Blocklist history | `SELECT * FROM blocklist_checks WHERE listed = true ORDER BY checked_at DESC;` |
| Grafana panel | "Deliverability" → "Pool Health" dashboard |
| Postmaster | https://postmaster.google.com (requires service account access) |

---

## Checklist before going live on a new IP

- [ ] IP reverse DNS (PTR) matches the sending hostname
- [ ] SPF record includes the IP (or the sending domain's PTR)
- [ ] DKIM selector active (`SELECT * FROM dkim_keys WHERE status = 'active'`)
- [ ] DMARC policy set to `p=quarantine` or `p=reject`
- [ ] IP not listed on any major DNSBL at launch (`monitorAllBlocklists()`)
- [ ] Google Postmaster domain registered (needs 1 email before data appears)
- [ ] Microsoft SNDS registered at sendersupport.olc.protection.outlook.com
- [ ] `BOUNCE_PAUSE_THRESHOLD` and `COMPLAINT_PAUSE_THRESHOLD` confirmed in `.env`
- [ ] `warmup-advance` CronJob running in k8s
- [ ] Alertmanager routing to PagerDuty/Slack for `BlocklistListing` and `HighBounceRate`
