import type { Transaction } from 'kysely';
import { db } from './db.js';
import type { Database } from './schema.js';

export type RegulatedWorkloadMode = 'hipaa' | 'ferpa' | 'sec_finra';
export type RegulatedWorkloadStatus = 'disabled' | 'pending' | 'active' | 'rejected' | 'suspended';

export const REGULATED_MODES: RegulatedWorkloadMode[] = ['hipaa', 'ferpa', 'sec_finra'];

export const REQUIRED_PREREQUISITES: Record<RegulatedWorkloadMode, readonly string[]> = {
  hipaa: [
    'applicability_approved', 'customer_agreement_signed', 'subprocessor_agreements_verified',
    'risk_analysis_approved', 'secure_delivery_validated', 'encryption_validated',
    'incident_drill_passed', 'restore_drill_passed', 'independent_assessment_approved',
  ],
  ferpa: [
    'applicability_approved', 'customer_agreement_signed', 'direct_control_terms_approved',
    'education_data_flow_approved', 'rights_workflow_validated', 'redisclosure_controls_validated',
    'incident_drill_passed', 'independent_assessment_approved',
  ],
  sec_finra: [
    'applicability_approved', 'customer_agreement_signed', 'record_classes_approved',
    'archive_provider_approved', 'immutable_retention_validated', 'capture_reconciliation_validated',
    'supervisory_workflow_validated', 'production_drill_passed', 'independent_assessment_approved',
  ],
};

export class RegulatedWorkloadError extends Error {
  constructor(public readonly code: 'not_found' | 'invalid_state' | 'prerequisites_incomplete', message: string) {
    super(message);
  }
}

type Executor = Transaction<Database> | typeof db;

export function missingPrerequisites(mode: RegulatedWorkloadMode, values: Record<string, boolean>): string[] {
  return REQUIRED_PREREQUISITES[mode].filter((key) => values[key] !== true);
}

export async function submitPrerequisiteEvidence(input: {
  customerId: string; mode: RegulatedWorkloadMode; prerequisite: string;
  artifactUri: string; artifactSha256: string; submittedBy: string; expiresAt?: Date | null;
}) {
  if (!REQUIRED_PREREQUISITES[input.mode].includes(input.prerequisite)) {
    throw new RegulatedWorkloadError('invalid_state', 'Unknown prerequisite for this mode');
  }
  let artifactUrl: URL;
  try {
    artifactUrl = new URL(input.artifactUri);
  } catch {
    throw new RegulatedWorkloadError('invalid_state', 'Evidence artifact URI is invalid');
  }
  if (artifactUrl.protocol !== 'https:' || !/^[a-f0-9]{64}$/.test(input.artifactSha256)) {
    throw new RegulatedWorkloadError('invalid_state', 'Evidence requires an HTTPS artifact URI and lowercase SHA-256');
  }
  if (input.expiresAt && input.expiresAt <= new Date()) {
    throw new RegulatedWorkloadError('invalid_state', 'Evidence expiry must be in the future');
  }
  return db.insertInto('regulated_prerequisite_evidence').values({
    customer_id: input.customerId, mode: input.mode, prerequisite: input.prerequisite,
    artifact_uri: input.artifactUri, artifact_sha256: input.artifactSha256,
    submitted_by: input.submittedBy, expires_at: input.expiresAt ?? null,
  }).onConflict((oc) => oc.columns(['customer_id', 'mode', 'prerequisite']).doUpdateSet({
    artifact_uri: input.artifactUri, artifact_sha256: input.artifactSha256,
    submitted_by: input.submittedBy, submitted_at: new Date(), expires_at: input.expiresAt ?? null,
    status: 'submitted', reviewed_by: null, reviewed_at: null, review_note: null, updated_at: new Date(),
  })).returningAll().executeTakeFirstOrThrow();
}

export async function reviewPrerequisiteEvidence(input: {
  id: string; decision: 'approved' | 'rejected'; reviewedBy: string; note?: string;
}) {
  const row = await db.selectFrom('regulated_prerequisite_evidence').selectAll().where('id', '=', input.id).executeTakeFirst();
  if (!row) throw new RegulatedWorkloadError('not_found', 'Prerequisite evidence not found');
  if (row.submitted_by.toLowerCase() === input.reviewedBy.toLowerCase()) {
    throw new RegulatedWorkloadError('invalid_state', 'The evidence submitter cannot approve their own evidence');
  }
  if (input.decision === 'rejected' && !input.note?.trim()) {
    throw new RegulatedWorkloadError('invalid_state', 'Rejected evidence requires a review note');
  }
  return db.updateTable('regulated_prerequisite_evidence').set({
    status: input.decision, reviewed_by: input.reviewedBy, reviewed_at: new Date(),
    review_note: input.note?.trim() || null, updated_at: new Date(),
  }).where('id', '=', input.id).returningAll().executeTakeFirstOrThrow();
}

export async function approvedPrerequisiteMap(customerId: string, mode: RegulatedWorkloadMode): Promise<Record<string, boolean>> {
  const rows = await db.selectFrom('regulated_prerequisite_evidence').select('prerequisite')
    .where('customer_id', '=', customerId).where('mode', '=', mode).where('status', '=', 'approved')
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date())])).execute();
  return Object.fromEntries(rows.map((row) => [row.prerequisite, true]));
}

export async function listTenantWorkloadPosture(customerId: string, executor: Executor = db) {
  const rows = await executor.selectFrom('regulated_workload_posture')
    .selectAll().where('customer_id', '=', customerId).execute();
  const byMode = new Map(rows.map((row) => [row.mode, row]));
  return REGULATED_MODES.map((mode) => byMode.get(mode) ?? {
    customer_id: customerId,
    mode,
    status: 'disabled' as const,
    prerequisites: {},
    requested_at: null,
    requested_by: null,
    reviewed_at: null,
    reviewed_by: null,
    review_note: null,
    activated_at: null,
    suspended_at: null,
    updated_at: new Date(0),
  });
}

export async function requestRegulatedWorkload(
  customerId: string,
  mode: RegulatedWorkloadMode,
  requestedBy: string,
  executor: Executor = db,
) {
  const current = await executor.selectFrom('regulated_workload_posture')
    .select(['status']).where('customer_id', '=', customerId).where('mode', '=', mode).executeTakeFirst();
  if (current?.status === 'active' || current?.status === 'pending') {
    throw new RegulatedWorkloadError('invalid_state', `Workload mode is already ${current.status}`);
  }
  return executor.insertInto('regulated_workload_posture').values({
    customer_id: customerId, mode, status: 'pending', requested_at: new Date(),
    requested_by: requestedBy, prerequisites: {},
  }).onConflict((oc) => oc.columns(['customer_id', 'mode']).doUpdateSet({
    status: 'pending', requested_at: new Date(), requested_by: requestedBy,
    reviewed_at: null, reviewed_by: null, review_note: null, activated_at: null,
    suspended_at: null, prerequisites: {}, updated_at: new Date(),
  })).returningAll().executeTakeFirstOrThrow();
}

export async function reviewRegulatedWorkload(input: {
  customerId: string;
  mode: RegulatedWorkloadMode;
  decision: 'activate' | 'reject' | 'suspend';
  prerequisites?: Record<string, boolean>;
  reviewedBy: string;
  note?: string;
}, executor: Executor = db) {
  const row = await executor.selectFrom('regulated_workload_posture').selectAll()
    .where('customer_id', '=', input.customerId).where('mode', '=', input.mode).executeTakeFirst();
  if (!row) throw new RegulatedWorkloadError('not_found', 'Regulated workload request not found');
  const prerequisites = input.decision === 'activate'
    ? await approvedPrerequisiteMap(input.customerId, input.mode)
    : (row.prerequisites as Record<string, boolean>);
  if (input.decision === 'activate') {
    if (row.status !== 'pending' && row.status !== 'suspended') {
      throw new RegulatedWorkloadError('invalid_state', `Cannot activate from ${row.status}`);
    }
    const missing = missingPrerequisites(input.mode, prerequisites);
    if (missing.length) {
      throw new RegulatedWorkloadError('prerequisites_incomplete', `Missing prerequisites: ${missing.join(', ')}`);
    }
  }
  if (input.decision === 'suspend' && row.status !== 'active') {
    throw new RegulatedWorkloadError('invalid_state', `Cannot suspend from ${row.status}`);
  }
  if ((input.decision === 'reject' || input.decision === 'suspend') && !input.note?.trim()) {
    throw new RegulatedWorkloadError('invalid_state', 'A review note is required');
  }
  const status: RegulatedWorkloadStatus =
    input.decision === 'activate' ? 'active' : input.decision === 'reject' ? 'rejected' : 'suspended';
  return executor.updateTable('regulated_workload_posture').set({
    status, prerequisites, reviewed_at: new Date(), reviewed_by: input.reviewedBy,
    review_note: input.note?.trim() || null,
    activated_at: input.decision === 'activate' ? new Date() : row.activated_at,
    suspended_at: input.decision === 'suspend' ? new Date() : null,
    updated_at: new Date(),
  }).where('customer_id', '=', input.customerId).where('mode', '=', input.mode)
    .returningAll().executeTakeFirstOrThrow();
}

export async function regulatedModeIsActive(
  customerId: string,
  mode: RegulatedWorkloadMode,
  executor: Executor = db,
): Promise<boolean> {
  const row = await executor.selectFrom('regulated_workload_posture').select('status')
    .where('customer_id', '=', customerId).where('mode', '=', mode).executeTakeFirst();
  return row?.status === 'active';
}
