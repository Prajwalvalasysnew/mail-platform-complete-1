# Runbook: DKIM verification failures spiking

## Trigger
- `dmarc_pct_pass` dropping
- Inbox providers reporting `dkim=fail` in headers
- Customer complaints about mail going to spam

## First 5 minutes
1. Confirm DNS hasn't been wiped/changed for the customer's domain:
   ```bash
   dig +short TXT mp202601._domainkey.customer.example
   ```
   If empty: their DNS provider has lost the record. Re-publish from `dkim_keys.public_key`.
2. Confirm the active selector matches what we're signing with:
   ```sql
   SELECT selector, state FROM dkim_keys WHERE domain_id = '<id>' ORDER BY state;
   ```
   Exactly one row should be `active`. If more or none, fix immediately:
   ```sql
   -- Promote a specific selector
   UPDATE dkim_keys SET state='retiring' WHERE domain_id='<id>' AND state='active';
   UPDATE dkim_keys SET state='active', activated_at=now() WHERE domain_id='<id>' AND selector='<sel>';
   ```
3. Send a probe via the test-mode key to a Gmail / Yahoo address you control and inspect the headers.

## If a key is compromised
1. Create a new pending key, publish DNS, wait for propagation, promote.
2. Mark the old key `retiring`; after 7 days the scheduler retires it. Then remove the DNS record.

## Bulk-fix script
A common cause: a customer's CDN proxy strips the DKIM TXT. Verify with a non-cached resolver (`+nocache`) before assuming the key is wrong.
