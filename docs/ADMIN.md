# Admin / back-office API

The admin plane is a privileged, internal API — **fully separate from customer
API keys**. A customer key can never reach these endpoints. All routes are
mounted under `/admin` and require an admin session token (`Authorization:
Bearer mpadm_...`). Every privileged action is written to the audit log
(`action LIKE 'admin:%'`).

## Roles

Ascending privilege: `support` < `operator` < `admin` < `superadmin`. Each
endpoint declares a minimum role; a higher role always satisfies it.

| Capability | Min role |
| --- | --- |
| Customer support console, tickets, overview, pool health | `support` |
| Review-queue approve/reject, blocklist scan, customer plan/quota | `operator` |
| Suspend/reinstate customers, key rotation, audit log | `admin` |
| Manage admin users | `superadmin` |

## Bootstrapping the first admin

There is no admin self-signup. Provision the first `superadmin` from the CLI
(password is read from the environment, never argv):

```bash
ADMIN_PASSWORD='a-long-strong-password' \
  node packages/shared/dist/bin/create-admin.js you@company.com superadmin "Your Name"
# or in dev: ADMIN_PASSWORD=... npm run create-admin -- you@company.com superadmin "Your Name"
```

The command is idempotent: re-running it for an existing email rotates that
admin's password. After bootstrapping, all further admins are created through
the API by a `superadmin`.

## Authentication flow

```
POST /admin/auth/login      { email, password, code? } -> { token, role, expires_at }
GET  /admin/auth/me         (Bearer)                   -> { admin_user_id, email, role }
POST /admin/auth/logout     (Bearer)                   -> { ok: true }   # revokes this session
```

Sessions are opaque tokens, hashed at rest, with an 8-hour TTL. Disabling an
admin or resetting their password immediately revokes all of their live
sessions. OIDC/SSO login remains supported in parallel via `oidc_subject`.

## Admin MFA (TOTP)

Admins can enroll an authenticator-app TOTP factor after login:

```text
POST /admin/auth/mfa/enroll    (Bearer) -> { secret, otpauth_url }
POST /admin/auth/mfa/confirm   (Bearer) { code } -> { ok: true, totp_enabled: true }
POST /admin/auth/mfa/disable   (Bearer) -> { ok: true, totp_enabled: false }
```

After `totp_enabled` is true, `POST /admin/auth/login` requires a valid
6-digit `code` in addition to email and password. Missing codes return
`mfa_required`; invalid codes return `mfa_invalid`.

The TOTP secret is encrypted at rest in `admin_users.totp_secret` using the
platform secret-encryption helper (`ENCRYPTION_KEY` / KMS provider). Enrollment
stores a pending secret with `totp_enabled=false`; confirmation verifies a code
before enabling the factor.

## Admin user management (`superadmin`)

```
GET    /admin/admins                      -> { admins: [...] }
POST   /admin/admins                      { email, name?, role, password }   (201)
PATCH  /admin/admins/:id                  { role?, disabled?, name? }
POST   /admin/admins/:id/password         { password }
```

A superadmin cannot disable or demote their own account (`cannot_self_demote`),
preventing an accidental lock-out of the only privileged account.

## Customer management

```
GET   /admin/customers                    list / search
GET   /admin/customers/:id                overview (usage, domains, status)
PATCH /admin/customers/:id                { tier?, daily_quota?, monthly_quota? }   (operator)
POST  /admin/customers/suspend            { customer_id, reason? }                 (admin)
POST  /admin/customers/reinstate          { customer_id }                          (admin)
GET   /admin/customers/:id/support-notes  internal notes
POST  /admin/customers/:id/support-notes  add internal note
```

## Send moderation & deliverability ops

```
GET   /admin/review-queue                 messages held for review
POST  /admin/review-queue/:id/approve     (operator)
POST  /admin/review-queue/:id/reject      (operator)
GET   /admin/deliverability/pool-health   per-IP-pool health
POST  /admin/deliverability/blocklist-scan(operator)
POST  /admin/api-keys/rotate              { customer_id, api_key_id, name? }        (admin)
```

## CAN-SPAM unsubscribe monitoring (CANSPAM-05)

```
GET   /admin/canspam/unsubscribe-monitor?days=30   aggregated synthetic-check evidence
POST  /admin/canspam/unsubscribe-monitor/run       on-demand monitoring pass   (operator)
```

The worker runs the same checks every 6 hours: unsubscribe-chain validation
for commercial messages sampled across the 30-day window (always including
the oldest), a synthetic one-click suppression write with measured latency
(cleaned up afterwards), and an SLA scan that flags any opt-out in the ledger
without an enforced suppression. The report returns availability %, days with
checks, the oldest link age validated, max suppression latency, current SLA
violations, and recent failures — the monthly CAN-SPAM evidence package.

## Platform overview (dashboard data)

```
GET /admin/overview   ->
{
  "customers_by_status": { "active": 120, "suspended": 3 },
  "messages_24h": { "by_status": { "delivered": 9000, "hard_bounced": 40 }, "total": 9100 },
  "rates_24h": { "bounce_rate": 0.005, "delivery_rate": 0.989 },
  "send_queue": { "waiting": 12, "active": 4, "delayed": 0, "failed": 1 },
  "suppressions_total": 542
}
```

## Audit trail

```
GET /admin/audit?limit=100   -> { audit: [...] }   (admin)
```

Every admin mutation records the acting `admin_user_id`, `admin_email`,
`admin_role`, the action, the resource, and any metadata.
