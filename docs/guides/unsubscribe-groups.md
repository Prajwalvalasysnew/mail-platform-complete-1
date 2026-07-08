# Unsubscribe groups

Unsubscribe groups let recipients opt out of specific categories of email without opting out of everything. A recipient can unsubscribe from your weekly newsletter but still receive receipts and account alerts.

Without groups, every "Unsubscribe" click adds the recipient to the global suppression list — they receive nothing further. With groups, a click on a group-scoped unsubscribe link opts them out only from emails in that group.

---

## Overview

1. Create a group (e.g., "Marketing Newsletters").
2. When sending, include `unsubscribe_group_id`.
3. When the recipient clicks "Unsubscribe", they are added to that group's opt-out list — not the global suppression list.
4. Future sends that reference the same `unsubscribe_group_id` automatically skip that recipient.
5. The recipient still receives emails on other groups, and any email sent without a `unsubscribe_group_id`.

---

## Create a group

```bash
curl -X POST https://api.mailplatform.example/v1/unsubscribe-groups \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Marketing Newsletters",
    "description": "Weekly product updates and promotions",
    "is_default": false
  }'
```

**Response `201`**
```json
{
  "group": {
    "id": "grp_01ABCDEF",
    "name": "Marketing Newsletters",
    "description": "Weekly product updates and promotions",
    "is_default": false,
    "created_at": "2026-01-01T00:00:00.000Z"
  }
}
```

Typical groups for a SaaS product:

| Group | Who should use it |
|---|---|
| Marketing Newsletters | Promotional emails, product updates, blog digests |
| Product Announcements | New feature releases |
| Onboarding Sequences | Welcome and activation emails |
| Account Alerts | Security and account activity notifications |

Transactional emails (receipts, password resets, two-factor codes) should generally not be assigned to a group — recipients cannot and should not opt out of those.

---

## Send with a group

Add `unsubscribe_group_id` to the send call:

```bash
curl -X POST https://api.mailplatform.example/v1/send \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "updates@mail.yourcompany.com",
    "to": "alice@example.com",
    "subject": "This week at Acme",
    "html": "<p>Here are the highlights...</p>",
    "unsubscribe_group_id": "grp_01ABCDEF",
    "tracking_opens": true
  }'
```

The platform automatically:
- Adds a `List-Unsubscribe` header to the email (required by Google and Yahoo for bulk senders).
- Adds a `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header for RFC 8058 one-click unsubscribe.
- Appends or adjusts the unsubscribe link in the email footer.
- Checks group membership before delivery — if the recipient previously unsubscribed from this group, the message is silently skipped.

---

## Check group members (opt-outs)

```bash
curl "https://api.mailplatform.example/v1/unsubscribe-groups/grp_01ABCDEF/members" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

**Response `200`**
```json
{
  "members": [
    { "email": "alice@example.com", "unsubscribed_at": "2026-06-01T10:00:00.000Z" }
  ]
}
```

---

## Seed a group (migrate from another platform)

If you are migrating from SendGrid, Mailjet, or another provider, seed your existing opt-outs into a group:

```bash
curl -X POST https://api.mailplatform.example/v1/unsubscribe-groups/grp_01ABCDEF/members \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "emails": [
      "alice@example.com",
      "bob@example.com"
    ]
  }'
```

**Response `200`**
```json
{ "added": 2 }
```

Duplicate entries are silently ignored (idempotent).

---

## Re-subscribe a member

If a recipient contacts you to re-subscribe and you have documented their consent:

```bash
curl -X DELETE \
  "https://api.mailplatform.example/v1/unsubscribe-groups/grp_01ABCDEF/members/alice%40example.com" \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

A `204 No Content` response means the member was removed. Only call this with proof of fresh opt-in — re-subscribing without consent is a CAN-SPAM and GDPR violation.

---

## Manage groups

```bash
# List all groups
curl https://api.mailplatform.example/v1/unsubscribe-groups \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"

# Update a group
curl -X PATCH https://api.mailplatform.example/v1/unsubscribe-groups/grp_01ABCDEF \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Weekly Newsletter", "is_default": true }'

# Delete a group
curl -X DELETE https://api.mailplatform.example/v1/unsubscribe-groups/grp_01ABCDEF \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

Setting `is_default: true` makes this the group used when a subscription-related message doesn't specify a group. Only one group can be the default at a time.

---

## One-click unsubscribe (RFC 8058)

When you include a `unsubscribe_group_id`, the platform adds the `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header automatically. This allows mail clients (Gmail, Apple Mail, Outlook) to display a one-click "Unsubscribe" button at the top of the email. When the user clicks, the client sends a POST request directly — no confirmation page required.

Google requires one-click unsubscribe for senders sending more than 5 000 messages per day to Gmail. Not having it will hurt inbox placement for high-volume senders.

---

## SDK example

```ts
import { MailPlatformClient } from '@platform/sdk';

const mp = new MailPlatformClient({ apiKey: process.env.MAILPLATFORM_API_KEY! });

// Create group
const { group } = await mp.unsubscribeGroups.create({
  name: 'Marketing Newsletter',
  description: 'Weekly digest of product updates',
});

// Send with group
await mp.messages.send({
  from: 'updates@mail.yourcompany.com',
  to: 'subscriber@example.com',
  subject: 'This week at Acme',
  html: '<p>Here are this week\'s highlights...</p>',
  unsubscribeGroupId: group.id,
});

// Check who unsubscribed
const { members } = await mp.unsubscribeGroups.listMembers(group.id);
console.log(`${members.length} people have opted out of this group`);
```
