# Authentication

Every API request authenticates with a **Bearer token** in the `Authorization` header:

```
Authorization: Bearer YOUR_API_KEY
```

A missing or invalid header returns `401`. A valid key for the wrong scope returns `403 insufficient_scope`.

---

## Key types

| Prefix | Type | Use for |
|---|---|---|
| `mp_live_...` | Live key | Production sends. Actions have real effects. |
| `mp_test_...` | Test key | Development and CI. Full pipeline, no real delivery, no reputation impact. |
| `mp_pub_...` | Publishable key | Client-safe operations. Cannot hold the `send` scope. |

**Never expose a live key in client-side code** (browser JS, mobile apps, public repos). A live key with the `send` scope can send real email from your account. Use test keys in environments where the key might be visible.

---

## Creating a key

```bash
curl -X POST https://api.mailplatform.example/v1/account/api-keys \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "production-backend",
    "scopes": ["send", "messages"]
  }'
```

The key secret is returned **once** — store it immediately. The response also includes the key `id` you'll use for rotation and revocation.

---

## Scopes

Keys carry only the permissions they need. Calling an endpoint with a key that lacks the required scope returns `403 insufficient_scope`.

| Scope | Grants access to |
|---|---|
| `send` | `POST /v1/send`, `POST /v1/send/batch` |
| `domains` | Domain CRUD and verification |
| `suppressions` | Suppression and unsubscribe group management |
| `messages` | Read message status and events; account profile |
| `templates` | Template CRUD |
| `webhooks` | Webhook CRUD and delivery log |

**Least-privilege practice:** create separate keys per integration and grant only the scopes it needs. Your app server needs `send`; an analytics job reading message status only needs `messages`; a CRM syncing suppressions only needs `suppressions`.

---

## List your keys

```bash
curl https://api.mailplatform.example/v1/account/api-keys \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

Secrets are never returned after creation — the list shows only key IDs, names, scopes, and metadata.

---

## Rotating a key

Key rotation issues a new secret while keeping the old one valid during an overlap window (~48 hours), giving you time to update your environment variables without any downtime.

```bash
curl -X POST https://api.mailplatform.example/v1/account/api-keys/KEY_ID/rotate \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

The response includes the new secret. Update your environment before the overlap window expires.

---

## Revoking a key

```bash
curl -X DELETE https://api.mailplatform.example/v1/account/api-keys/KEY_ID \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

Revocation is immediate. If the key you are using to make API calls is compromised, contact support for emergency revocation.

---

## Key expiry

When creating a key you can set `expires_at` to enforce automatic expiry:

```bash
curl -X POST https://api.mailplatform.example/v1/account/api-keys \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ci-deploy",
    "scopes": ["send"],
    "expires_at": "2026-12-31T23:59:59Z"
  }'
```

A request using an expired key returns `401`.

---

## Best practices

- **Rotate keys regularly.** We recommend rotating all live keys every 90 days, and immediately if you suspect a leak.
- **Use environment variables.** Never hardcode a key in source code. Use `process.env.MAILPLATFORM_API_KEY`, dotenv, or your platform's secret manager.
- **One key per service.** If one service's key is compromised, you can revoke it without affecting other services.
- **Audit your keys.** Regularly review `GET /v1/account/api-keys` and delete keys that are no longer in use.
- **Set expiry on short-lived keys.** For keys used in one-off scripts or CI jobs, set an `expires_at` so they automatically become inert.

---

## If a key is compromised

1. Revoke it immediately: `DELETE /v1/account/api-keys/KEY_ID`.
2. Create a new key and deploy it.
3. Check `GET /v1/messages?since=<date-of-compromise>` to audit any sends made with the compromised key.
4. Contact support if you believe malicious sends were made.
