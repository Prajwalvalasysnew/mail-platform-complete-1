import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  db,
  listTenantWorkloadPosture,
  requestRegulatedWorkload,
  RegulatedWorkloadError,
  createRegulatedRightsCase,
  transitionRegulatedRightsCase,
  recordRegulatedDisclosure,
  RegulatedRightsError,
  submitPrerequisiteEvidence,
  REQUIRED_PREREQUISITES,
  recordHipaaBreachAssessment,
  recordFerpaAmendmentOutcome,
} from '@platform/shared';
import { requireScope } from '../plugins/scope.js';

/**
 * Customer profile read/update.
 *
 * These handlers depend on `req.auth` (populated by the API-key auth plugin) via
 * requireScope('messages'). They were previously defined in customers.ts, which
 * is mounted OUTSIDE the auth scope (because it also hosts the public /signup
 * and /verify-email routes). The auth plugin therefore never ran for /profile,
 * so req.auth was undefined and every call 401'd — making it impossible for a
 * customer to set their CAN-SPAM physical_address, which in turn made every live
 * send fail with `physical_address_required`. Splitting them into their own
 * plugin lets server.ts register them inside the authenticated scope.
 */
export const profileRoutes: FastifyPluginAsync = async (app) => {
  app.get('/compliance/archive-records', { preHandler: requireScope('messages') }, async (req) => {
    const records = await db.selectFrom('regulated_archive_records')
      .select([
        'id', 'message_id', 'direction', 'provider', 'external_id', 'content_sha256',
        'archived_at', 'immutable_until', 'reconciliation_status', 'reconciled_at',
      ])
      .where('customer_id', '=', req.auth!.customer_id)
      .orderBy('archived_at', 'desc').limit(500).execute();
    return { records };
  });

  app.get('/compliance/rights-cases', { preHandler: requireScope('messages') }, async (req) => {
    const cases = await db.selectFrom('regulated_rights_cases').selectAll()
      .where('customer_id', '=', req.auth!.customer_id).orderBy('created_at', 'desc').limit(500).execute();
    return { cases };
  });

  app.post('/compliance/rights-cases', { preHandler: requireScope('messages') }, async (req, reply) => {
    const parsed = z.object({
      mode: z.enum(['hipaa', 'ferpa']),
      kind: z.enum(['access', 'amendment', 'restriction', 'confidential_communication', 'disclosure_accounting', 'breach_assessment', 'hearing']),
      subject_ref: z.string().min(1).max(500),
      deadline_days: z.number().int().min(1).max(365).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      const kase = await createRegulatedRightsCase({
        customerId: req.auth!.customer_id, mode: parsed.data.mode, kind: parsed.data.kind,
        subjectRef: parsed.data.subject_ref, createdBy: `api-key:${req.auth!.api_key_id}`,
        deadlineDays: parsed.data.deadline_days,
      });
      return reply.code(201).send({ case: kase });
    } catch (err) {
      if (err instanceof RegulatedRightsError) return reply.code(409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.post('/compliance/rights-cases/:id/transition', { preHandler: requireScope('messages') }, async (req, reply) => {
    const id = z.string().uuid().safeParse((req.params as { id?: string }).id);
    const body = z.object({
      status: z.enum(['identity_verified', 'in_review', 'approved', 'denied', 'fulfilled', 'hearing_requested', 'closed']),
      reason: z.string().max(4000).optional(),
      assigned_to: z.string().max(320).optional(),
    }).safeParse(req.body);
    if (!id.success || !body.success) return reply.code(400).send({ error: 'validation_failed' });
    try {
      const kase = await transitionRegulatedRightsCase({
        customerId: req.auth!.customer_id, id: id.data, status: body.data.status,
        actor: `api-key:${req.auth!.api_key_id}`, reason: body.data.reason, assignedTo: body.data.assigned_to,
      });
      return { case: kase };
    } catch (err) {
      if (err instanceof RegulatedRightsError) {
        return reply.code(err.code === 'not_found' ? 404 : 409).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  app.post('/compliance/disclosures', { preHandler: requireScope('messages') }, async (req, reply) => {
    const parsed = z.object({
      mode: z.enum(['hipaa', 'ferpa']), subject_ref: z.string().min(1).max(500),
      recipient: z.string().min(1).max(500), purpose: z.string().min(1).max(2000),
      authority: z.string().min(1).max(1000), redisclosure_restricted: z.boolean().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      const disclosure = await recordRegulatedDisclosure({
        customerId: req.auth!.customer_id, mode: parsed.data.mode, subjectRef: parsed.data.subject_ref,
        recipient: parsed.data.recipient, purpose: parsed.data.purpose, authority: parsed.data.authority,
        redisclosureRestricted: parsed.data.redisclosure_restricted,
        recordedBy: `api-key:${req.auth!.api_key_id}`,
      });
      return reply.code(201).send({ disclosure });
    } catch (err) {
      if (err instanceof RegulatedRightsError) return reply.code(409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.post('/compliance/rights-cases/:id/hipaa-breach-assessment', { preHandler: requireScope('messages') }, async (req, reply) => {
    const id = z.string().uuid().safeParse((req.params as { id?: string }).id);
    const body = z.object({
      nature_extent_risk: z.enum(['low', 'medium', 'high']),
      unauthorized_person_risk: z.enum(['low', 'medium', 'high']),
      acquired_or_viewed: z.boolean(), mitigation_completed: z.boolean(),
      breach_presumed: z.boolean(), analysis: z.string().min(1).max(20_000),
    }).safeParse(req.body);
    if (!id.success || !body.success) return reply.code(400).send({ error: 'validation_failed' });
    try {
      const assessment = await recordHipaaBreachAssessment({
        customerId: req.auth!.customer_id, caseId: id.data,
        natureExtentRisk: body.data.nature_extent_risk,
        unauthorizedPersonRisk: body.data.unauthorized_person_risk,
        acquiredOrViewed: body.data.acquired_or_viewed,
        mitigationCompleted: body.data.mitigation_completed,
        breachPresumed: body.data.breach_presumed, analysis: body.data.analysis,
        assessedBy: `api-key:${req.auth!.api_key_id}`,
      });
      return reply.code(201).send({ assessment });
    } catch (err) {
      if (err instanceof RegulatedRightsError) return reply.code(err.code === 'not_found' ? 404 : 409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.post('/compliance/rights-cases/:id/ferpa-amendment-outcome', { preHandler: requireScope('messages') }, async (req, reply) => {
    const id = z.string().uuid().safeParse((req.params as { id?: string }).id);
    const body = z.object({
      hearing_offered: z.boolean(), hearing_at: z.string().datetime().optional(),
      outcome: z.enum(['amended', 'denied', 'pending_hearing']),
      statement: z.string().max(20_000).optional(),
    }).safeParse(req.body);
    if (!id.success || !body.success) return reply.code(400).send({ error: 'validation_failed' });
    try {
      const outcome = await recordFerpaAmendmentOutcome({
        customerId: req.auth!.customer_id, caseId: id.data,
        hearingOffered: body.data.hearing_offered,
        hearingAt: body.data.hearing_at ? new Date(body.data.hearing_at) : null,
        outcome: body.data.outcome, statement: body.data.statement,
        recordedBy: `api-key:${req.auth!.api_key_id}`,
      });
      return reply.code(201).send({ outcome });
    } catch (err) {
      if (err instanceof RegulatedRightsError) return reply.code(err.code === 'not_found' ? 404 : 409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.get('/compliance/workloads', { preHandler: requireScope('messages') }, async (req) => {
    const modes = await listTenantWorkloadPosture(req.auth!.customer_id);
    return { modes };
  });

  app.get('/compliance/workload-evidence', { preHandler: requireScope('messages') }, async (req) => {
    const evidence = await db.selectFrom('regulated_prerequisite_evidence')
      .select([
        'id', 'mode', 'prerequisite', 'artifact_uri', 'artifact_sha256', 'status',
        'submitted_at', 'reviewed_at', 'reviewed_by', 'review_note', 'expires_at',
      ])
      .where('customer_id', '=', req.auth!.customer_id)
      .orderBy('submitted_at', 'desc').execute();
    return { evidence, required_prerequisites: REQUIRED_PREREQUISITES };
  });

  app.post('/compliance/workload-evidence', { preHandler: requireScope('messages') }, async (req, reply) => {
    if (req.auth!.tier !== 'enterprise') return reply.code(403).send({ error: 'enterprise_required' });
    const parsed = z.object({
      mode: z.enum(['hipaa', 'ferpa', 'sec_finra']),
      prerequisite: z.string().min(1).max(120),
      artifact_uri: z.string().url().max(2000).refine((value) => value.startsWith('https://'), 'HTTPS is required'),
      artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      expires_at: z.string().datetime().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    try {
      const evidence = await submitPrerequisiteEvidence({
        customerId: req.auth!.customer_id, mode: parsed.data.mode,
        prerequisite: parsed.data.prerequisite, artifactUri: parsed.data.artifact_uri,
        artifactSha256: parsed.data.artifact_sha256,
        submittedBy: `api-key:${req.auth!.api_key_id}`,
        expiresAt: parsed.data.expires_at ? new Date(parsed.data.expires_at) : null,
      });
      return reply.code(201).send({ evidence });
    } catch (err) {
      if (err instanceof RegulatedWorkloadError) return reply.code(422).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.post('/compliance/workloads/:mode/request', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.tier !== 'enterprise') {
      return reply.code(403).send({
        error: 'enterprise_required',
        message: 'Regulated workload activation is available only under an approved Enterprise agreement.',
      });
    }
    const parsed = z.enum(['hipaa', 'ferpa', 'sec_finra']).safeParse((req.params as { mode?: string }).mode);
    if (!parsed.success) return reply.code(404).send({ error: 'not_found' });
    try {
      const posture = await requestRegulatedWorkload(auth.customer_id, parsed.data, `api-key:${auth.api_key_id}`);
      return reply.code(202).send({ posture });
    } catch (err) {
      if (err instanceof RegulatedWorkloadError) {
        return reply.code(409).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // GET /v1/profile — returns the caller's customer record including physical_address.
  app.get('/profile', { preHandler: requireScope('messages') }, async (req) => {
    const auth = req.auth!;
    const customer = await db
      .selectFrom('customers')
      .select([
        'id', 'email', 'name', 'physical_address', 'tier', 'daily_quota',
        'monthly_quota', 'billing_status', 'status', 'kyc_level', 'tls_required', 'created_at',
      ])
      .where('id', '=', auth.customer_id)
      .executeTakeFirstOrThrow();
    return { customer };
  });

  // PATCH /v1/profile — update mutable customer settings.
  const UpdateProfileSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    physical_address: z.string().min(5).max(500).optional().nullable(),
    // Compliance posture: stamp every send with a require-TLS marker and
    // record per-delivery TLS evidence in the delivered event payload.
    tls_required: z.boolean().optional(),
  });
  app.patch('/profile', { preHandler: requireScope('messages') }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = UpdateProfileSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation_failed', details: parsed.error.flatten() });
    const updates: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if ('physical_address' in parsed.data) updates.physical_address = parsed.data.physical_address ?? null;
    if (parsed.data.tls_required !== undefined) updates.tls_required = parsed.data.tls_required;
    if (!Object.keys(updates).length) return reply.code(400).send({ error: 'no_fields_provided' });
    await db.updateTable('customers').set(updates as any).where('id', '=', auth.customer_id).execute();
    return { ok: true };
  });
};
