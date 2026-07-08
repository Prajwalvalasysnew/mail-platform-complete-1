# Templates

Templates let you define email content once and reuse it across many sends. They support `{{variable}}` substitution so each recipient gets personalized content without repeating the full HTML in every API call.

---

## Create a template

```bash
curl -X POST https://api.mailplatform.example/v1/templates \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "welcome",
    "subject": "Welcome to Acme, {{name}}!",
    "html_body": "<h1>Hi {{name}},</h1><p>Your account is ready. <a href=\"{{dashboard_url}}\">Go to your dashboard</a>.</p>",
    "text_body": "Hi {{name}},\n\nYour account is ready.\nDashboard: {{dashboard_url}}"
  }'
```

**Response `201`**
```json
{
  "template": {
    "id": "tmpl_01ABCDEF",
    "name": "welcome",
    "subject": "Welcome to Acme, {{name}}!",
    "created_at": "2026-01-01T00:00:00.000Z"
  }
}
```

Save the `id` — you'll use it in the send call.

---

## Send with a template

Pass `template_id` instead of `subject`, `html`, and `text`. Supply substitution values in `variables`.

```bash
curl -X POST https://api.mailplatform.example/v1/send \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "hello@mail.yourcompany.com",
    "to": "alice@example.com",
    "template_id": "tmpl_01ABCDEF",
    "variables": {
      "name": "Alice",
      "dashboard_url": "https://app.yourcompany.com/dashboard"
    }
  }'
```

When `template_id` is set:
- `subject` from the template is used (you cannot override it inline).
- `html` and `text` are rendered from the template.
- You do not need to supply `subject`, `html`, or `text` in the send call.

---

## Template syntax

Templates use **Handlebars** syntax. A few key patterns:

### Variable substitution
```handlebars
Hello, {{first_name}}!
Your order total is {{order_total}}.
```

Any value in `variables` is HTML-escaped when rendered into `html_body`. This prevents injection — a variable like `<script>` renders as `&lt;script&gt;`. Plain-text versions are not escaped.

### Conditional blocks
```handlebars
{{#if has_promo}}
  Use code {{promo_code}} for 20% off your next order.
{{/if}}
```

### Loops
```handlebars
<ul>
  {{#each items}}
    <li>{{this.name}} — {{this.price}}</li>
  {{/each}}
</ul>
```

### Nested objects
```handlebars
Shipping to: {{address.street}}, {{address.city}}
```

Pass as `"variables": { "address": { "street": "123 Main St", "city": "Boston" } }`.

### Default / fallback values
Handlebars renders an empty string for a missing key. Use a conditional to provide fallbacks:

```handlebars
Hello, {{#if first_name}}{{first_name}}{{else}}friend{{/if}}!
```

---

## Manage templates

### List all templates
```bash
curl https://api.mailplatform.example/v1/templates \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

### Get a template
```bash
curl https://api.mailplatform.example/v1/templates/tmpl_01ABCDEF \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

### Update a template
```bash
curl -X PATCH https://api.mailplatform.example/v1/templates/tmpl_01ABCDEF \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "subject": "Welcome, {{name}} — get started in 3 steps" }'
```

Only the fields you provide are updated. The template is changed immediately; all future sends using this `template_id` will use the updated version.

### Delete a template
```bash
curl -X DELETE https://api.mailplatform.example/v1/templates/tmpl_01ABCDEF \
  -H "Authorization: Bearer $MAILPLATFORM_API_KEY"
```

Deleting a template does not affect messages already sent. Sends that reference the deleted `template_id` after deletion will fail with `template_not_found`.

---

## Node.js SDK example

```ts
import { MailPlatformClient } from '@platform/sdk';

const mp = new MailPlatformClient({ apiKey: process.env.MAILPLATFORM_API_KEY! });

// Create
const template = await mp.templates.create({
  name: 'password-reset',
  subject: 'Reset your password',
  html_body: '<p>Click <a href="{{reset_url}}">here</a> to reset your password. This link expires in 1 hour.</p>',
  text_body: 'Reset your password: {{reset_url}}\n\nThis link expires in 1 hour.',
});

// Send
await mp.messages.send({
  from: 'security@mail.yourcompany.com',
  to: 'alice@example.com',
  template_id: template.id,
  variables: { reset_url: 'https://app.yourcompany.com/reset?token=abc123' },
});
```

---

## Template testing tips

- **Send a test first.** Use a test-mode API key (`mp_test_...`) to send a test copy to yourself. Test-mode sends run the full pipeline (template rendering, tracking, suppression) but never deliver to real recipients.
- **Validate required variables.** If a variable is missing in `variables`, the placeholder renders as empty. Check your email content carefully before going live.
- **Always provide both `html_body` and `text_body`.** Some recipients read in plain-text mode (accessibility readers, mobile mail apps, and some corporate email servers). A missing `text_body` degrades deliverability with those clients.
- **Keep templates concise.** Very large HTML templates are valid but increase storage and rendering overhead. Consider offloading static assets to a CDN and referencing them with `<img src="...">` rather than embedding Base64.
