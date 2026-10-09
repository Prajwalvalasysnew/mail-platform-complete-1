# Load tests

The load-test directory contains three different workload models:

- `normal-users.js`: realistic mixed customer traffic. Use this first.
- `send.js`: send-path saturation and throughput ceiling.
- `tracker.js`: high-volume open/click tracking bursts.

## Normal-user baseline

`normal-users.js` combines customer-dashboard journeys with steady
transactional application traffic. Dashboard users load several overview
resources in parallel, pause to read, and navigate to one secondary page.
The sender produces a natural mix of welcome, receipt, and password-reset
messages. It creates and later revokes a one-day test-mode API key, so messages
exercise the platform without being delivered externally.

Docker Desktop example (PowerShell):

```powershell
docker run --rm -i `
  -v "${PWD}/infra/loadtest:/scripts" `
  -e API_URL=http://host.docker.internal:3000 `
  -e LOAD_USER_EMAIL=your-test-user@local.test `
  -e LOAD_USER_PASSWORD='your-password' `
  -e FROM_ADDRESS=load@your-verified-domain.test `
  -e LOAD_DURATION=2m `
  -e DASHBOARD_VUS=5 `
  -e SEND_RATE=2 `
  grafana/k6 run /scripts/normal-users.js
```

Safe defaults are one transactional send per second, three concurrent dashboard
users, and a one-minute steady period. The test refuses non-local targets unless
`ALLOW_REMOTE_LOAD=1` is explicitly provided. A caller-supplied `API_KEY` must
be a test key unless `ALLOW_LIVE_SEND=1` is explicitly provided.

Increase one dimension at a time. First raise `DASHBOARD_VUS` to measure read
and analytics behavior, then raise `SEND_RATE` to measure queue admission and
worker drain behavior. Watch Prometheus, Grafana, PostgreSQL, Redis, worker queue
depth, and ClickHouse reconciliation lag during longer runs.
