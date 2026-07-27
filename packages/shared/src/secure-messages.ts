import crypto from 'node:crypto';
import { db } from './db.js';
import { decryptSecret, encryptSecret } from './encryption.js';
import { regulatedModeIsActive, type RegulatedWorkloadMode } from './regulated-workloads.js';
import { classifyRegulatedContent } from './regulated-content.js';

export interface SecureMessagePayload {
  subject: string;
  html?: string;
  text?: string;
  attachments?: Array<{ filename: string; content_type: string; content_b64: string }>;
}

function credentialHash(kind: string, value: string): string {
  const pepper = process.env.SECURE_PORTAL_PEPPER ?? process.env.API_KEY_PEPPER ?? process.env.ENCRYPTION_KEY;
  if (!pepper) throw new Error('SECURE_PORTAL_PEPPER is required');
  return crypto.createHmac('sha256', pepper).update(`${kind}:${value}`).digest('base64url');
}

function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class SecureMessageError extends Error {
  constructor(public readonly code: 'mode_inactive' | 'mode_mismatch' | 'not_found' | 'expired' | 'revoked' | 'invalid_access', message: string) {
    super(message);
  }
}

export async function createSecureMessage(input: {
  customerId: string;
  apiKeyId: string;
  recipientEmail: string;
  mode: Extract<RegulatedWorkloadMode, 'hipaa' | 'ferpa'>;
  payload: SecureMessagePayload;
  expiresHours: number;
}) {
  if (!(await regulatedModeIsActive(input.customerId, input.mode))) {
    throw new SecureMessageError('mode_inactive', `${input.mode} mode is not active`);
  }
  const findings = classifyRegulatedContent({
    subject: input.payload.subject,
    html: input.payload.html,
    text: input.payload.text,
  });
  const wrongMode = findings.some((finding) =>
    (finding.category === 'phi' && input.mode !== 'hipaa') ||
    (finding.category === 'education_record' && input.mode !== 'ferpa') ||
    finding.category === 'broker_dealer_record');
  if (wrongMode) {
    throw new SecureMessageError('mode_mismatch', 'Content does not match the selected secure-message mode');
  }
  const portalToken = crypto.randomBytes(32).toString('base64url');
  // 128 bits, shown once and intended for a separate channel/password manager.
  const accessCode = crypto.randomBytes(16).toString('base64url');
  const row = await db.insertInto('secure_messages').values({
    customer_id: input.customerId,
    recipient_email: input.recipientEmail.toLowerCase(),
    encrypted_payload: encryptSecret(JSON.stringify(input.payload)),
    portal_token_hash: credentialHash('portal', portalToken),
    access_code_hash: credentialHash('access', accessCode),
    mode: input.mode,
    expires_at: new Date(Date.now() + input.expiresHours * 3600_000),
    created_by_api_key: input.apiKeyId,
  }).returning(['id', 'recipient_email', 'mode', 'expires_at', 'created_at']).executeTakeFirstOrThrow();
  return { row, portalToken, accessCode };
}

export async function accessSecureMessage(portalToken: string, accessCode: string) {
  const row = await db.selectFrom('secure_messages').selectAll()
    .where('portal_token_hash', '=', credentialHash('portal', portalToken)).executeTakeFirst();
  // Deliberately collapse unknown token and wrong code.
  if (!row || !equalHash(row.access_code_hash, credentialHash('access', accessCode))) {
    throw new SecureMessageError('invalid_access', 'Invalid secure-message credentials');
  }
  if (row.revoked_at) throw new SecureMessageError('revoked', 'Secure message has been revoked');
  if (new Date(row.expires_at) <= new Date()) throw new SecureMessageError('expired', 'Secure message has expired');
  const payload = JSON.parse(decryptSecret(row.encrypted_payload)) as SecureMessagePayload;
  await db.updateTable('secure_messages').set({ accessed_at: new Date() }).where('id', '=', row.id).execute();
  await db.insertInto('audit_log').values({
    customer_id: row.customer_id,
    api_key_id: null,
    action: 'secure_message_accessed',
    resource: 'secure_message',
    ip: null,
    metadata: { secure_message_id: row.id, mode: row.mode },
  }).execute();
  return {
    id: row.id, recipient_email: row.recipient_email, mode: row.mode,
    expires_at: row.expires_at, payload,
  };
}

export async function revokeSecureMessage(customerId: string, id: string) {
  const result = await db.updateTable('secure_messages').set({ revoked_at: new Date() })
    .where('id', '=', id).where('customer_id', '=', customerId).where('revoked_at', 'is', null)
    .returning('id').executeTakeFirst();
  if (!result) throw new SecureMessageError('not_found', 'Secure message not found');
  return result;
}
