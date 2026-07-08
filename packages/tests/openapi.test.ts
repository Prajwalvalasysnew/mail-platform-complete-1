import { describe, expect, it } from 'vitest';
import { openapiSpec } from '@platform/shared';

describe('OpenAPI spec', () => {
  it('declares the expected version', () => {
    expect(openapiSpec.openapi).toBe('3.1.0');
  });

  it('documents the send endpoint with the right error codes', () => {
    const post = (openapiSpec.paths as any)['/send'].post;
    expect(post.operationId).toBe('sendEmail');
    expect(post.responses['429']).toBeDefined();
    expect(post.responses['402']).toBeDefined();
    expect(post.responses['422']).toBeDefined();
  });

  it('requires bearer auth globally', () => {
    expect((openapiSpec as any).security).toEqual([{ bearerAuth: [] }]);
    expect((openapiSpec as any).components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });

  it('declares human session auth for customer support endpoints', () => {
    const schemes = (openapiSpec as any).components.securitySchemes;
    expect(schemes.userSessionAuth.scheme).toBe('bearer');
    expect(schemes.userSessionAuth.bearerFormat).toBe('mpu_…');
  });

  it('lists the deletion endpoint (GDPR compliance is documented, not hidden)', () => {
    expect((openapiSpec.paths as any)['/privacy/delete-recipient']).toBeDefined();
  });

  it('documents the searchable message activity feed', () => {
    const get = (openapiSpec.paths as any)['/messages/activity'].get;
    expect(get.operationId).toBe('listMessageActivity');
    expect(get.parameters.some((p: any) => p.name === 'event_type')).toBe(true);
    expect(get.parameters.some((p: any) => p.name === 'before')).toBe(true);
  });

  it('exposes Idempotency-Key as a header parameter on /send', () => {
    const params = (openapiSpec.paths as any)['/send'].post.parameters;
    expect(params.some((p: any) => p.name === 'Idempotency-Key')).toBe(true);
  });

  it('documents customer support ticket endpoints', () => {
    const paths = openapiSpec.paths as any;
    expect(paths['/support/tickets'].get.operationId).toBe('listSupportTickets');
    expect(paths['/support/tickets'].post.operationId).toBe('createSupportTicket');
    expect(paths['/support/tickets/unread-count'].get.operationId).toBe('getSupportTicketUnreadCount');
    expect(paths['/support/tickets/{id}'].get.operationId).toBe('getSupportTicket');
    expect(paths['/support/tickets/{id}/read'].post.operationId).toBe('markSupportTicketRead');
    expect(paths['/support/tickets/{id}/messages'].post.operationId).toBe('replyToSupportTicket');
  });

  it('uses session auth and support schemas for customer support endpoints', () => {
    const paths = openapiSpec.paths as any;
    expect(paths['/support/tickets'].post.security).toEqual([{ userSessionAuth: [] }]);
    expect(paths['/support/tickets'].post.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/SupportTicketCreateRequest'
    );
    expect(paths['/support/tickets/{id}/messages'].post.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/SupportTicketMessageRequest'
    );
    expect(paths['/support/tickets/unread-count'].get.responses['200'].content['application/json'].schema.$ref).toBe(
      '#/components/schemas/SupportTicketUnreadCount'
    );
  });

  it('documents self-service API key endpoints with session auth', () => {
    const paths = openapiSpec.paths as any;
    expect(paths['/account/api-keys'].get.operationId).toBe('listAccountApiKeys');
    expect(paths['/account/api-keys'].post.operationId).toBe('createAccountApiKey');
    expect(paths['/account/api-keys/{id}/rotate'].post.operationId).toBe('rotateAccountApiKey');
    expect(paths['/account/api-keys/{id}'].delete.operationId).toBe('revokeAccountApiKey');
    expect(paths['/account/api-keys'].get.security).toEqual([{ userSessionAuth: [] }]);
    expect(paths['/account/api-keys'].post.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/ApiKeyCreateRequest'
    );
  });

  it('documents active session management with session auth', () => {
    const paths = openapiSpec.paths as any;
    expect(paths['/auth/sessions'].get.operationId).toBe('listUserSessions');
    expect(paths['/auth/sessions/revoke-others'].post.operationId).toBe('revokeOtherUserSessions');
    expect(paths['/auth/sessions/{id}'].delete.operationId).toBe('revokeUserSession');
    expect(paths['/auth/sessions'].get.security).toEqual([{ userSessionAuth: [] }]);
  });

  it('documents dashboard webhook management with session auth', () => {
    const paths = openapiSpec.paths as any;
    expect(paths['/account/webhooks'].get.operationId).toBe('listAccountWebhooks');
    expect(paths['/account/webhooks'].post.operationId).toBe('createAccountWebhook');
    expect(paths['/account/webhooks/{id}'].patch.operationId).toBe('updateAccountWebhook');
    expect(paths['/account/webhooks/{id}'].delete.operationId).toBe('deleteAccountWebhook');
    expect(paths['/account/webhooks/{id}/rotate-secret'].post.operationId).toBe('rotateAccountWebhookSecret');
    expect(paths['/account/webhooks'].post.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/WebhookCreateRequest'
    );
  });

  it('documents provider-specific billing webhooks', () => {
    const paths = openapiSpec.paths as any;
    expect(paths['/billing/webhook'].post.operationId).toBe('receiveStripeBillingWebhook');
    expect(paths['/billing/webhook/{provider}'].post.operationId).toBe('receiveBillingWebhook');
    expect(paths['/billing/webhook/{provider}'].post.security).toEqual([]);
    expect(paths['/billing/webhook/{provider}'].post.parameters.some((p: any) => p.name === 'provider')).toBe(true);
    expect(paths['/billing/webhook/{provider}'].post.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/BillingWebhookEvent'
    );
  });

  it('documents dashboard domain management with session auth', () => {
    const paths = openapiSpec.paths as any;
    expect(paths['/account/domains'].get.operationId).toBe('listAccountDomains');
    expect(paths['/account/domains'].post.operationId).toBe('addAccountDomain');
    expect(paths['/account/domains/{id}'].get.operationId).toBe('getAccountDomain');
    expect(paths['/account/domains/{id}'].delete.operationId).toBe('deleteAccountDomain');
    expect(paths['/account/domains/{id}/verify'].post.operationId).toBe('verifyAccountDomain');
    expect(paths['/account/domains'].post.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/DomainAddRequest'
    );
  });

  it('documents the full public CRUD surface', () => {
    const paths = openapiSpec.paths as any;
    expect(paths['/domains/{id}'].delete.operationId).toBe('deleteDomain');
    expect(paths['/suppressions/{email}'].delete.operationId).toBe('removeSuppression');
    expect(paths['/templates/{id}'].get.operationId).toBe('getTemplate');
    expect(paths['/templates/{id}'].put.operationId).toBe('updateTemplate');
    expect(paths['/templates/{id}'].delete.operationId).toBe('deleteTemplate');
    expect(paths['/webhooks/{id}'].delete.operationId).toBe('deleteWebhook');
    expect(paths['/support/tickets/{id}/rate'].post.operationId).toBe('rateSupportTicket');
    expect(paths['/support/tickets/{id}/rate'].post.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/SupportTicketRateRequest'
    );
  });

  it('every operation declares an operationId (required for codegen)', () => {
    const methods = ['get', 'post', 'put', 'patch', 'delete'];
    for (const [p, ops] of Object.entries(openapiSpec.paths as Record<string, any>)) {
      for (const m of methods) {
        if (ops[m]) expect(ops[m].operationId, `${m.toUpperCase()} ${p} missing operationId`).toBeTruthy();
      }
    }
  });
});
