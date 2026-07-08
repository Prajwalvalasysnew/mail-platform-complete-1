# SDK reference

## Node.js / TypeScript (`@platform/sdk`)

The official client for the API. Requires Node 18+. Dependency-free (uses the global `fetch`). Fully typed against the OpenAPI contract.

### Install

```bash
npm install @platform/sdk
```

### Initialize

```ts
import { MailPlatformClient } from '@platform/sdk';

const mp = new MailPlatformClient({
  apiKey: process.env.MAILPLATFORM_API_KEY!,   // 'mp_live_...' or 'mp_test_...'
  baseUrl: 'https://api.mailplatform.example/v1',  // optional; defaults to production
  timeoutMs: 10_000,   // optional; per-request timeout
});
```

---

### Sending

```ts
// Single send
const result = await mp.messages.send({
  from: 'hello@mail.yourcompany.com',
  to: 'alice@example.com',
  subject: 'Welcome',
  html: '<h1>Hello</h1>',
  text: 'Hello',
  tags: ['welcome'],
  trackingOpens: true,
  trackingClicks: true,
  idempotencyKey: 'signup-12345',
});
console.log(result.message_ids[0]);

// Batch send
const batch = await mp.messages.sendBatch({
  messages: [
    { from: 'billing@mail.yourcompany.com', to: 'alice@example.com', templateId: 'tmpl_receipt', variables: { name: 'Alice', total: '$49' } },
    { from: 'billing@mail.yourcompany.com', to: 'bob@example.com',   templateId: 'tmpl_receipt', variables: { name: 'Bob',   total: '$89' } },
  ],
});
for (const r of batch.results) {
  if (!r.accepted) console.error(`Index ${r.index} rejected: ${r.error}`);
}
```

---

### Messages

```ts
// Get a single message + event timeline
const { message, events } = await mp.messages.get('msg_abc123');

// List messages with filters
const { messages, next_cursor } = await mp.messages.list({
  status: 'delivered',
  tag: 'receipt',
  since: '2026-06-01',
  limit: 100,
});

// Check quota usage
const usage = await mp.account.usage();
console.log(`Daily: ${usage.daily_used} / ${usage.daily_limit}`);
```

---

### Domains

```ts
const domains = await mp.domains.list();

// Add a domain (returns DNS records to publish)
const { domain } = await mp.domains.add('mail.yourcompany.com');
console.log('Publish these records:', domain.dns_records);

// Verify after publishing DNS
await mp.domains.verify(domain.id);

// Remove
await mp.domains.remove(domain.id);
```

---

### Templates

```ts
// Create
const { template } = await mp.templates.create({
  name: 'welcome',
  subject: 'Welcome, {{name}}!',
  htmlBody: '<h1>Hi {{name}}</h1><p>Your account is ready.</p>',
  textBody: 'Hi {{name}},\n\nYour account is ready.',
});

// Get / update / delete
await mp.templates.get(template.id);
await mp.templates.update(template.id, { subject: 'Hello {{name}}, welcome aboard!' });
await mp.templates.remove(template.id);
```

---

### Suppressions

```ts
const { suppressions } = await mp.suppressions.list({ reason: 'hard_bounce' });

await mp.suppressions.add('user@example.com', 'unsubscribe');
await mp.suppressions.remove('user@example.com');

// Bulk import
const result = await mp.suppressions.import(['a@example.com', 'b@example.com'], { reason: 'manual' });
console.log(`Imported ${result.imported}`);
```

---

### Unsubscribe groups

```ts
const { group } = await mp.unsubscribeGroups.create({ name: 'Newsletter' });
const { members } = await mp.unsubscribeGroups.listMembers(group.id);
await mp.unsubscribeGroups.addMembers(group.id, ['alice@example.com']);
await mp.unsubscribeGroups.removeMember(group.id, 'alice@example.com');
```

---

### Webhooks

```ts
// Create
const { id, signing_secret } = await mp.webhooks.create({
  url: 'https://yourapp.example.com/hooks/mail',
  events: ['delivered', 'hard_bounce', 'complaint'],
});
// Store signing_secret securely — shown only once

// List / delete
const { webhooks } = await mp.webhooks.list();
await mp.webhooks.remove(id);

// Rotate secret
const { signing_secret: newSecret } = await mp.webhooks.rotateSecret(id);

// View delivery log
const { deliveries } = await mp.webhooks.deliveries(id, { limit: 50 });
```

---

### Privacy / GDPR

```ts
// Delete all data for a recipient
const result = await mp.privacy.deleteRecipient('user@example.com');
console.log(`Deleted ${result.deleted.messages} messages`);

// Export data for a recipient (Art. 15 access request)
const data = await mp.privacy.exportRecipient('user@example.com');
```

---

### Error handling

Non-2xx responses throw `MailPlatformError`:

```ts
import { MailPlatformError } from '@platform/sdk';

try {
  await mp.messages.send({ from: 'x@unverified.com', to: 'a@b.com', subject: 'Hi', text: 'Hi' });
} catch (err) {
  if (err instanceof MailPlatformError) {
    console.error(err.status);    // HTTP status code (e.g. 403)
    console.error(err.code);      // Stable error code (e.g. 'domain_not_verified')
    console.error(err.message);   // Human-readable message
    console.error(err.requestId); // Include in support tickets
  }
}
```

---

### Webhook signature verification

```ts
import { verifyWebhookSignature, verifyWebhookSignatureAsync } from '@platform/sdk';

// Node.js (synchronous — Express / Fastify)
app.post('/hooks/mail', express.raw({ type: 'application/json' }), (req, res) => {
  const valid = verifyWebhookSignature(
    req.body.toString(),
    req.headers['x-mp-signature'] as string,
    process.env.MP_WEBHOOK_SECRET!
  );
  if (!valid) return res.sendStatus(401);
  const event = JSON.parse(req.body.toString());
  res.sendStatus(200);
});

// Edge / browser (Web Crypto — Cloudflare Workers, Deno, Next.js Edge)
export async function POST(req: Request) {
  const rawBody = await req.text();
  const valid = await verifyWebhookSignatureAsync(
    rawBody,
    req.headers.get('x-mp-signature') ?? undefined,
    process.env.MP_WEBHOOK_SECRET!
  );
  if (!valid) return new Response('Unauthorized', { status: 401 });
  const event = JSON.parse(rawBody);
  return new Response('OK');
}
```

---

### Custom `fetch` / proxy

```ts
const mp = new MailPlatformClient({ apiKey, fetch: myCustomFetch, timeoutMs: 10_000 });
```

---

## Other languages

The OpenAPI 3.1 spec is available at `GET /v1/openapi.json`. Use `openapi-generator` to generate a typed client:

```bash
# Python
openapi-generator generate -i https://api.mailplatform.example/v1/openapi.json \
  -g python -o ./sdk-python --package-name mailplatform

# Go
openapi-generator generate -i https://api.mailplatform.example/v1/openapi.json \
  -g go -o ./sdk-go

# PHP
openapi-generator generate -i https://api.mailplatform.example/v1/openapi.json \
  -g php -o ./sdk-php

# Ruby
openapi-generator generate -i https://api.mailplatform.example/v1/openapi.json \
  -g ruby -o ./sdk-ruby

# Java
openapi-generator generate -i https://api.mailplatform.example/v1/openapi.json \
  -g java -o ./sdk-java
```

Or use `openapi-typescript` for TypeScript types without the full SDK:

```bash
npx openapi-typescript https://api.mailplatform.example/v1/openapi.json -o ./types/mailplatform.d.ts
```
