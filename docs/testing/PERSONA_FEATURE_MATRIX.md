# Persona end-to-end feature matrix

This document records the behavior the product implements today. Persona tests
must validate this contract; they must not invent Free/Paid/Enterprise paywalls
that are not enforced in the application.

## Access model

- Plan tier currently changes quota, billing state, and send-lane priority.
- API functionality is authorized primarily by API-key scope.
- Dashboard functionality is authorized primarily by membership capability.
- Account status, email verification, physical address, and verified sender
  domain are independent delivery gates.
- A future commercial-entitlements project may narrow this matrix. Such a
  change requires product approval and dedicated allow/deny tests.

## Tier differences implemented today

| Contract | Free | Paid Pro | Enterprise |
| --- | ---: | ---: | ---: |
| Daily quota | 100 | 50,000 | 1,000,000 |
| Monthly quota | 3,000 | 1,000,000 | 50,000,000 |
| Standard send priority | 10 | 5 | 1 |
| Requested critical lane | Downgraded | Eligible | Eligible |
| Billing plan | `free` | `pro` | `enterprise` |

## Customer feature coverage

`All` means the feature is available to every tier when the required scope or
human capability is present.

| Feature surface | Authorization today | Tier today | Persona E2E batch |
| --- | --- | --- | --- |
| API-first signup and email verification | Public token | All (starts Free) | Free onboarding |
| Human registration, login, logout, password reset | User session | All | Common account lifecycle |
| Active sessions and organization switching | Full user session | All | Common account lifecycle / enterprise RBAC |
| MFA and passkeys | User session | All | Common security |
| API-key create, list, rotate, revoke | `apikeys:manage` | All | Common credentials |
| Profile, address, TLS-required setting | `messages` scope | All | Common sending setup |
| Dashboard domain lifecycle | `domains:manage` | All | Common domains |
| API domain lifecycle and scanner | `domains` scope | All | Common domains |
| DMARC ingestion, summary, and sources | `domains` scope | All | Common deliverability |
| Native REST send and batch send | `send` scope | All | Common delivery |
| Template lifecycle and template send | `templates` scope | All | Common content |
| Attachments and body offload | `send` scope | All | Common content |
| Scheduled send and cancellation | `send` + `messages` | All | Common delivery |
| Critical send lane | `send` scope | Paid/Enterprise eligible | Tier differences |
| SMTP gateway | `smtp` + `send` scopes | All | Channel parity |
| SendGrid compatibility API | `send` scope | All | Channel parity |
| SDK | Underlying API-key scopes | All | Channel parity |
| Message list, detail, and activity | `messages` scope | All | Common observability |
| Usage, quota, stats, analytics | `messages` scope | All | Common observability |
| Suppressions and consent history | `suppressions` scope | All | Common consent |
| Unsubscribe groups and members | `suppressions` scope | All | Common consent |
| Customer webhooks and retries | `webhooks` scope | All | Common integrations |
| Dashboard webhooks | `settings:manage` | All | Common integrations |
| Workflows, versions, runs, simulation | `workflows` scope | All | Common automation |
| Data exports | `messages` scope | All | Common privacy/export |
| Recipient export and deletion | `messages` scope | All | Common privacy/export |
| Legal holds | `messages` scope | All | Isolated compliance |
| Support tickets and CSAT | `logs:read` | All | Common support |
| Team invitations and role changes | `members:manage` | All | Enterprise governance |
| SSO enforcement | `settings:manage` | All | Enterprise governance |
| SCIM tokens and SCIM provisioning | `members:manage` / SCIM token | All | Enterprise governance |
| Subaccounts and on-behalf-of sending | `subaccounts` scope | All | Enterprise governance |
| Customer audit feed and integrity | `logs:read` / `members:manage` | All | Enterprise governance |
| Billing overview and invoices | `billing:manage` | All | Paid/enterprise billing |
| Plan changes and provider lifecycle | `billing:manage` | All | Tier differences / billing |

## Cross-cutting assertions

Every persona feature journey must assert the applicable layers:

1. HTTP response and stable error code.
2. Tenant-owned database state.
3. Queue and worker completion for asynchronous operations.
4. Message event history and usage accounting.
5. Mailpit recipient, sender, subject, and body for delivered email.
6. Scope, role, and cross-tenant denial paths.
7. Admin API/console visibility in the safe development replay.
8. Idempotency and absence of duplicate rows or double-counted usage.

## Execution environments

- Canonical suites use isolated Postgres/Redis and may exercise destructive or
  global behavior.
- Safe development replays use unique run-tagged tenants, development Mailpit,
  and the admin console. They never run global retention, partition deletion,
  DLQ purge, audit tampering, or broad cleanup.
