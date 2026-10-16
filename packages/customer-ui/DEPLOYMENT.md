# Customer UI release checklist (AI excluded)

The local application is not evidence of an approved public deployment. Tests use dummy `.test` recipients and Mailpit. Do not substitute dummy configuration for verified DNS, provider credentials or TLS.

## Remaining campaign and integration work

Subject-line A/B campaigns use the original design's A/B fields: two distinct subjects, one saved template, random fixed 50/50 assignment and 2–100 consent-confirmed subscribers. Assignments are frozen before the existing atomic batch-send endpoint is called. Suppression/rejection may make accepted/delivered variant sizes unequal. This is not a content test, winner-selection engine, significance calculation or large-audience implementation. Recovery never resends uncertain recipients; when only committed messages can be recovered, missing rejection/suppression details remain explicitly unknown.

The next large-audience implementation must persist bounded recipient batches and immutable content, dispatch without storing a human session token, retain all existing domain/compliance/quota checks, and prove restart/concurrent-dispatch/cancellation behavior without duplicate broadcasts. Increasing the current limit is not sufficient. Large-audience sending is still blocked.

Recurring campaigns additionally need durable occurrence IDs, time-zone/DST rules, end conditions, per-occurrence audience/consent evaluation and duplicate-safe recovery after downtime. No browser timer or repeated one-off launch is presented as recurring support.

Workflow API triggers accept caller-provided business context, but they are not installed CRM/commerce integrations. Each remaining business connector needs a selected source, authenticated/signed ingress, tenant mapping, replay protection and real event-contract tests. Do not manufacture purchase/signup activity from dummy metrics or claim an external connector is active.

AI remains excluded. Public hosting/TLS/owned sender-domain acceptance remains dependent on a real target and owned domain; dummy recipients are used only for local capture tests.

## Local Docker

Run migrations as a dedicated release step, then recreate the application containers. Do not delete database volumes:

```powershell
docker compose build migrate api customer-ui
docker compose run --rm --no-deps migrate
docker compose up -d --no-deps api customer-ui
```

The integrated React app is on port 8080. The optional original-design comparison remains loopback-only on port 8081. The Nginx image derives its resolver from the container's `/etc/resolv.conf`; `API_UPSTREAM` defaults to `api:3000`, and `UI_LISTEN_PORT` defaults to 80. Browser API requests stay on `/api/`, forwarded internally to `/v1/`.

## Kubernetes preparation

The Helm chart now contains an optional `customerUi` deployment/service/TLS ingress and network policies allowing only ingress-controller traffic plus DNS/API egress. The API policy explicitly permits the customer proxy. It runs the UI as UID/GID 101 with a read-only root filesystem, dropped capabilities and writable ephemeral config/cache/tmp mounts. The chart defaults this component to disabled and uses a visibly dummy host. Do not deploy those defaults.

Before enabling `customerUi.enabled`, configure:

- A real image registry/repository and immutable release tag; build and scan the customer image with the same release as the API. CI now includes its build and image-scan matrix entry; the remote CI/registry has not been run from this workspace.
- A real frontend host and existing trusted TLS secret, plus an ingress controller and a CNI that enforces NetworkPolicy. The namespace selector currently assumes `ingress-nginx`; adapt it to the chosen controller namespace.
- Public `APP_BASE_URL` and explicit `CORS_ALLOWED_ORIGINS`. When not overridden in `api.env`, the chart derives these from the customer ingress host.
- Secret-managed production config from `.env.production.example`, separate non-bypass API/service/migrator database roles, an actual transport and account-mail delivery. Never commit a filled environment file or pass secrets as command-line values.

`helm lint` and `helm template` validate rendering, not a running Kubernetes cluster, DNS, certificate issuance, pod network reachability or real email delivery. The image's non-root/read-only runtime is tested locally as a separate check.

## Read-only release preflight

With production configuration supplied through secret-managed environment variables, run inside the API image:

```text
node packages/customer-ui/scripts/check-customer-release.cjs
```

This reuses the existing production secret/KMS/SSO/audit guard and adds frontend HTTPS/origin and delivery/account-mail checks. It prints field-level findings, not credential values, and makes no deployment, DNS or sending calls. The local dummy stack is expected to fail. Passing configuration validation does not verify credential validity, domain ownership or delivery.

## Acceptance before public launch

1. Apply migrations, verify fail-closed RLS under the actual API role, and test backups/restores in an isolated environment.
2. Validate HTTPS, certificate renewal, public account-email URLs and session recovery on the chosen host. Confirm no design-reference route or source map is served in the production build.
3. Run the fresh-customer browser suite against the packaged UI. Verify drafts, scheduling time-zone conversion, invitations, workflow history/cancellation, permissions and failure recovery.
4. Use a genuinely owned authenticated sending domain and an explicitly approved recipient for external testing. Verify SPF/DKIM/DMARC, return path, unsubscribe/suppression, provider limits, bounce/complaint processing and the actual recipient inbox. Mailpit cannot prove these.
5. Verify scheduled messages remain pending before their due time and recover from worker/Redis restarts without duplicate submissions. Test cancellation before dispatch; never promise to recall already-dispatched messages.
6. Test uncertain campaign launch recovery. It reconciles recorded results or nonce-bound committed messages only; unresolved/no-evidence outcomes remain blocked and are never automatically resent.
7. Validate rolling releases with already-open browser sessions. Hashed assets must remain available across versions (for example through versioned shared/CDN storage); serving different image asset sets during a rollout can otherwise break lazy-loaded screens. The current explicit Reload error recovery is not a zero-interruption deployment guarantee.
8. Complete realistic volume, monitoring/alerting, rollback and on-call acceptance. The current campaign bound remains 200 subscribers; resumable large-audience fan-out, A/B and recurring sends are not implemented by these changes.

AI is deliberately outside the current work scope. Public deployment and external sending have not been activated.
