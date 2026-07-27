import crypto from 'node:crypto';
import { db } from './db.js';
import { regulatedModeIsActive } from './regulated-workloads.js';
import { encryptSecret } from './encryption.js';

export type RegulatedRightsMode = 'hipaa' | 'ferpa';
export type RegulatedCaseKind =
  | 'access' | 'amendment' | 'restriction' | 'confidential_communication'
  | 'disclosure_accounting' | 'breach_assessment' | 'hearing';
export type RegulatedCaseStatus =
  | 'open' | 'identity_verified' | 'in_review' | 'approved' | 'denied'
  | 'fulfilled' | 'hearing_requested' | 'closed';

function subjectPseudonym(customerId: string, subjectRef: string): string {
  const secret = process.env.PRIVACY_PSEUDONYM_SECRET ?? process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error('PRIVACY_PSEUDONYM_SECRET or ENCRYPTION_KEY is required');
  return crypto.createHmac('sha256', secret)
    .update(`regulated-subject:v1:${customerId}:${subjectRef.trim().toLowerCase()}`)
    .digest('base64url');
}

export class RegulatedRightsError extends Error {
  constructor(public readonly code: 'mode_inactive' | 'not_found' | 'invalid_transition', message: string) {
    super(message);
  }
}

const TRANSITIONS: Record<RegulatedCaseStatus, RegulatedCaseStatus[]> = {
  open: ['identity_verified', 'closed'],
  identity_verified: ['in_review', 'closed'],
  in_review: ['approved', 'denied', 'hearing_requested'],
  approved: ['fulfilled', 'closed'],
  denied: ['hearing_requested', 'closed'],
  fulfilled: ['closed'],
  hearing_requested: ['in_review', 'approved', 'denied', 'closed'],
  closed: [],
};

export async function createRegulatedRightsCase(input: {
  customerId: string; mode: RegulatedRightsMode; kind: RegulatedCaseKind;
  subjectRef: string; createdBy: string; deadlineDays?: number;
}) {
  if (!(await regulatedModeIsActive(input.customerId, input.mode))) {
    throw new RegulatedRightsError('mode_inactive', `${input.mode} mode is not active`);
  }
  const defaultDays = input.mode === 'hipaa' ? 30 : 45;
  return db.transaction().execute(async (trx) => {
    const row = await trx.insertInto('regulated_rights_cases').values({
      customer_id: input.customerId, mode: input.mode, kind: input.kind,
      subject_pseudonym: subjectPseudonym(input.customerId, input.subjectRef),
      deadline_at: new Date(Date.now() + (input.deadlineDays ?? defaultDays) * 86400_000),
      created_by: input.createdBy,
    }).returningAll().executeTakeFirstOrThrow();
    await trx.insertInto('regulated_rights_case_events').values({
      case_id: row.id, event: 'created', actor: input.createdBy,
      detail: { mode: input.mode, kind: input.kind },
    }).execute();
    return row;
  });
}

export async function transitionRegulatedRightsCase(input: {
  customerId: string; id: string; status: RegulatedCaseStatus; actor: string;
  reason?: string; assignedTo?: string;
}) {
  return db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom('regulated_rights_cases').selectAll()
      .where('id', '=', input.id).where('customer_id', '=', input.customerId).executeTakeFirst();
    if (!row) throw new RegulatedRightsError('not_found', 'Regulated rights case not found');
    if (!TRANSITIONS[row.status].includes(input.status)) {
      throw new RegulatedRightsError('invalid_transition', `${row.status} cannot transition to ${input.status}`);
    }
    if ((input.status === 'denied' || input.status === 'closed') && !input.reason?.trim()) {
      throw new RegulatedRightsError('invalid_transition', 'A reason is required');
    }
    const updated = await trx.updateTable('regulated_rights_cases').set({
      status: input.status, decision_reason: input.reason?.trim() || row.decision_reason,
      assigned_to: input.assignedTo ?? row.assigned_to,
      closed_at: input.status === 'closed' ? new Date() : null, updated_at: new Date(),
    }).where('id', '=', input.id).returningAll().executeTakeFirstOrThrow();
    await trx.insertInto('regulated_rights_case_events').values({
      case_id: row.id, event: `status:${input.status}`, actor: input.actor,
      detail: { reason_recorded: Boolean(input.reason), assigned: Boolean(input.assignedTo) },
    }).execute();
    return updated;
  });
}

export async function recordRegulatedDisclosure(input: {
  customerId: string; mode: RegulatedRightsMode; subjectRef: string;
  recipient: string; purpose: string; authority: string; recordedBy: string;
  redisclosureRestricted?: boolean;
}) {
  if (!(await regulatedModeIsActive(input.customerId, input.mode))) {
    throw new RegulatedRightsError('mode_inactive', `${input.mode} mode is not active`);
  }
  return db.insertInto('regulated_disclosures').values({
    customer_id: input.customerId, mode: input.mode,
    subject_pseudonym: subjectPseudonym(input.customerId, input.subjectRef),
    recipient: input.recipient, purpose: input.purpose, authority: input.authority,
    redisclosure_restricted: input.redisclosureRestricted ?? true, recorded_by: input.recordedBy,
  }).returningAll().executeTakeFirstOrThrow();
}

export async function recordHipaaBreachAssessment(input: {
  customerId: string; caseId: string; natureExtentRisk: 'low' | 'medium' | 'high';
  unauthorizedPersonRisk: 'low' | 'medium' | 'high'; acquiredOrViewed: boolean;
  mitigationCompleted: boolean; breachPresumed: boolean; analysis: string; assessedBy: string;
}) {
  const kase = await db.selectFrom('regulated_rights_cases').select(['mode', 'kind'])
    .where('id', '=', input.caseId).where('customer_id', '=', input.customerId).executeTakeFirst();
  if (!kase || kase.mode !== 'hipaa' || kase.kind !== 'breach_assessment') {
    throw new RegulatedRightsError('not_found', 'HIPAA breach-assessment case not found');
  }
  return db.insertInto('hipaa_breach_assessments').values({
    case_id: input.caseId, customer_id: input.customerId,
    nature_extent_risk: input.natureExtentRisk,
    unauthorized_person_risk: input.unauthorizedPersonRisk,
    acquired_or_viewed: input.acquiredOrViewed,
    mitigation_completed: input.mitigationCompleted,
    breach_presumed: input.breachPresumed,
    encrypted_analysis: encryptSecret(input.analysis),
    assessed_by: input.assessedBy,
  }).onConflict((oc) => oc.column('case_id').doUpdateSet({
    nature_extent_risk: input.natureExtentRisk,
    unauthorized_person_risk: input.unauthorizedPersonRisk,
    acquired_or_viewed: input.acquiredOrViewed,
    mitigation_completed: input.mitigationCompleted,
    breach_presumed: input.breachPresumed,
    encrypted_analysis: encryptSecret(input.analysis),
    assessed_by: input.assessedBy,
    assessed_at: new Date(),
  })).returning([
    'case_id', 'nature_extent_risk', 'unauthorized_person_risk', 'acquired_or_viewed',
    'mitigation_completed', 'breach_presumed', 'assessed_by', 'assessed_at',
  ]).executeTakeFirstOrThrow();
}

export async function recordFerpaAmendmentOutcome(input: {
  customerId: string; caseId: string; hearingOffered: boolean; hearingAt?: Date | null;
  outcome: 'amended' | 'denied' | 'pending_hearing'; statement?: string; recordedBy: string;
}) {
  const kase = await db.selectFrom('regulated_rights_cases').select(['mode', 'kind'])
    .where('id', '=', input.caseId).where('customer_id', '=', input.customerId).executeTakeFirst();
  if (!kase || kase.mode !== 'ferpa' || kase.kind !== 'amendment') {
    throw new RegulatedRightsError('not_found', 'FERPA amendment case not found');
  }
  if (input.outcome === 'denied' && !input.statement?.trim()) {
    throw new RegulatedRightsError('invalid_transition', 'A denied amendment requires the disputed-record statement');
  }
  return db.insertInto('ferpa_amendment_outcomes').values({
    case_id: input.caseId, customer_id: input.customerId,
    hearing_offered: input.hearingOffered, hearing_at: input.hearingAt ?? null,
    outcome: input.outcome,
    encrypted_statement: input.statement ? encryptSecret(input.statement) : null,
    recorded_by: input.recordedBy,
  }).onConflict((oc) => oc.column('case_id').doUpdateSet({
    hearing_offered: input.hearingOffered, hearing_at: input.hearingAt ?? null,
    outcome: input.outcome,
    encrypted_statement: input.statement ? encryptSecret(input.statement) : null,
    recorded_by: input.recordedBy, recorded_at: new Date(),
  })).returning([
    'case_id', 'hearing_offered', 'hearing_at', 'outcome', 'recorded_by', 'recorded_at',
  ]).executeTakeFirstOrThrow();
}
