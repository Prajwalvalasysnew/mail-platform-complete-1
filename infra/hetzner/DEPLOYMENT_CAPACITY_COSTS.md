# Hetzner deployment, capacity, storage, and cost guide

**Reviewed:** 2026-10-09

**Scope:** self-hosted Haraka delivery on Hetzner; Amazon SES is not part of
this design.

This guide separates repository facts from planning assumptions. Pricing and
capacity estimates are not service guarantees. Re-run the production load tests
and check the Hetzner order screen before each capacity or purchasing decision.

## Recommended deployment shape

Use the existing three-node k3s foundation in this directory for production.
It provisions:

- three cloud servers on a private network, with backups enabled;
- a public Hetzner `LB11` using private-IP targets;
- TCP/443 for the API and tracking ingress; and
- a declared TCP/587 load-balancer listener for SMTP submission.

The Helm chart starts with three API replicas, two workers, two trackers, one
outbound Haraka replica, and two inbound Haraka replicas. Its HPAs can scale the
API to 20 replicas and workers to 10 replicas, subject to available cluster
capacity. Tracker HPA values exist, but the chart has no tracker HPA template;
the tracker stays at two replicas until that gap is implemented.

The Terraform TCP/587 listener is also incomplete today: the Helm chart does
not deploy the repository's `smtp-gateway` service or expose node port 587.
Consequently the LB health check cannot succeed from this chart alone. Wire and
test that service before advertising SMTP submission. Haraka inbound declares
its own Kubernetes `LoadBalancer` service on port 25; confirm the Hetzner cloud
controller, firewall, public address, and MX path as part of cluster bootstrap.

A one- or two-node Docker Compose installation can be useful for a pilot, but it
is not created by this Terraform module and does not meet the repository's HA
requirements. Do not describe that pilot as the production/regulated topology.

The Terraform default is currently `cpx31`. That type is not present in
Hetzner's current EU price table. Before applying, select an available type in
`terraform.tfvars` and validate architecture compatibility. `CX33` is a
cost-optimized 4-vCPU/8-GB candidate; benchmark it because its shared CPU is not
a throughput guarantee. Use dedicated-vCPU plans when predictable sustained
mail processing matters more than minimum cost.

## Current Hetzner prices and budgeting

Hetzner's official 15 June 2026 adjustment lists these Germany/Finland prices,
excluding VAT and excluding IPv4:

| Resource | Monthly EUR | Monthly USD | Notes |
| --- | ---: | ---: | --- |
| CX23 | 5.49 | 6.49 | 2 vCPU, 4 GB RAM, 40 GB NVMe |
| CX33 | 8.49 | 9.99 | 4 vCPU, 8 GB RAM, 80 GB NVMe |
| CX43 | 15.99 | 18.49 | 8 vCPU, 16 GB RAM, 160 GB NVMe |
| CPX32 | 35.49 | 41.99 | current AMD regular-performance comparison |

Official references:

- [Hetzner price adjustment effective 15 June 2026](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
- [Hetzner Cloud server and network overview](https://docs.hetzner.com/cloud/servers/overview/)
- [Hetzner Primary IP and Floating IP limits](https://docs.hetzner.com/cloud/servers/primary-ips/faq/)

Hetzner documents a Primary IPv4 at EUR 0.50/month excluding VAT. A cloud
server can have only one Primary IPv4; additional IPv4s on the same server must
be Floating IPv4s. Check the console for the current Floating IPv4, load
balancer, volume, backup, and traffic prices because the server adjustment page
does not quote all of those add-ons.

Do not use the earlier “about USD 22/month” figure for this repository's HA
deployment. Even three CX33 instances alone are EUR 25.47/month before the
load balancer, IPv4/Floating IPs, backups, volumes, object storage, monitoring,
tax, and support. Record an order-screen estimate in the change ticket before
provisioning.

## Six sending IPs: what exists and what is missing

The application records IP pools, warmup state, and reputation. The worker adds
`X-MP-IP-Pool`, and Haraka captures and removes that internal header. This does
not yet select a source address.

The proposed “four shared plus two dedicated” layout therefore is **not ready
to deploy from this repository**. It still needs:

1. Terraform resources for one Primary IPv4 plus the required Floating IPv4s,
   including server assignment and outputs.
2. Persistent OS network configuration for every Floating IPv4 and a distinct
   PTR/rDNS hostname for every sending address.
3. A tested Haraka source-IP binding mechanism that maps an allowed pool to an
   address. The current outbound service otherwise uses the host's default IP.
4. A server-side tenant entitlement/mapping for dedicated pools. The public API
   currently accepts only `transactional`, `marketing`, or `quarantine`; there
   is no per-customer `dedicated-a`/`dedicated-b` assignment.
5. Tests proving that failover cannot silently send a dedicated customer's mail
   from a shared address.

Do not buy six addresses merely to spread low volume. Each address develops its
own reputation and needs steady warmup traffic. Add shared or dedicated IPs only
after postmaster data and measured daily volume justify them. Treat informal
thresholds such as 3,000-5,000 messages/day as starting hypotheses, not provider
guarantees.

## Users, concurrency, and message capacity

“Users” is not one capacity number:

| Dimension | What the repository proves today |
| --- | --- |
| Registered users/tenants | No small fixed software ceiling; database and operational limits apply. |
| Concurrent dashboard users | A realistic k6 scenario exists in `infra/loadtest/normal-users.js`, but no production result is recorded yet. |
| API send requests | The local in-process test measured about 164 one-recipient requests/second at concurrency 50. This is a development floor, not a Hetzner production rating. |
| Parallel send jobs | Docker Compose defaults to 50 per worker; Helm defaults to 100 per worker replica. SMTP/MX throttling can make safe throughput much lower. |
| Parallel webhook deliveries | 20 per worker replica in the current implementation. |
| Load balancer connections | Hetzner documents up to 10,000 connections for LB11; application, database, and node limits will usually be reached first. |
| Monthly email volume | Not yet certified for any Hetzner shape. The earlier 4-5 million/month claim has no production-like queue-drain/MTA test in this repository. |

Use `infra/loadtest/normal-users.js` for user/API behavior, `send.js` for send
admission, and `tracker.js` for open/click bursts. A production capacity number
is valid only when all of these hold for a sustained test:

- API and tracker p95/p99 remain inside the chosen SLO;
- send, event, and webhook queues return to baseline rather than growing;
- Postgres connection, CPU, disk latency, and storage headroom stay safe;
- Redis memory and persistence remain healthy;
- Haraka drains at least as fast as the accepted send rate while ISP limits are
  respected; and
- bounce/complaint rate and IP reputation remain acceptable.

Scale the tracker first when tracking traffic dominates. Scale workers based on
queue drain rate, and scale the database before adding replicas that would
exhaust its connection or I/O budget.

## Storage model and sizing

Postgres stores message metadata, events, webhook attempt logs, usage, and
audit/compliance data. Bodies remain in Postgres when `BODY_STORAGE=inline`.
They are offloaded and content-addressed only when `BODY_STORAGE=fs` or `s3` is
actually configured; campaign recipients with identical content can then share
one object.

Use the real variable names from `docs/STORAGE.md`: `BODY_S3_BUCKET`,
`BODY_S3_ENDPOINT`, `BODY_S3_REGION`, `BODY_S3_ACCESS_KEY_ID`,
`BODY_S3_SECRET_ACCESS_KEY`, `BODY_S3_FORCE_PATH_STYLE`, and `BODY_S3_PREFIX`.
The shorter `S3_*` names in the earlier proposal are not recognized.

The Docker Compose files currently do not pass the `BODY_*` settings into the
API and worker containers. Add that wiring before claiming that a Compose
deployment offloads bodies. Kubernetes uses the existing secret as an env
source, so place the keys there and verify a real write/read/delete cycle.

### Planning formula

Size from rows, not tenant count:

```text
hot messages = monthly messages * RETENTION_MESSAGE_DAYS / 30.4
hot events = monthly messages * events per message * RETENTION_EVENT_DAYS / 30.4
webhook attempts = monthly messages * subscribed events per message
                   * average attempts * RETENTION_WEBHOOK_LOG_DAYS / 30.4
object bytes = unique body bytes created inside RETENTION_BODY_DAYS
```

Current engineering defaults are 395 days for message metadata, 90 days for
events and bodies, and 30 days for webhook delivery logs. Audit rows are
archived rather than destroyed, while suppressions, consent records, privacy
tombstones, and deletion evidence intentionally do not expire. Legal holds and
open access requests can retain additional rows.

Example row counts, assuming four events per message, one subscribed webhook
event per message, and successful webhook delivery on the first attempt:

| Tenant send rate | Hot message rows (395d) | Hot event rows (90d) | Webhook log rows (30d) |
| --- | ---: | ---: | ---: |
| 10,000/month | about 130,000 | about 118,000 | about 9,900 |
| 100,000/month | about 1.30 million | about 1.18 million | about 99,000 |

This table deliberately does not convert rows to GB. Row width, JSON payloads,
indexes, dead tuples, attachments, number of tracked links, and webhook retry
rate change the answer substantially. Measure a representative seeded database
with `pg_total_relation_size`, include at least 30% free disk headroom, and add
WAL, temporary-space, backup, and restore-room allowances. The existing scale
benchmark proves lifecycle operations on 200,000 messages and 2 million events;
it does not prove a complete tenant storage cost.

## Event, webhook, and database growth controls

The implementation has bounded-growth controls, but they must be operated:

- delivery events and messages are monthly partitioned;
- the daily retention scheduler removes expired data and records evidence;
- `RETENTION_EVENT_DAYS`, `RETENTION_MESSAGE_DAYS`, `RETENTION_BODY_DAYS`, and
  `RETENTION_WEBHOOK_LOG_DAYS` control the main hot-data windows;
- ClickHouse is optional and receives the analytics copy only when
  `EVENTS_CLICKHOUSE_URL` is configured; its TTL must be kept equal to the
  Postgres event-retention promise;
- webhook jobs use BullMQ, 20-way worker concurrency, a 10-second default
  timeout, and up to 12 capped-exponential attempts over roughly 20 hours;
- network failures, HTTP 408/429, and 5xx responses retry; ordinary 4xx responses
  are recorded and dropped; exhausted jobs go to the manual replay DLQ; and
- `webhook_delivery_log` records every attempt and is purged after 30 days by
  default.

Monitor queue depth, oldest-job age, retry count, DLQ count, retention-run age,
default-partition row count, ClickHouse reconciliation lag, and Postgres disk
growth. A DLQ has no automatic consumer; operators must inspect, replay, or
purge it using the documented runbook.

## Plans, pricing, and ROI

The implemented quota keys are `free` (3,000/month), `starter`
(50,000/month), `pro` (1,000,000/month), and `enterprise`
(50,000,000/month). Monetary prices are not defined by the repository; real
provider price IDs are supplied through billing configuration.

Set prices from measured cost rather than the earlier USD 0.01-0.02 per 1,000
claim, which is not supported by a production cost run. For each plan calculate:

```text
monthly cost to serve = allocated fixed infrastructure
                      + storage and backup growth
                      + IPv4/dedicated-pool allocation
                      + payment fees
                      + support and deliverability labor
                      + abuse/fraud reserve

contribution margin = plan revenue - monthly cost to serve
gross margin % = contribution margin / plan revenue * 100
customer LTV = contribution margin / monthly logo churn
LTV:CAC = customer LTV / customer acquisition cost
CAC payback months = customer acquisition cost / contribution margin
```

Use an LTV:CAC target of at least 3:1 and a CAC payback target below six months
as business guardrails, not infrastructure guarantees. Price a dedicated IP as
a separate add-on only after its address cost, operational work, warmup risk,
and support burden are known. Free sending must remain verification/abuse gated
because shared-IP reputation is the scarce resource.

## Production decision gates

Before publishing a customer or plan capacity:

1. Choose the actual Hetzner types and obtain a current quote for every server,
   IPv4/Floating IP, load balancer, volume, backup, and traffic item.
2. Implement and verify body-storage configuration in the selected deployment
   path.
3. Run the three workload models for at least one retention/queue cycle and save
   the results with the node types and application commit.
4. Measure bytes per message/event/webhook attempt using production-like data.
5. Prove restore, retention, partition, queue recovery, and MTA failover.
6. Implement and test source-IP binding before selling shared/dedicated pools.
7. Recompute plan margin using measured utilization, support time, payment
   fees, churn, and CAC.
