# Suppressions

A suppression is a permanent record that tells the platform "never send to this address." Suppressions are enforced automatically on every send — you do not need to check them yourself. Sending to a suppressed address silently skips delivery (the message is not queued and quota is refunded).

---

## Why suppressions matter

Sending to addresses that have hard-bounced or complained is the fastest way to damage your sender reputation. Gmail, Outlook, and Yahoo track complaint rates per sending domain; sustained rates above 0.1% cause spam-folder placement and above 0.3% can get you blocklisted. The suppression list is your first line of defense.

**Suppressions are added automatically when:**
- A recipient hard-bounces (permanent delivery failure — mailbox does not exist, domain does not accept mail).
- A recipient marks your email as spam (complaint / Feedback Loop report).
- A recipient clicks your "Unsubscribe" link.

**You should add suppressions manually when:**
- A recipient contacts you directly to opt out.
- You are importing an existing customer list and know some addresses have previously bounced or complained.

---

## View your suppression list

```bash
curl "https://api.mailplatform.example/v1/suppressions" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

Filter by reason:

```bash
curl "https://api.mailplatform.example/v1/suppressions?reason=hard_bounce&limit=100" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

**Reason values**

| Reason | Added by |
|---|---|
| `hard_bounce` | Automatic — permanent delivery failure. |
| `complaint` | Automatic — spam report received via FBL. |
| `unsubscribe` | Automatic — recipient clicked your unsubscribe link. |
| `manual` | You — via the API or dashboard. |
| `invalid` | You — address is known to be invalid. |

---

## Add a suppression manually

```bash
curl -X POST https://api.mailplatform.example/v1/suppressions \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "reason": "unsubscribe",
    "notes": "Unsubscribed via in-app preference center on 2026-06-01"
  }'
```

---

## Remove a suppression

> **Caution:** Only remove a suppression when you have fresh, explicit, and documented opt-in consent from the recipient. Never remove a `hard_bounce` suppression to "retry" delivery — the mailbox does not exist and re-sending damages your reputation.

```bash
# URL-encode the email address
curl -X DELETE "https://api.mailplatform.example/v1/suppressions/user%40example.com" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

A `204 No Content` response means the suppression was removed. If the address was not suppressed, the call still returns `204` (idempotent).

---

## Bulk import

Import an existing do-not-email list. The API quality-scores the list before importing and rejects lists that are obviously dirty (high spam-trap density, excessive disposable addresses) to protect your reputation.

```bash
curl -X POST https://api.mailplatform.example/v1/suppressions/import \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "emails": [
      "alice@example.com",
      "bob@example.com",
      "charlie@example.com"
    ],
    "reason": "manual"
  }'
```

**Response `200`**
```json
{
  "imported": 3,
  "quality": {
    "total": 3,
    "valid": 3,
    "spam_traps": 0,
    "disposable": 0,
    "recommendation": "accept"
  }
}
```

If the list quality is too low, the API returns `422 list_quality_too_low` with quality details. To import despite the warning:

```json
{ "emails": [...], "reason": "manual", "force": true }
```

Using `force: true` is your acknowledgment that you accept the reputational risk.

---

## Export as CSV

Download your suppression list as a CSV — useful for syncing with a CRM, preference center, or another email provider.

```bash
curl "https://api.mailplatform.example/v1/suppressions/export" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -o suppressions.csv
```

Filter by reason or date:

```bash
curl "https://api.mailplatform.example/v1/suppressions/export?reason=unsubscribe&since=2026-01-01" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -o unsubs-since-jan.csv
```

The export is rate-limited to 10 requests/minute.

---

## SDK example

```ts
import { MailPlatformClient } from '@platform/sdk';

const mp = new MailPlatformClient({ apiKey: process.env.MAILPLATFORM_API_KEY! });

// List
const { suppressions } = await mp.suppressions.list({ reason: 'hard_bounce', limit: 100 });

// Add
await mp.suppressions.add('user@example.com', 'unsubscribe');

// Remove
await mp.suppressions.remove('user@example.com');

// Bulk import
const result = await mp.suppressions.import([
  'alice@example.com',
  'bob@example.com',
], { reason: 'manual' });
console.log(`Imported ${result.imported} addresses`);
```

---

## Global suppressions vs. unsubscribe groups

| | Global suppressions | Unsubscribe groups |
|---|---|---|
| Scope | Entire account — no mail of any kind | Topic-specific — only emails assigned to that group |
| Hard bounces | Always global | N/A (hard bounces are always global) |
| Complaints | Always global | N/A |
| User opt-out | Global (via the unsubscribe link with no group) | Group-scoped (via unsubscribe link with a group) |
| Re-subscribe | Possible (with consent) | Delete the member from the group |

Use [unsubscribe groups](./unsubscribe-groups.md) when your recipients should be able to opt out of one type of email (e.g., marketing newsletters) but still receive others (e.g., receipts and security alerts).
