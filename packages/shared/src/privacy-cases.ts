// BASE-05 (compliance implementation plan): privacy case management.
//
// State machine + deadline arithmetic for data-subject request cases. The
// case row tracks intake, verification, jurisdiction, deadline/extension,
// exception/denial, approval, fulfillment artifacts, and closure; the
// append-only privacy_case_events ledger is the closure evidence. Neither the
// event ledger nor anything this module logs carries the subject identifier —
// only case ids.
import type { DbExecutor } from './db.js';
import type {
  PrivacyCaseStatus,
  PrivacyCaseJurisdiction,
  PrivacyCaseIntakeSource,
  PrivacyCaseRequestType,
} from './schema.js';
import { erasedRecipientPseudonym } from './privacy-pseudonym.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Statutory response windows. GDPR Art. 12(3): one month, extendable by two
// further months. CCPA §1798.130(a)(2): 45 days, extendable by 45 more.
// 'other'/'unknown' get the stricter (GDPR) arithmetic by default.
const DEADLINES: Record<PrivacyCaseJurisdiction, { initialDays: number; extensionDays: number }> = {
  gdpr: { initialDays: 30, extensionDays: 60 },
  ccpa: { initialDays: 45, extensionDays: 45 },
  other: { initialDays: 30, extensionDays: 60 },
  unknown: { initialDays: 30, extensionDays: 60 },
};

// Legal transitions. Terminal work states (fulfilled/denied) still transition
// to 'closed' so closure evidence (communications, artifacts) can be attached
// after the decision.
const TRANSITIONS: Record<PrivacyCaseStatus, PrivacyCaseStatus[]> = {
  received: ['verifying', 'in_progress', 'denied'],
  verifying: ['in_progress', 'waiting_on_subject', 'denied'],
  in_progress: ['waiting_on_subject', 'fulfilled', 'denied'],
  waiting_on_subject: ['verifying', 'in_progress', 'denied', 'closed'],
  fulfilled: ['closed'],
  denied: ['closed'],
  closed: [],
};

export class PrivacyCaseError extends Error {
  constructor(public code: 'invalid_transition' | 'case_not_found' | 'verification_required' | 'already_extended' | 'denial_reason_required', message: string) {
    super(message);
    this.name = 'PrivacyCaseError';
  }
}

export function privacyCaseDueDate(jurisdiction: PrivacyCaseJurisdiction, receivedAt: Date): Date {
  return new Date(receivedAt.getTime() + DEADLINES[jurisdiction].initialDays * DAY_MS);
}

async function appendCaseEvent(
  trx: DbExecutor,
  row: { case_id: string; customer_id: string; event: 'created' | 'verified' | 'status_changed' | 'extended' | 'communication' | 'artifact_attached' | 'denied' | 'closed'; detail?: Record<string, unknown>; actor?: string | null }
): Promise<void> {
  await trx.insertInto('privacy_case_events').values({
    case_id: row.case_id,
    customer_id: row.customer_id,
    event: row.event,
    detail: row.detail ?? {},
    actor: row.actor ?? null,
  }).execute();
}

export async function createPrivacyCase(
  input: {
    customerId: string;
    subjectKind?: 'recipient' | 'account_user';
    subjectIdentifier: string;
    intakeSource: PrivacyCaseIntakeSource;
    requestTypes: PrivacyCaseRequestType[];
    jurisdiction?: PrivacyCaseJurisdiction;
    createdBy?: string | null;
  },
  trx: DbExecutor
) {
  const jurisdiction = input.jurisdiction ?? 'unknown';
  const receivedAt = new Date();
  const row = await trx.insertInto('privacy_cases').values({
    customer_id: input.customerId,
    subject_kind: input.subjectKind ?? 'recipient',
    subject_identifier: input.subjectIdentifier.toLowerCase(),
    intake_source: input.intakeSource,
    request_types: input.requestTypes,
    jurisdiction,
    received_at: receivedAt,
    due_at: privacyCaseDueDate(jurisdiction, receivedAt),
    created_by: input.createdBy ?? null,
  }).returningAll().executeTakeFirstOrThrow();
  await appendCaseEvent(trx, {
    case_id: row.id, customer_id: input.customerId, event: 'created',
    detail: { intake_source: input.intakeSource, request_types: input.requestTypes, jurisdiction },
    actor: input.createdBy,
  });
  return row;
}

async function getCaseForUpdate(trx: DbExecutor, customerId: string, caseId: string) {
  const row = await trx.selectFrom('privacy_cases').selectAll()
    .where('customer_id', '=', customerId).where('id', '=', caseId)
    .forUpdate().executeTakeFirst();
  if (!row) throw new PrivacyCaseError('case_not_found', 'No such privacy case for this tenant.');
  return row;
}

/** Record successful identity verification (a fulfillment prerequisite). */
export async function verifyPrivacyCaseIdentity(
  customerId: string, caseId: string, method: string, actor: string | null, trx: DbExecutor
) {
  const row = await getCaseForUpdate(trx, customerId, caseId);
  const updated = await trx.updateTable('privacy_cases').set({
    identity_verified_at: new Date(),
    verification_method: method,
    updated_at: new Date(),
  }).where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
  await appendCaseEvent(trx, { case_id: row.id, customer_id: customerId, event: 'verified', detail: { method }, actor });
  return updated;
}

/**
 * Move the case through the state machine. Fulfillment requires verified
 * identity; denial requires a reason (the documented exception path).
 */
export async function transitionPrivacyCase(
  customerId: string, caseId: string,
  to: PrivacyCaseStatus,
  options: { actor?: string | null; denialReason?: string; approvedBy?: string },
  trx: DbExecutor
) {
  const row = await getCaseForUpdate(trx, customerId, caseId);
  const from = row.status as PrivacyCaseStatus;
  if (!TRANSITIONS[from].includes(to)) {
    throw new PrivacyCaseError('invalid_transition', `Cannot move a privacy case from '${from}' to '${to}'.`);
  }
  if (to === 'fulfilled' && !row.identity_verified_at) {
    throw new PrivacyCaseError('verification_required', 'Identity must be verified before a case is fulfilled.');
  }
  if (to === 'denied' && !options.denialReason) {
    throw new PrivacyCaseError('denial_reason_required', 'Denying a privacy case requires a documented reason.');
  }

  const now = new Date();
  const set: Record<string, unknown> = { status: to, updated_at: now };
  if (to === 'denied') set.denial_reason = options.denialReason;
  if (options.approvedBy) set.approved_by = options.approvedBy;
  if (to === 'closed') {
    set.closed_at = now;
    // PI minimization at closure: if the case erased the subject, the case
    // record must not keep the plaintext identifier either. Same keyed
    // pseudonym as the erasure itself, so evidence stays linkable.
    if ((row.request_types as string[]).includes('erasure') && !row.subject_pseudonymized_at) {
      set.subject_identifier = erasedRecipientPseudonym(customerId, row.subject_identifier);
      set.subject_pseudonymized_at = now;
    }
  }
  const updated = await trx.updateTable('privacy_cases').set(set as never)
    .where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
  await appendCaseEvent(trx, {
    case_id: row.id, customer_id: customerId,
    event: to === 'closed' ? 'closed' : to === 'denied' ? 'denied' : 'status_changed',
    detail: { from, to, ...(options.denialReason ? { denial_reason: options.denialReason } : {}) },
    actor: options.actor,
  });
  return updated;
}

/** One statutory extension per case, with a documented reason. */
export async function extendPrivacyCase(
  customerId: string, caseId: string, reason: string, actor: string | null, trx: DbExecutor
) {
  const row = await getCaseForUpdate(trx, customerId, caseId);
  if (row.extended_until) throw new PrivacyCaseError('already_extended', 'This case has already used its statutory extension.');
  const extendedUntil = new Date(
    new Date(row.due_at as unknown as string).getTime() +
    DEADLINES[row.jurisdiction as PrivacyCaseJurisdiction].extensionDays * DAY_MS
  );
  const updated = await trx.updateTable('privacy_cases').set({
    extended_until: extendedUntil, extension_reason: reason, updated_at: new Date(),
  }).where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
  await appendCaseEvent(trx, {
    case_id: row.id, customer_id: customerId, event: 'extended',
    detail: { extended_until: extendedUntil.toISOString(), reason }, actor,
  });
  return updated;
}

/** Attach a fulfillment artifact reference (deletion request id, export id…). */
export async function attachPrivacyCaseArtifact(
  customerId: string, caseId: string,
  artifact: { kind: string; ref: string; note?: string },
  actor: string | null, trx: DbExecutor
) {
  const row = await getCaseForUpdate(trx, customerId, caseId);
  const artifacts = [...(row.artifacts as Array<Record<string, unknown>>), { ...artifact, attached_at: new Date().toISOString() }];
  const updated = await trx.updateTable('privacy_cases')
    .set({ artifacts: JSON.stringify(artifacts) as never, updated_at: new Date() })
    .where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
  await appendCaseEvent(trx, {
    case_id: row.id, customer_id: customerId, event: 'artifact_attached',
    detail: { kind: artifact.kind, ref: artifact.ref }, actor,
  });
  return updated;
}

/** Record an outbound/inbound communication summary (channel only, no content). */
export async function recordPrivacyCaseCommunication(
  customerId: string, caseId: string,
  detail: { direction: 'inbound' | 'outbound'; channel: string; summary?: string },
  actor: string | null, trx: DbExecutor
) {
  const row = await getCaseForUpdate(trx, customerId, caseId);
  await appendCaseEvent(trx, { case_id: row.id, customer_id: customerId, event: 'communication', detail, actor });
  return row;
}

export interface PrivacyCaseListFilter {
  status?: PrivacyCaseStatus;
  overdueOnly?: boolean;
  limit?: number;
  offset?: number;
}

export async function listPrivacyCases(customerId: string, filter: PrivacyCaseListFilter, trx: DbExecutor) {
  let q = trx.selectFrom('privacy_cases').selectAll().where('customer_id', '=', customerId);
  if (filter.status) q = q.where('status', '=', filter.status);
  if (filter.overdueOnly) {
    const now = new Date();
    q = q.where('status', 'not in', ['fulfilled', 'denied', 'closed'])
      .where((eb) => eb.or([
        eb.and([eb('extended_until', 'is', null), eb('due_at', '<', now)]),
        eb('extended_until', '<', now),
      ]));
  }
  return q.orderBy('received_at', 'desc')
    .limit(Math.min(Math.max(1, filter.limit ?? 100), 500))
    .offset(Math.max(0, filter.offset ?? 0))
    .execute();
}

export async function getPrivacyCaseWithEvents(customerId: string, caseId: string, trx: DbExecutor) {
  const row = await trx.selectFrom('privacy_cases').selectAll()
    .where('customer_id', '=', customerId).where('id', '=', caseId).executeTakeFirst();
  if (!row) return null;
  const events = await trx.selectFrom('privacy_case_events')
    .select(['event', 'detail', 'actor', 'created_at'])
    .where('customer_id', '=', customerId).where('case_id', '=', caseId)
    .orderBy('created_at', 'asc').execute();
  return { ...row, events };
}
