# Runbook: Sending IP listed on a DNSBL

## Trigger
- `mp_blocklist_listings{provider=...}` gauge > 0
- `mail-worker` logs: `sending IP(s) listed on DNSBL`
- Bounce surge with `5.7.x` codes mentioning the listing provider

## First 5 minutes
1. Confirm the listing — don't trust a stale cache:
   ```bash
   dig +short $LISTED_IP.zen.spamhaus.org
   dig +short $LISTED_IP.b.barracudacentral.org
   ```
   A returned A record (e.g. `127.0.0.2`) confirms the listing.
2. Identify the pool: `SELECT pool_id, status FROM sending_ips WHERE ip = '$LISTED_IP';`
3. **Pause** the IP so no further sends use it:
   ```sql
   UPDATE sending_ips SET status='paused' WHERE ip='$LISTED_IP';
   ```
   The reputation guard's per-pool action does not pause individual IPs — this manual step is required.

## Root cause analysis
- Pull the last 24h of sends from this IP:
  `SELECT customer_id, COUNT(*), AVG(risk_score) FROM messages WHERE ... GROUP BY customer_id ORDER BY 2 DESC;`
- Anomalous volume from one customer? → suspect compromised key. Rotate via `POST /admin/api-keys/rotate`.
- High complaint rate on one campaign? → halt the campaign, review for purchased lists.
- Check `recipient_domain_intel` for spam_trap hits — even one is decisive.

## Delisting
Each provider has its own process:
- **Spamhaus**: https://www.spamhaus.org/lookup/ → request removal. Be honest about cause + remediation.
- **SpamCop**: usually clears after 24h of zero reports.
- **Barracuda**: https://www.barracudacentral.org/rbl/removal-request
- **SORBS**: https://www.sorbs.net/lookup.shtml

Never request delisting before the root cause is fixed. Provider operators check.

## Recovery
1. After delisting confirmed clear (`dig` shows NXDOMAIN), set the IP back to `warmup_stage=0`, `status='active'`.
2. Treat it as a brand-new IP — the warmup ramp will protect it.
3. Add an incident note to `audit_log` with `action='admin:incident_blocklist'`.

## Postmortem questions
- Why didn't the reputation guard catch this earlier? Were bounce/complaint metrics elevated for hours before listing?
- Should `BOUNCE_PAUSE_THRESHOLD` / `COMPLAINT_PAUSE_THRESHOLD` be lowered?
- Is one customer driving disproportionate risk? Tighten their tier or require KYC upgrade.
