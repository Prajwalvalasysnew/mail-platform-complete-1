# Runbook: Suspected API key compromise

## Trigger
- Customer reports unauthorized sends
- Volume anomaly (`mp_volume_anomalous_total` for one customer)
- Spike in low-engagement / high-complaint sends from one key

## First 5 minutes
1. **Revoke** the suspected key immediately — do not wait for the customer:
   ```sql
   UPDATE api_keys SET revoked_at = now() WHERE id = '<api_key_id>';
   ```
   Subsequent `Authorization: Bearer <plaintext>` requests will 401.
2. Identify in-flight damage: `SELECT message_id, to_address FROM messages WHERE api_key_id_used = '<id>' AND queued_at > now() - interval '1 hour'`.
   Cancel queued (not yet sent) jobs via BullMQ:
   ```bash
   redis-cli --scan --pattern 'bull:send:*' | xargs -L1 redis-cli GET | grep <message_id>
   ```
3. Notify the customer with the exact timeline and what data was exposed.

## Rotate
Use the audited admin endpoint:
```bash
curl -X POST $API/admin/api-keys/rotate \
  -H "Authorization: Bearer $ADMIN_SESSION" \
  -d '{"customer_id":"...","api_key_id":"..."}'
```
This issues a new key with a 48h overlap on the old one so the customer can cut over with no downtime.

## Forensics
- Pull every action by that key from `audit_log` (filter by `api_key_id`).
- Check the `last_used_at` and any IPs from `audit_log.ip`.
- If the new account was created < 30 days ago and KYC level is still `email`, treat as likely fraud signup.

## Hardening for next time
- Recommend the customer move to scoped keys (separate keys per service).
- Confirm they're not committing keys to git (offer to scan with Gitleaks).
- Encourage rotation cadence (every 90 days for production keys).
