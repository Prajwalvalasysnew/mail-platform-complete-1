# Sub-accounts

Run isolated tenants under one parent account — for resellers and ISPs
sending on behalf of clients, agencies and BPOs, school districts under a
central office, or franchise networks where corporate manages templates and
each location sends as itself.

Each sub-account is a **fully isolated tenant**: its own verified domains,
suppression list, API/SMTP credentials, templates, workflows, quotas, and
analytics. One client's spam complaint can never touch another client's
deliverability data, and clients can never see each other's traffic.

Billing stays with the parent; you govern each child's spend with per-child
daily/monthly quota caps.

## Create and manage

```bash
# Create (scope: subaccounts)
curl -X POST https://api.yourplatform.example/v1/subaccounts \
  -H "Authorization: Bearer $PARENT_KEY" -H "Content-Type: application/json" \
  -d '{ "name": "District North", "daily_quota": 5000, "monthly_quota": 100000 }'

# List / inspect / update (suspend, rename, adjust caps)
GET   /v1/subaccounts
GET   /v1/subaccounts/:id
PATCH /v1/subaccounts/:id      # { "status": "suspended" } blocks sends immediately
```

Sub-accounts cannot create their own sub-accounts (one level deep, by design).

## Two ways to send as a child

**1. Dedicated child credentials** (recommended for handing to a client):

```bash
curl -X POST https://api.yourplatform.example/v1/subaccounts/$SUB_ID/keys \
  -H "Authorization: Bearer $PARENT_KEY" -H "Content-Type: application/json" \
  -d '{ "name": "client-erp-relay" }'      # defaults to send + smtp scopes
```

The key belongs to the child: it can send via the API or the
[SMTP relay](./smtp-relay.md) from the child's verified domains only, and you
can revoke it per client (`DELETE /v1/subaccounts/:id/keys/:keyId`).

**2. On-behalf-of** (single credential for reseller platforms):

```bash
curl -X POST https://api.yourplatform.example/v1/send \
  -H "Authorization: Bearer $PARENT_KEY" \
  -H "X-On-Behalf-Of: $SUB_ID" \
  ...
```

The request executes fully in the child's context — child domains, child
suppressions, child quotas. The header is strictly validated: anything that
is not an active child of the authenticated org is refused with `403`.

## Reporting & templates

```bash
GET  /v1/subaccounts/usage?days=30
# → per-child sent/delivered/bounced/complained + family totals

POST /v1/subaccounts/templates/push
# { "template_id": "…", "subaccount_ids": "all" }
# Franchise model: corporate builds the template once, every location gets it
# (same-name templates on children are overwritten by the push).
```

## Onboarding a client, end to end

1. `POST /v1/subaccounts` — create the child with spend caps.
2. Register + verify the client's sending domain **under the child**
   (`POST /v1/domains` with the child credential, or `X-On-Behalf-Of`).
3. Mint the child a `send`/`smtp` credential and hand it to their system.
4. Watch the roll-up (`/v1/subaccounts/usage`) and each child's own
   [analytics](./activity-analytics.md).
5. Offboarding: `PATCH { "status": "suspended" }` stops sends instantly;
   revoke their keys.
