# Rate limits

Limits protect the platform and your reputation. They are applied per API key.

| Scope | Default limit |
| --- | --- |
| All endpoints | 1000 requests / minute |
| `POST /v1/send` | 300 requests / minute |

(Deployments can tune these via `API_RATE_LIMIT_PER_MINUTE` and
`SEND_RATE_LIMIT_PER_MINUTE`.)

Separately from request rate, your account has **sending quotas** (`daily_quota`,
`monthly_quota`). Exceeding a quota returns `429` from the send endpoint even if
you're under the request-rate limit.

## Headers

Responses include the standard rate-limit headers as you approach the limit:

```
x-ratelimit-limit: 1000
x-ratelimit-remaining: 42
x-ratelimit-reset: 37          # seconds until the window resets
```

## Handling 429

A throttled request returns `429` with the error envelope and a `retry-after`
hint. Back off and retry — exponential backoff with jitter is recommended:

```python
import time, random, requests

def send_with_retry(payload, headers, attempts=5):
    for i in range(attempts):
        r = requests.post("https://api.mailplatform.example/v1/send", json=payload, headers=headers)
        if r.status_code != 429:
            return r
        wait = min(2 ** i + random.random(), 30)
        time.sleep(wait)
    r.raise_for_status()
```

For high-volume sending, smooth your request rate rather than bursting, and
spread large campaigns over time to protect deliverability.
