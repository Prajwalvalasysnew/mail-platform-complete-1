# Enterprise Deployment Notes

This repository can run locally with the development `docker-compose.yml`, but
that file intentionally contains local-only defaults. Enterprise deployment must
use a secret-managed production environment and the production overlay:

```bash
npm run prod:check -- .env.production
```

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.production.yml up -d --build
```

## Hard Requirements

- Set `NODE_ENV=production` for API, worker, tracker, and Haraka services.
- Replace every local/default secret: `JWT_SECRET`, `ENCRYPTION_KEY`,
  `VERP_SECRET`, `API_KEY_PEPPER`, `ADMIN_SESSION_PEPPER`,
  `USER_SESSION_PEPPER`, `MFA_RECOVERY_PEPPER`, `ADMIN_TOKEN`,
  `METRICS_TOKEN`, database password, and Redis password.
- Configure admin SSO with `OIDC_ISSUER_URL` and `OIDC_CLIENT_ID`.
- Keep `ADMIN_PASSWORD_LOGIN_DISABLED=true` in production; password-based admin
  login is for development/bootstrap only.
- Store production values in a real secret manager. Do not commit a filled
  `.env.production` file.
- Rotate `API_KEY_PEPPER` only with a customer API-key reissue plan; existing
  API keys are derived from the pepper.
- Rotate `ENCRYPTION_KEY` only with a DKIM/private-key migration plan if the
  database already contains encrypted key material.
- Keep `/metrics` behind a private network and require `METRICS_TOKEN` for all
  scrapes.
- Keep Postgres, Redis, and worker metrics off public host ports. The
  production overlay removes those development bindings.
- Prefer managed Postgres with PITR backups and managed Redis with auth/TLS.
- Prefer SES or another managed MTA for launch unless you already operate IP
  pools, PTR records, postmaster tooling, blocklist response, and warmup.

## 10/10 Braze/HubSpot-Class Gap List

- Tenant isolation: row-level ownership checks, org roles, audit export, and
  customer-scoped data retention policies.
- Deliverability operations: dedicated/shared IP pools, automated warmup,
  DNS health, Gmail Postmaster, Microsoft SNDS, ISP throttling, and blocklist
  incident workflows.
- Compliance: consent capture, unsubscribe guarantees, physical address
  enforcement, DSAR export/delete, data residency, DPA/SOC2 evidence, and
  legal hold controls.
- Reliability: multi-AZ database, Redis HA, zero-downtime migrations,
  idempotent workers, DLQ replay tooling, synthetic monitoring, and tested DR.
- Security: SSO/OIDC, MFA enforcement, least-privilege admin roles,
  secret manager/KMS, vulnerability gating, SBOM, WAF/rate limits, and
  tamper-evident audit logs.
- Observability: SLOs, dashboards per tenant and service, burn-rate alerts,
  trace sampling, on-call runbooks, and public/private status pages.
- Product maturity: campaign/segment workflows, template versioning, approval
  flows, experimentation, suppression UX, import validation, webhooks, SDKs,
  and backward-compatible API versioning.

## Verification

After deploying with real production secrets:

```bash
curl -i http://localhost:3000/metrics
curl -i http://localhost:4000/metrics
curl -i http://localhost:9100/metrics
```

All three unauthenticated requests must return `401`. Authenticated scrapes with
`Authorization: Bearer $METRICS_TOKEN` must return `200`.
