// OpenAPI 3.1 specification for the public API, generated from a single source
// of truth here. Published at GET /openapi.json so typed SDKs and contract
// tests can be generated from it. Kept hand-maintained-but-centralized rather
// than reflected from Zod to avoid a heavy codegen dependency in the skeleton;
// the shapes mirror the Zod schemas in the routes.

export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Mail Platform API',
    version: '1.0.0',
    description: 'Transactional email API. Authenticate with a Bearer API key (mp_live_… or mp_test_…).',
  },
  servers: [{ url: '/v1' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'mp_live_…' },
      userSessionAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'mpu_…' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Stable machine-readable code' },
          message: { type: 'string' },
          request_id: { type: 'string' },
          details: {},
        },
        required: ['error'],
      },
      SendRequest: {
        type: 'object',
        properties: {
          from: { type: 'string', format: 'email' },
          from_name: { type: 'string' },
          to: { oneOf: [{ type: 'string', format: 'email' }, { type: 'array', items: { type: 'string', format: 'email' } }] },
          reply_to: { type: 'string', format: 'email' },
          subject: { type: 'string' },
          html: { type: 'string' },
          text: { type: 'string' },
          template_id: { type: 'string', format: 'uuid' },
          variables: { type: 'object' },
          tags: { type: 'array', items: { type: 'string' } },
          send_at: { type: 'string', format: 'date-time', description: 'Schedule delivery for a future time' },
          tracking: { type: 'object', properties: { opens: { type: 'boolean' }, clicks: { type: 'boolean' } } },
        },
        required: ['from', 'to'],
      },
      SendResponse: {
        type: 'object',
        properties: {
          accepted: { type: 'integer' },
          rejected: { type: 'integer' },
          message_ids: { type: 'array', items: { type: 'string' } },
          suppressed: { type: 'array', items: { type: 'string' } },
        },
      },
      SupportTicketCreateRequest: {
        type: 'object',
        properties: {
          subject: { type: 'string', minLength: 1, maxLength: 300 },
          body: { type: 'string', minLength: 1, maxLength: 10000 },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          category: { type: 'string', enum: ['general', 'billing', 'deliverability', 'technical', 'abuse', 'account'] },
        },
        required: ['subject', 'body'],
      },
      SupportTicketMessageRequest: {
        type: 'object',
        properties: {
          body: { type: 'string', minLength: 1, maxLength: 10000 },
        },
        required: ['body'],
      },
      SupportTicketRateRequest: {
        type: 'object',
        properties: {
          rating: { type: 'integer', minimum: 1, maximum: 5 },
          comment: { type: 'string', maxLength: 2000 },
        },
        required: ['rating'],
      },
      BillingCheckoutRequest: {
        type: 'object',
        properties: {
          price_id: { type: 'string' },
          success_url: { type: 'string', format: 'uri' },
          cancel_url: { type: 'string', format: 'uri' },
        },
        required: ['price_id', 'success_url', 'cancel_url'],
      },
      BillingPortalRequest: {
        type: 'object',
        properties: { return_url: { type: 'string', format: 'uri' } },
        required: ['return_url'],
      },
      BillingWebhookEvent: {
        type: 'object',
        description: 'Provider webhook event payload. Shape is provider-specific and verified from the raw request body.',
        additionalProperties: true,
      },
      BillingWebhookResponse: {
        type: 'object',
        properties: {
          received: { type: 'boolean' },
          applied: { type: 'boolean', description: 'Present for subscription lifecycle events.' },
        },
        required: ['received'],
      },
      SupportTicketUnreadCount: {
        type: 'object',
        properties: {
          unread: { type: 'integer', minimum: 0 },
        },
        required: ['unread'],
      },
      SupportTicketReadResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          last_read_at: { type: 'string', format: 'date-time' },
        },
        required: ['ok', 'last_read_at'],
      },
      ApiKeyCreateRequest: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          key_type: { type: 'string', enum: ['secret', 'publishable', 'test'] },
          scopes: { type: 'array', items: { type: 'string', enum: ['send', 'domains', 'suppressions', 'messages', 'webhooks', 'templates'] }, minItems: 1 },
          expires_in_days: { type: 'integer', minimum: 1, maximum: 3650 },
        },
        required: ['name'],
      },
      WebhookCreateRequest: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri' },
          events: { type: 'array', items: { type: 'string', enum: ['delivered', 'soft_bounce', 'hard_bounce', 'complaint', 'opened', 'clicked', 'unsubscribed', 'failed'] }, minItems: 1 },
        },
        required: ['url', 'events'],
      },
      WebhookUpdateRequest: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri' },
          events: { type: 'array', items: { type: 'string', enum: ['delivered', 'soft_bounce', 'hard_bounce', 'complaint', 'opened', 'clicked', 'unsubscribed', 'failed'] }, minItems: 1 },
          enabled: { type: 'boolean' },
        },
      },
      DomainAddRequest: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'FQDN, e.g. mail.example.com' },
          dkim_selector: { type: 'string', default: 'default' },
        },
        required: ['domain'],
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/send/batch': {
      post: {
        summary: 'Send a batch of emails (up to 100)',
        operationId: 'sendBatch',
        description: 'Accepts an array of messages. Each is validated and enqueued independently; the response reports per-message accepted/rejected status. Partial success is normal — a rejected message (suppressed recipient, missing template variable when require_all_variables is set, etc.) does not fail the whole batch.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['messages'],
                properties: {
                  messages: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 100,
                    items: { $ref: '#/components/schemas/SendRequest' },
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Batch processed (see per-message results)',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    results: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          index: { type: 'integer' },
                          accepted: { type: 'boolean' },
                          message_id: { type: 'string' },
                          error: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '429': { description: 'Quota or pool capacity exceeded', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '503': { description: 'Send queue saturated (backpressure); retry after a short delay', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/send': {
      post: {
        summary: 'Send an email',
        operationId: 'sendEmail',
        parameters: [
          { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' }, description: 'Safe-retry key; replays the first response.' },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SendRequest' } } } },
        responses: {
          '202': { description: 'Accepted', content: { 'application/json': { schema: { $ref: '#/components/schemas/SendResponse' } } } },
          '402': { description: 'Billing inactive', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '422': { description: 'Content rejected / idempotency conflict', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '429': { description: 'Quota or pool capacity exceeded', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/domains': {
      get: { summary: 'List sending domains', operationId: 'listDomains', responses: { '200': { description: 'OK' } } },
      post: { summary: 'Register a sending domain', operationId: 'addDomain', responses: { '201': { description: 'Created with DNS records' } } },
    },
    '/domains/{id}/verify': {
      post: { summary: 'Verify domain DNS', operationId: 'verifyDomain', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Verification result' } } },
    },
    '/domains/{id}': {
      delete: { summary: 'Delete a sending domain', operationId: 'deleteDomain', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } },
    },
    '/messages': { get: { summary: 'List messages', operationId: 'listMessages', responses: { '200': { description: 'OK' } } } },
    '/messages/activity': {
      get: {
        summary: 'Search message delivery activity',
        operationId: 'listMessageActivity',
        parameters: [
          { name: 'event_type', in: 'query', schema: { type: 'string', enum: ['queued', 'sent', 'delivered', 'soft_bounce', 'hard_bounce', 'complaint', 'opened', 'clicked', 'unsubscribed', 'failed'] } },
          { name: 'message_id', in: 'query', schema: { type: 'string' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'email' } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'email' } },
          { name: 'tag', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          { name: 'before', in: 'query', schema: { type: 'integer' }, description: 'Cursor returned as next_cursor from the previous page.' },
        ],
        responses: { '200': { description: 'Newest-first event activity feed' } },
      },
    },
    '/messages/{messageId}': { get: { summary: 'Get a message with event timeline', operationId: 'getMessage', parameters: [{ name: 'messageId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } } },
    '/suppressions': {
      get: { summary: 'List suppressions', operationId: 'listSuppressions', responses: { '200': { description: 'OK' } } },
      post: { summary: 'Add a suppression', operationId: 'addSuppression', responses: { '201': { description: 'Created' } } },
    },
    '/suppressions/import': { post: { summary: 'Import a suppression list (quality-scored)', operationId: 'importSuppressions', responses: { '200': { description: 'Import result' } } } },
    '/suppressions/{email}': {
      delete: { summary: 'Remove a suppression', operationId: 'removeSuppression', parameters: [{ name: 'email', in: 'path', required: true, schema: { type: 'string', format: 'email' } }], responses: { '200': { description: 'Removed' }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } },
    },
    '/suppressions/{email}/consent-history': {
      get: {
        summary: 'Consent event history for a recipient (append-only audit trail)',
        operationId: 'getConsentHistory',
        description: 'Returns every suppress/unsuppress event recorded for the recipient — action, reason, source (api / one_click_unsubscribe / bounce_escalation / complaint / bulk_import / gdpr_erasure), optional note and triggering message id — newest first. Used for GDPR/CAN-SPAM proof of when and how consent changed.',
        parameters: [
          { name: 'email', in: 'path', required: true, schema: { type: 'string', format: 'email' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } },
        ],
        responses: { '200': { description: 'Consent history (newest first)' } },
      },
    },
    '/templates': {
      get: { summary: 'List templates', operationId: 'listTemplates', responses: { '200': { description: 'OK' } } },
      post: { summary: 'Create a template', operationId: 'createTemplate', responses: { '201': { description: 'Created' } } },
    },
    '/templates/{id}': {
      get: { summary: 'Get a template', operationId: 'getTemplate', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } },
      put: { summary: 'Update a template', operationId: 'updateTemplate', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated' }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } },
      delete: { summary: 'Delete a template', operationId: 'deleteTemplate', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } },
    },
    '/usage': { get: { summary: 'Usage + deliverability rates', operationId: 'getUsage', responses: { '200': { description: 'OK' } } } },
    '/usage/quota': { get: { summary: 'Current quota usage and remaining, with threshold alerts', operationId: 'getQuotaUsage', responses: { '200': { description: 'Daily/monthly used, limit, remaining, pct, and 80%/100% alert flags' } } } },
    '/stats': {
      get: {
        summary: 'Aggregate event counts by type over a window',
        operationId: 'getStats',
        parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365, default: 7 } }],
        responses: { '200': { description: 'Array of { event_type, count }' } },
      },
    },
    '/analytics/summary': {
      get: {
        summary: 'Summary counts and rates over a period',
        operationId: 'analyticsSummary',
        parameters: [{ name: 'period', in: 'query', schema: { type: 'string', enum: ['24h', '7d', '30d'], default: '7d' } }],
        responses: { '200': { description: 'sent/delivered/bounced/complained/opened/clicked/unsubscribed plus delivery/open/click rates' } },
      },
    },
    '/analytics/timeseries': {
      get: {
        summary: 'Time-bucketed event counts for charting',
        operationId: 'analyticsTimeseries',
        parameters: [
          { name: 'period', in: 'query', schema: { type: 'string', enum: ['7d', '30d'], default: '7d' } },
          { name: 'granularity', in: 'query', schema: { type: 'string', enum: ['hour', 'day'], default: 'day' } },
        ],
        responses: { '200': { description: 'Per-bucket { date, sent, delivered, bounced, opened, clicked }' } },
      },
    },
    '/analytics/breakdown': {
      get: {
        summary: 'Event breakdown by tag, sending domain, or template',
        operationId: 'analyticsBreakdown',
        parameters: [
          { name: 'by', in: 'query', required: true, schema: { type: 'string', enum: ['tag', 'domain', 'template'] } },
          { name: 'period', in: 'query', schema: { type: 'string', enum: ['24h', '7d', '30d'], default: '7d' } },
        ],
        responses: { '200': { description: 'Top 100 keys with per-key { sent, delivered, bounced, opened, clicked }' } },
      },
    },
    '/workflows': {
      get: { summary: 'List workflows with run counts', operationId: 'listWorkflows', parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['draft', 'active', 'paused', 'archived'] } }], responses: { '200': { description: 'OK' } } },
      post: { summary: 'Create a workflow (draft)', operationId: 'createWorkflow', responses: { '201': { description: 'Created' }, '409': { description: 'Name exists' } } },
    },
    '/workflows/validate': {
      post: { summary: 'Validate a workflow definition without saving', operationId: 'validateWorkflow', responses: { '200': { description: '{ valid, errors, warnings }' } } },
    },
    '/workflows/signing-secret': {
      get: { summary: 'Per-org HMAC secret for verifying workflow webhook-step deliveries', operationId: 'getWorkflowSigningSecret', responses: { '200': { description: 'secret + algorithm + header name' } } },
    },
    '/workflows/{id}': {
      get: { summary: 'Get a workflow (draft + published definitions)', operationId: 'getWorkflow', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
      put: { summary: 'Update the draft (name/description/definition)', operationId: 'updateWorkflow', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated' }, '404': { description: 'Not found' } } },
      delete: { summary: 'Archive a workflow (stops new entries, cancels in-flight runs)', operationId: 'archiveWorkflow', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Archived' }, '404': { description: 'Not found' } } },
    },
    '/workflows/{id}/publish': {
      post: { summary: 'Strict-validate the draft, snapshot an immutable version, activate', operationId: 'publishWorkflow', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: '{ published, version, warnings }' }, '400': { description: 'Definition failed strict validation' } } },
    },
    '/workflows/{id}/pause': {
      post: { summary: 'Pause an active workflow (stops new entries; in-flight runs continue)', operationId: 'pauseWorkflow', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Paused' }, '409': { description: 'Invalid state' } } },
    },
    '/workflows/{id}/resume': {
      post: { summary: 'Resume a paused workflow', operationId: 'resumeWorkflow', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Resumed' }, '409': { description: 'Invalid state' } } },
    },
    '/workflows/{id}/versions': {
      get: { summary: 'Version history (append-only)', operationId: 'listWorkflowVersions', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/workflows/{id}/versions/{version}': {
      get: { summary: 'Get a specific version snapshot', operationId: 'getWorkflowVersion', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'version', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
    },
    '/workflows/{id}/versions/{version}/restore': {
      post: { summary: 'Copy a historical version back into the draft', operationId: 'restoreWorkflowVersion', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'version', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'Restored' }, '404': { description: 'Not found' } } },
    },
    '/workflows/{id}/trigger': {
      post: { summary: 'Start a run for a subject (external/API trigger; supports Idempotency-Key)', operationId: 'triggerWorkflow', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '202': { description: '{ started, run_id }' }, '409': { description: 'Not started (re-entry policy / already active / capacity)' } } },
    },
    '/workflows/{id}/trigger/bulk': {
      post: { summary: 'Enroll up to 1000 subjects in one call, with per-subject results', operationId: 'triggerWorkflowBulk', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '202': { description: '{ started, total, results: [{ email, started, run_id | skipped_reason }] }' } } },
    },
    '/workflows/{id}/simulate': {
      post: { summary: 'Dry-run the definition for a hypothetical subject (no side effects)', operationId: 'simulateWorkflow', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Step-by-step path with virtual timing' } } },
    },
    '/workflows/{id}/runs': {
      get: { summary: 'List runs for a workflow', operationId: 'listWorkflowRuns', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'status', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/workflows/{id}/stats': {
      get: { summary: 'Run counts, goal attainment, and per-step counters', operationId: 'getWorkflowStats', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/workflows/runs/{runId}': {
      get: { summary: 'Get a run with its step execution history', operationId: 'getWorkflowRun', parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
    },
    '/subaccounts': {
      get: { summary: 'List sub-accounts', operationId: 'listSubaccounts', responses: { '200': { description: 'OK' } } },
      post: { summary: 'Create a sub-account (isolated child tenant under this org)', operationId: 'createSubaccount', responses: { '201': { description: 'Created' }, '409': { description: 'Limit reached / nesting refused' } } },
    },
    '/subaccounts/usage': {
      get: { summary: 'Per-child usage roll-up + family totals', operationId: 'subaccountUsage', parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 90, default: 30 } }], responses: { '200': { description: 'OK' } } },
    },
    '/subaccounts/{id}': {
      get: { summary: 'Get a sub-account', operationId: 'getSubaccount', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
      patch: { summary: 'Update a sub-account (name, suspend/activate, quota spend caps)', operationId: 'updateSubaccount', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Updated' }, '404': { description: 'Not found' } } },
    },
    '/subaccounts/{id}/keys': {
      get: { summary: "List a sub-account's API keys", operationId: 'listSubaccountKeys', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      post: { summary: 'Mint a credential for a sub-account (defaults to send+smtp scopes)', operationId: 'createSubaccountKey', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '201': { description: 'Created (plaintext shown once)' } } },
    },
    '/subaccounts/{id}/keys/{keyId}': {
      delete: { summary: 'Revoke a sub-account credential', operationId: 'revokeSubaccountKey', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'keyId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '204': { description: 'Revoked' }, '404': { description: 'Not found' } } },
    },
    '/subaccounts/templates/push': {
      post: { summary: 'Copy a parent template to sub-accounts (franchise model)', operationId: 'pushTemplateToSubaccounts', responses: { '200': { description: '{ pushed: [ids] }' } } },
    },
    '/dmarc/reporting-address': {
      get: { summary: 'Get the rua= address to publish for DMARC aggregate reporting', operationId: 'dmarcReportingAddress', responses: { '200': { description: 'rua_address + DNS hint' } } },
    },
    '/dmarc/reports': {
      post: { summary: 'Ingest a DMARC aggregate report (raw XML, .xml.gz, or .zip body)', operationId: 'ingestDmarcReport', responses: { '201': { description: 'Ingested' }, '200': { description: 'Duplicate (no-op)' }, '422': { description: 'Unparseable/unsafe report' } } },
    },
    '/dmarc/summary': {
      get: { summary: 'DMARC pass-rate + disposition summary over a window', operationId: 'dmarcSummary', parameters: [{ name: 'domain', in: 'query', schema: { type: 'string' } }, { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } }], responses: { '200': { description: 'OK' } } },
    },
    '/dmarc/sources': {
      get: { summary: 'Who is sending as your domain — per-source-IP alignment, spoofers first', operationId: 'dmarcSources', parameters: [{ name: 'domain', in: 'query', schema: { type: 'string' } }, { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } }], responses: { '200': { description: 'OK' } } },
    },
    '/tools/domain-scan': {
      post: {
        summary: 'Deliverability scan of any domain: SPF (lookup limit, includes, detected ESPs), DMARC grade, MX provider, DKIM selector probe, DNSBL listings, and copy-paste DNS fixes',
        operationId: 'scanDomain',
        responses: { '200': { description: 'Graded DomainScanReport with issues[] and fixes[]' }, '400': { description: 'Invalid domain' } },
      },
    },
    '/workflows/runs/{runId}/cancel': {
      post: { summary: 'Cancel an in-flight run', operationId: 'cancelWorkflowRun', parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Canceled' }, '409': { description: 'Not cancelable' } } },
    },
    '/webhooks': {
      get: { summary: 'List webhooks', operationId: 'listWebhooks', responses: { '200': { description: 'OK' } } },
      post: { summary: 'Create a webhook', operationId: 'createWebhook', responses: { '201': { description: 'Created' } } },
    },
    '/webhooks/{id}': {
      delete: { summary: 'Delete a webhook', operationId: 'deleteWebhook', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Deleted' }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } },
    },
    '/webhooks/{id}/rotate-secret': {
      post: { summary: 'Rotate the webhook signing secret (with previous-secret grace window)', operationId: 'rotateWebhookSecret', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '201': { description: 'New secret; verify against secret OR previous_secret until previous_secret_expires_at' }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } },
    },
    '/webhooks/{id}/test': {
      post: { summary: 'Send a synthetic test_ping event to the endpoint', operationId: 'testWebhook', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '202': { description: 'Test ping queued' }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }, '422': { description: 'Webhook disabled', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } },
    },
    '/webhooks/{id}/deliveries': {
      get: {
        summary: 'List delivery attempts for a webhook (paginated)',
        operationId: 'listWebhookDeliveries',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          { name: 'before', in: 'query', schema: { type: 'integer' }, description: 'Cursor: delivery log id to page before.' },
        ],
        responses: { '200': { description: 'Delivery log rows with status_code, outcome, duration, error' }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
      },
    },
    '/webhooks/{id}/retry-failures': {
      post: {
        summary: 'Bulk re-queue non-success deliveries, reconstructing original payloads',
        operationId: 'retryWebhookFailures',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { since: { type: 'string', format: 'date-time' }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } } } },
        responses: { '200': { description: '{ retried, skipped_missing_event }' }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
      },
    },
    '/webhooks/{id}/deliveries/{deliveryId}/replay': {
      post: {
        summary: 'Replay one specific delivery by log id, regardless of original outcome',
        operationId: 'replayWebhookDelivery',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'deliveryId', in: 'path', required: true, schema: { type: 'integer' } },
        ],
        responses: {
          '202': { description: '{ replayed, event_id }' },
          '404': { description: 'Webhook or delivery not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '422': { description: 'Delivery has no linked source event, or the event was purged', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/support/tickets': {
      get: {
        summary: 'List support tickets for the active organization',
        operationId: 'listSupportTickets',
        security: [{ userSessionAuth: [] }],
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'pending', 'resolved', 'closed'] } },
          { name: 'priority', in: 'query', schema: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] } },
          { name: 'category', in: 'query', schema: { type: 'string', enum: ['general', 'billing', 'deliverability', 'technical', 'abuse', 'account'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          { name: 'before', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Ticket list for the active organization' },
          '401': { description: 'Session required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '403': { description: 'Active org or role missing', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        summary: 'Open a customer support ticket',
        operationId: 'createSupportTicket',
        security: [{ userSessionAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SupportTicketCreateRequest' } } } },
        responses: {
          '201': { description: 'Ticket created' },
          '400': { description: 'Validation failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '401': { description: 'Session required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/support/tickets/unread-count': {
      get: {
        summary: 'Count unread support tickets for the current user',
        operationId: 'getSupportTicketUnreadCount',
        security: [{ userSessionAuth: [] }],
        responses: {
          '200': { description: 'Unread count', content: { 'application/json': { schema: { $ref: '#/components/schemas/SupportTicketUnreadCount' } } } },
        },
      },
    },
    '/support/tickets/{id}': {
      get: {
        summary: 'Get a support ticket and customer-visible messages',
        operationId: 'getSupportTicket',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Ticket detail' },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/support/tickets/{id}/read': {
      post: {
        summary: 'Mark a support ticket as read for the current user',
        operationId: 'markSupportTicketRead',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Read marker updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/SupportTicketReadResponse' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/support/tickets/{id}/messages': {
      post: {
        summary: 'Reply to a support ticket as the current user',
        operationId: 'replyToSupportTicket',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SupportTicketMessageRequest' } } } },
        responses: {
          '201': { description: 'Message created' },
          '400': { description: 'Validation failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/support/tickets/{id}/rate': {
      post: {
        summary: 'Rate a resolved support ticket (CSAT)',
        operationId: 'rateSupportTicket',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SupportTicketRateRequest' } } } },
        responses: {
          '200': { description: 'Rating recorded' },
          '409': { description: 'Ticket not resolved/closed yet', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/account/billing': {
      get: {
        summary: 'Get the current plan, quota, and billing status',
        operationId: 'getAccountBilling',
        security: [{ userSessionAuth: [] }],
        responses: {
          '200': { description: 'Billing overview' },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/account/billing/checkout': {
      post: {
        summary: 'Start a checkout session to subscribe to a plan',
        operationId: 'startBillingCheckout',
        security: [{ userSessionAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingCheckoutRequest' } } } },
        responses: {
          '201': { description: 'Checkout session created (returns a redirect url)' },
          '400': { description: 'Validation failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/account/billing/portal': {
      post: {
        summary: 'Open a billing portal session to manage the subscription',
        operationId: 'startBillingPortal',
        security: [{ userSessionAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingPortalRequest' } } } },
        responses: {
          '200': { description: 'Portal session url' },
          '400': { description: 'Validation failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/account/billing/invoices': {
      get: {
        summary: 'List invoices for the active organization',
        operationId: 'listAccountInvoices',
        security: [{ userSessionAuth: [] }],
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'before', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { '200': { description: 'Invoice summaries and next cursor' } },
      },
    },
    '/account/billing/credit-notes': {
      get: {
        summary: 'List provider-issued credit notes / refunds for the active organization',
        operationId: 'listAccountCreditNotes',
        security: [{ userSessionAuth: [] }],
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'before', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { '200': { description: 'Credit note summaries and next cursor' } },
      },
    },
    '/account/billing/invoices/{id}': {
      get: {
        summary: 'Get an invoice and normalized line items',
        operationId: 'getAccountInvoice',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Invoice detail' },
          '404': { description: 'Invoice not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/account/billing/plan-change/preview': {
      post: {
        summary: 'Preview a governed plan change and entitlement differences',
        operationId: 'previewAccountPlanChange',
        security: [{ userSessionAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['price_id'], properties: { price_id: { type: 'string' } } } } } },
        responses: {
          '200': { description: 'Plan, quota, feature, risk, and proration preview' },
          '422': { description: 'Unknown or inactive provider price', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/account/billing/plan-change/{id}/confirm': {
      post: {
        summary: 'Submit a previously previewed plan change to the billing provider',
        operationId: 'confirmAccountPlanChange',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '202': { description: 'Upgrades are submitted immediately (status "pending_provider_confirmation") with entitlements unchanged pending a verified provider webhook; downgrades are scheduled at period end (status "scheduled" with an "effective_at" date) and the customer keeps current capacity until then' },
          '409': { description: 'Preview expired, unsupported, or subscription not ready', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/account/billing/plan-change/{id}': {
      delete: {
        summary: 'Cancel an unsubmitted preview or roll back a scheduled downgrade',
        operationId: 'cancelAccountPlanChange',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '204': { description: 'Preview canceled, or a scheduled downgrade rolled back before its effective date' },
          '409': { description: 'Request already submitted, applied, expired, or canceled' },
        },
      },
    },
    '/billing/webhook': {
      post: {
        summary: 'Receive a Stripe billing webhook (legacy path)',
        operationId: 'receiveStripeBillingWebhook',
        security: [],
        parameters: [{ name: 'Stripe-Signature', in: 'header', schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingWebhookEvent' } } } },
        responses: {
          '200': { description: 'Webhook received', content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingWebhookResponse' } } } },
          '400': { description: 'Invalid JSON or signature', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/billing/webhook/{provider}': {
      post: {
        summary: 'Receive a provider-specific billing webhook',
        operationId: 'receiveBillingWebhook',
        security: [],
        parameters: [
          { name: 'provider', in: 'path', required: true, schema: { type: 'string', enum: ['stripe', 'paypal'] } },
          { name: 'Stripe-Signature', in: 'header', schema: { type: 'string' } },
          { name: 'PayPal-Transmission-Id', in: 'header', schema: { type: 'string' } },
          { name: 'PayPal-Transmission-Time', in: 'header', schema: { type: 'string' } },
          { name: 'PayPal-Transmission-Sig', in: 'header', schema: { type: 'string' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingWebhookEvent' } } } },
        responses: {
          '200': { description: 'Webhook received', content: { 'application/json': { schema: { $ref: '#/components/schemas/BillingWebhookResponse' } } } },
          '400': { description: 'Unsupported provider, invalid JSON, or invalid signature', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/account/domains': {
      get: {
        summary: 'List the active organization\'s sending domains',
        operationId: 'listAccountDomains',
        security: [{ userSessionAuth: [] }],
        responses: {
          '200': { description: 'Domain list' },
          '401': { description: 'Session required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '403': { description: 'Requires the domains:manage capability', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        summary: 'Add a sending domain (returns DNS records to publish)',
        operationId: 'addAccountDomain',
        security: [{ userSessionAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/DomainAddRequest' } } } },
        responses: {
          '201': { description: 'Domain added with DKIM keypair and DNS records' },
          '409': { description: 'Domain already added', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/account/domains/{id}': {
      get: {
        summary: 'Get a domain with the DNS records to publish',
        operationId: 'getAccountDomain',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Domain detail with DNS records' }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
      },
      delete: {
        summary: 'Delete a sending domain',
        operationId: 'deleteAccountDomain',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Domain deleted' }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
      },
    },
    '/account/domains/{id}/verify': {
      post: {
        summary: 'Verify a domain by checking its published DNS records',
        operationId: 'verifyAccountDomain',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Per-record verification results and overall status' }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
      },
    },
    '/account/webhooks': {
      get: {
        summary: 'List the active organization\'s webhooks',
        operationId: 'listAccountWebhooks',
        security: [{ userSessionAuth: [] }],
        responses: {
          '200': { description: 'Webhook list' },
          '401': { description: 'Session required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '403': { description: 'Requires the settings:manage capability', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        summary: 'Create a webhook endpoint',
        operationId: 'createAccountWebhook',
        security: [{ userSessionAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookCreateRequest' } } } },
        responses: {
          '201': { description: 'Webhook created (includes signing secret)' },
          '400': { description: 'Validation failed or unsafe URL', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/account/webhooks/{id}': {
      patch: {
        summary: 'Update a webhook (url / events / enabled)',
        operationId: 'updateAccountWebhook',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookUpdateRequest' } } } },
        responses: {
          '200': { description: 'Updated webhook' },
          '404': { description: 'Not found in the active org', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        summary: 'Delete a webhook',
        operationId: 'deleteAccountWebhook',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Webhook deleted' },
          '404': { description: 'Not found in the active org', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/account/webhooks/{id}/rotate-secret': {
      post: {
        summary: 'Rotate a webhook\'s signing secret',
        operationId: 'rotateAccountWebhookSecret',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '201': { description: 'New signing secret returned' },
          '404': { description: 'Not found in the active org', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/auth/me/export': {
      get: {
        summary: 'Export the authenticated user\'s own account data (GDPR/CCPA access)',
        operationId: 'exportOwnAccountData',
        security: [{ userSessionAuth: [] }],
        responses: {
          '200': { description: 'Account data export: user record, memberships, sessions, MFA/passkey metadata, and documented exclusions. Never includes credential secrets.' },
          '401': { description: 'Session required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/auth/me': {
      delete: {
        summary: 'Delete the authenticated user\'s own account (self-service erasure)',
        operationId: 'deleteOwnAccount',
        security: [{ userSessionAuth: [] }],
        responses: {
          '200': { description: 'Account anonymized; credentials, sessions, tokens, and memberships removed' },
          '400': { description: 'Missing confirmation phrase', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '409': { description: 'Caller is the sole owner of one or more organizations; transfer ownership first', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/auth/sessions': {
      get: {
        summary: 'List the current user\'s active sessions (devices)',
        operationId: 'listUserSessions',
        security: [{ userSessionAuth: [] }],
        responses: {
          '200': { description: 'Active sessions; the current request\'s session is flagged' },
          '401': { description: 'Session required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/auth/sessions/revoke-others': {
      post: {
        summary: 'Revoke all sessions except the current one ("log out everywhere else")',
        operationId: 'revokeOtherUserSessions',
        security: [{ userSessionAuth: [] }],
        responses: {
          '200': { description: 'Other sessions revoked; returns the count' },
          '401': { description: 'Session required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/auth/sessions/{id}': {
      delete: {
        summary: 'Revoke a specific session by id (must belong to the caller)',
        operationId: 'revokeUserSession',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Session revoked' },
          '404': { description: 'No such session for this user', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/account/api-keys': {
      get: {
        summary: 'List the active organization\'s API keys (metadata only)',
        operationId: 'listAccountApiKeys',
        security: [{ userSessionAuth: [] }],
        responses: {
          '200': { description: 'API key metadata list' },
          '401': { description: 'Session required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '403': { description: 'Requires the apikeys:manage capability', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        summary: 'Create an API key (plaintext shown once)',
        operationId: 'createAccountApiKey',
        security: [{ userSessionAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiKeyCreateRequest' } } } },
        responses: {
          '201': { description: 'Key created; api_key returned once' },
          '400': { description: 'Validation failed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '403': { description: 'Requires the apikeys:manage capability', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/account/api-keys/{id}/rotate': {
      post: {
        summary: 'Rotate an API key, expiring the old key after an overlap window',
        operationId: 'rotateAccountApiKey',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '201': { description: 'Replacement key created; api_key returned once' },
          '404': { description: 'Not found in the active org', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/account/api-keys/{id}': {
      delete: {
        summary: 'Revoke an API key',
        operationId: 'revokeAccountApiKey',
        security: [{ userSessionAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Key revoked' },
          '404': { description: 'Not found in the active org', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/privacy/delete-recipient': { post: { summary: 'GDPR: delete all data for a recipient', operationId: 'deleteRecipient', responses: { '200': { description: 'Deletion summary' } } } },
    '/compliance/workloads': {
      get: {
        summary: 'List the tenant regulated-workload activation posture',
        operationId: 'listRegulatedWorkloads',
        responses: { '200': { description: 'HIPAA, FERPA and SEC/FINRA modes with fail-closed activation status' } },
      },
    },
    '/compliance/workloads/{mode}/request': {
      post: {
        summary: 'Request administrative review for an Enterprise regulated-workload mode',
        operationId: 'requestRegulatedWorkload',
        parameters: [{ name: 'mode', in: 'path', required: true, schema: { type: 'string', enum: ['hipaa', 'ferpa', 'sec_finra'] } }],
        responses: {
          '202': { description: 'Request queued; the mode remains inactive until every prerequisite is approved' },
          '403': { description: 'Enterprise agreement required' },
          '409': { description: 'Mode already pending or active' },
        },
      },
    },
    '/compliance/workload-evidence': {
      get: {
        summary: 'List evidence-backed regulated-mode prerequisites',
        operationId: 'listRegulatedWorkloadEvidence',
        responses: { '200': { description: 'Prerequisite evidence' } },
      },
      post: {
        summary: 'Submit a checksum-addressed prerequisite artifact for independent review',
        operationId: 'submitRegulatedWorkloadEvidence',
        responses: { '201': { description: 'Evidence submitted' }, '403': { description: 'Enterprise required' } },
      },
    },
    '/secure-messages': {
      post: {
        summary: 'Create an encrypted HIPAA/FERPA secure-portal message under an active regulated mode',
        operationId: 'createSecureMessage',
        responses: {
          '201': { description: 'Encrypted message created; portal credentials are returned once' },
          '409': { description: 'The required regulated mode is not active' },
        },
      },
    },
    '/secure-messages/{id}/revoke': {
      post: {
        summary: 'Revoke access to a tenant-owned secure message',
        operationId: 'revokeSecureMessage',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Revoked' }, '404': { description: 'Not found' } },
      },
    },
    '/secure-portal/access': {
      post: {
        summary: 'Access a secure message with its separately delivered portal token and access code',
        operationId: 'accessSecureMessage',
        security: [],
        responses: {
          '200': { description: 'Decrypted message with no-store response headers' },
          '404': { description: 'Unknown, expired, revoked, or invalid credentials' },
        },
      },
    },
    '/compliance/rights-cases': {
      get: { summary: 'List HIPAA/FERPA rights cases', operationId: 'listRegulatedRightsCases', responses: { '200': { description: 'Cases' } } },
      post: { summary: 'Create a pseudonymized HIPAA/FERPA rights case', operationId: 'createRegulatedRightsCase', responses: { '201': { description: 'Case created' }, '409': { description: 'Mode inactive' } } },
    },
    '/compliance/rights-cases/{id}/transition': {
      post: {
        summary: 'Apply an auditable, validated rights-case transition',
        operationId: 'transitionRegulatedRightsCase',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Case transitioned' }, '409': { description: 'Invalid transition' } },
      },
    },
    '/compliance/rights-cases/{id}/hipaa-breach-assessment': {
      post: {
        summary: 'Record the four-factor HIPAA breach risk assessment with encrypted analysis',
        operationId: 'recordHipaaBreachAssessment',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '201': { description: 'Assessment recorded' }, '404': { description: 'Case not found' } },
      },
    },
    '/compliance/rights-cases/{id}/ferpa-amendment-outcome': {
      post: {
        summary: 'Record FERPA amendment/hearing outcome and encrypted disputed-record statement',
        operationId: 'recordFerpaAmendmentOutcome',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '201': { description: 'Outcome recorded' }, '409': { description: 'Required statement missing' } },
      },
    },
    '/compliance/disclosures': {
      post: {
        summary: 'Record a pseudonymized HIPAA/FERPA disclosure and its authority',
        operationId: 'recordRegulatedDisclosure',
        responses: { '201': { description: 'Disclosure recorded' }, '409': { description: 'Mode inactive' } },
      },
    },
    '/compliance/archive-records': {
      get: {
        summary: 'List SEC/FINRA specialist archive receipts and reconciliation status',
        operationId: 'listRegulatedArchiveRecords',
        responses: { '200': { description: 'Value-free archive receipts' } },
      },
    },
    '/privacy/restrict-recipient': {
      post: {
        summary: 'GDPR Art 18: restrict processing for a recipient (store but do not use). Distinct from suppression — lifted by a decision, not by resubscribing',
        operationId: 'restrictRecipientProcessing',
        responses: {
          '201': { description: 'Restriction created' },
          '200': { description: 'Already restricted; the original restriction is returned unchanged' },
        },
      },
    },
    '/privacy/release-restriction': {
      post: {
        summary: 'Lift an Article 18 processing restriction. A reason is required — Art 18(3) obliges informing the data subject before lifting',
        operationId: 'releaseProcessingRestriction',
        responses: {
          '200': { description: 'Restriction released' },
          '404': { description: 'No active restriction for that recipient', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/privacy/restrictions': {
      get: {
        summary: 'List processing restrictions (active by default)',
        operationId: 'listProcessingRestrictions',
        parameters: [
          { name: 'include_released', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'Restrictions, newest first' } },
      },
    },
    '/privacy/processing-record': {
      get: {
        summary: 'GDPR Art 30(2) record of processing carried out for this controller, with the Art 32 security-measures schedule resolved against this tenant\'s live configuration and the Art 28(3) assistance duties mapped to the endpoints that deliver them',
        description:
          'Each measure carries a state: "enforced" (true by construction in the platform), "configured" (currently on, can be switched off), '
          + '"not_enabled" (the platform supports it and it is off for this tenant), or "policy_only" (an organizational commitment with no technical enforcement). '
          + 'Measures that are off are returned with state "not_enabled" rather than omitted, and a configuration-derived measure never reports "enforced". '
          + 'Subprocessors are not named — that is a deployment fact, not a source-code fact.',
        operationId: 'getProcessingRecord',
        responses: { '200': { description: 'Processing record, measures schedule, assistance commitments and a gap summary' } },
      },
    },
    '/privacy/rectify-recipient': {
      post: {
        summary: 'GDPR Art 16 / CCPA right to correct: move suppression, consent, group and restriction state to a corrected address. Historical delivery records are preserved and reported',
        operationId: 'rectifyRecipient',
        responses: {
          '200': { description: 'Counts moved, plus historical records deliberately preserved' },
          '422': { description: 'The corrected address is identical to the current one', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/privacy/limit-sensitive-pi': {
      post: {
        summary: 'CCPA §1798.121: limit use of sensitive PI. Message content is SPI here by definition (§1798.140(ae)(1)(E)). Disables open and click tracking; delivery, abuse scanning and legal-obligation controls are unaffected',
        operationId: 'limitSensitivePiUse',
        responses: {
          '201': { description: 'Limit recorded' },
          '200': { description: 'Already limited' },
        },
      },
    },
    '/privacy/limit-sensitive-pi/release': {
      post: {
        summary: 'Lift a sensitive-PI limit, restoring the tenant\'s tracking preferences',
        operationId: 'releaseSensitivePiLimit',
        responses: {
          '200': { description: 'Limit released' },
          '404': { description: 'No active limit for that recipient', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/privacy/sensitive-pi-limits': {
      get: {
        summary: 'List sensitive-PI limits (active by default)',
        operationId: 'listSensitivePiLimits',
        parameters: [{ name: 'include_released', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }],
        responses: { '200': { description: 'Limits, newest first' } },
      },
    },
    '/privacy/cases/{id}/appeal': {
      post: {
        summary: 'CCPA-07: appeal a denied data-subject request. The appeal runs on its own statutory clock, and remains available after the case was closed',
        operationId: 'submitPrivacyCaseAppeal',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '201': { description: 'Appeal recorded with its own due date' },
          '409': { description: 'The case was never denied, so there is nothing to appeal', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '422': { description: 'An appeal on this case is already awaiting a decision', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/privacy/appeals/{id}/decide': {
      post: {
        summary: 'Decide an appeal. Upholding a denial requires an escalation notice recording how the consumer was told to complain to the regulator; overturning reopens the case',
        operationId: 'decidePrivacyCaseAppeal',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Appeal decided' },
          '409': { description: 'The appeal has already been decided', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '422': { description: 'Upholding without an escalation notice', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/privacy/appeals': {
      get: {
        summary: 'List appeals; filter to open or overdue for the response-timeliness metric',
        operationId: 'listPrivacyCaseAppeals',
        parameters: [
          { name: 'case_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'open', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'overdue', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
        ],
        responses: { '200': { description: 'Appeals, newest first' } },
      },
    },
    '/privacy/consent': {
      post: {
        summary: 'GDPR Art 7(1): record an affirmative consent grant with provenance, evidence wording and policy version. A double_opt_in grant is NOT valid consent until confirmed',
        operationId: 'recordConsentGrant',
        responses: {
          '201': { description: 'Consent recorded; a confirmation token is returned for double opt-in' },
          '422': { description: 'Evidence wording is missing or too short to demonstrate consent', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/privacy/consent/confirm': {
      post: {
        summary: 'Complete a double opt-in with the confirmation token. Single-use',
        operationId: 'confirmDoubleOptIn',
        responses: {
          '200': { description: 'Consent confirmed and now valid' },
          '404': { description: 'Unknown or already-used token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/privacy/consent/proof': {
      get: {
        summary: 'Art 7(1) proof of consent: the full grant chain including superseded and withdrawn records',
        operationId: 'getConsentProof',
        parameters: [{ name: 'recipient', in: 'query', required: true, schema: { type: 'string', format: 'email' } }],
        responses: { '200': { description: 'Consent history, newest first' } },
      },
    },
    '/privacy/consent/withdraw': {
      post: {
        summary: 'Art 7(3): withdraw consent. Marks the record rather than deleting it — mail sent while consent was valid must stay accountable',
        operationId: 'withdrawConsent',
        responses: {
          '200': { description: 'Consent withdrawn' },
          '404': { description: 'No active consent for that recipient and purpose', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/privacy/regulatory-locks': {
      post: {
        summary: 'SEC-04: place a time-bound regulatory retention obligation (SEC 17a-4 / FINRA 4511). Blocks both retention purge and data-subject erasure until it lapses',
        operationId: 'placeRegulatoryLock',
        responses: {
          '201': { description: 'Lock placed' },
          '422': { description: 'retain_until is not in the future', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      get: {
        summary: 'List regulatory retention locks (active by default)',
        operationId: 'listRegulatoryLocks',
        parameters: [{ name: 'include_released', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }],
        responses: { '200': { description: 'Locks, newest first' } },
      },
    },
    '/privacy/regulatory-locks/{id}/release': {
      post: {
        summary: 'Release a regulatory lock before its statutory expiry. Requires both a releaser and a documented reason',
        operationId: 'releaseRegulatoryLock',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': { description: 'Lock released' },
          '404': { description: 'No active lock with that id', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/privacy/opt-out-sale': {
      post: {
        summary: 'CCPA §1798.120: opt out of sale/sharing. Does NOT stop delivery — a consumer may keep receiving mail while refusing to be sold. Global Privacy Control is honoured automatically at the tracker surfaces',
        operationId: 'optOutOfSaleOrSharing',
        responses: {
          '201': { description: 'Opt-out recorded' },
          '200': { description: 'Already opted out' },
        },
      },
    },
    '/privacy/sale-share-optouts': {
      get: {
        summary: 'List active sale/share opt-outs, including those captured from Global Privacy Control',
        operationId: 'listSaleShareOptOuts',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: { '200': { description: 'Opt-outs, newest first' } },
      },
    },
    '/privacy/object': {
      post: {
        summary: 'GDPR Art 21: record an objection to direct marketing. Unconditional, so it takes effect immediately as an enforced suppression',
        operationId: 'recordMarketingObjection',
        responses: { '200': { description: 'Objection recorded and enforced' } },
      },
    },
    '/privacy/cases': {
      post: { summary: 'Open a data-subject request case (intake, jurisdiction deadline computed)', operationId: 'createPrivacyCase', responses: { '201': { description: 'Case created with statutory due date' } } },
      get: { summary: 'List privacy cases (filter by status or overdue)', operationId: 'listPrivacyCases', parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'overdue', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }], responses: { '200': { description: 'Cases, newest first' } } },
    },
    '/privacy/cases/{id}': {
      get: { summary: 'Get a privacy case with its append-only event history', operationId: 'getPrivacyCase', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Case with events' }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } },
    },
    '/privacy/cases/{id}/verify': {
      post: { summary: 'Record data-subject identity verification for a case', operationId: 'verifyPrivacyCase', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Verification recorded' }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } },
    },
    '/privacy/cases/{id}/transition': {
      post: { summary: 'Move a privacy case through its state machine (fulfill requires verification; deny requires a reason)', operationId: 'transitionPrivacyCase', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'New case state' }, '409': { description: 'Illegal transition', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }, '422': { description: 'Missing verification or denial reason', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } },
    },
    '/privacy/cases/{id}/extend': {
      post: { summary: 'Apply the single statutory deadline extension with a documented reason', operationId: 'extendPrivacyCase', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Extended due date' }, '422': { description: 'Already extended', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } },
    },
    '/privacy/cases/{id}/artifacts': {
      post: { summary: 'Attach a fulfillment artifact reference (deletion request id, export id, …)', operationId: 'attachPrivacyCaseArtifact', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Artifact reference recorded' } } },
    },
    '/privacy/cases/{id}/communications': {
      post: { summary: 'Record a case communication summary (channel and direction, never content)', operationId: 'recordPrivacyCaseCommunication', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Communication recorded in the case ledger' } } },
    },
  },
} as const;
